'use strict';

const { query, transaction } = require('../../config/database');
const ledger = require('../stock/stock.ledger');
const { resolveOrCreateItem } = require('../masterdata/items/items.service');
const { getLocationByCode } = require('../masterdata/locations/locations.service');
const { getInboundOrderByBarcode, getInboundOrderLines } = require('../inbound/inbound.service');
const { NotFoundError, ValidationError, ForbiddenError } = require('../../utils/errors');
const { validateBarcode, validateQty } = require('../../utils/validators');
const { getDefaultWarehouse } = require('../warehouses/warehouses.service');
const { triggerRedistributionForClient } = require('../wb/wb.service');
const logger = require('../../utils/logger');

// =============================================================================
// Receiving Service
// Два режима:
//  1. Свободная приёмка (free) — без заявки
//  2. Приёмка по заявке (inbound) — строгое соответствие
// =============================================================================

/**
 * Свободная приёмка — оприходовать товар напрямую
 */
async function acceptFree({ tenantId, warehouseId, clientId, barcode, locationCode, qty, unitCost, userId, comment }) {
  const b = validateBarcode(barcode);
  const q = validateQty(qty, 'qty');

  const receiveResult = await transaction(async (client) => {
    const itemId = await resolveOrCreateItem({ tenantId, clientId, barcode: b, dbClient: client });
    const loc = await getLocationByCode({ tenantId, warehouseId, locationCode });

    const result = await ledger.receiveStock({
      tenantId, warehouseId, clientId,
      barcode: b, locationId: loc.id, locationCode: loc.location_code,
      qty: q, refType: 'receiving', unitCost: unitCost||null,
      userId, comment: comment||null, dbClient: client,
    });

    // Запись в receiving_tasks для истории
    await client.query(
      `INSERT INTO wms.receiving_tasks
         (tenant_id,warehouse_id,client_id,item_id,barcode,location_id,location_code,
          qty_received,status,receiver_id,completed_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'completed',$9,NOW())`,
      [tenantId, warehouseId, clientId, itemId, b, loc.id, loc.location_code, q, userId]
    );

    logger.info({ tenantId, clientId, barcode: b, qty: q, locationCode }, 'Free receiving completed');
    return { ...result, itemId };
  });

  // Пересчитать и отправить в WB распределение остатков по складам клиента -
  // после приёмки итоговое количество на складе изменилось так, как WB сам
  // узнать не мог. Fire-and-forget (см. wb.service.js) - приёмщик не должен
  // ждать похода в WB API.
  triggerRedistributionForClient({ tenantId, clientId });

  return receiveResult;
}

/**
 * Приёмка по заявке (inbound order)
 * barcode — штрихкод заявки, scannedBarcode — штрихкод товара
 */
async function acceptByInbound({ tenantId, warehouseId, clientId, inboundOrderBarcode, scannedBarcode, locationCode, qty, userId }) {
  const inboundB = String(inboundOrderBarcode || '').trim();
  const itemB    = validateBarcode(scannedBarcode);
  const q        = validateQty(qty, 'qty');

  const receiveResult = await transaction(async (client) => {
    // 1. Находим заявку
    const order = await client.query(
      `SELECT * FROM wms.inbound_orders WHERE tenant_id=$1 AND barcode=$2 LIMIT 1 FOR UPDATE`,
      [tenantId, inboundB]
    );
    if (order.rowCount === 0) throw new NotFoundError(`Inbound order with barcode '${inboundB}'`);
    const ord = order.rows[0];

    // Проверяем статус
    if (!['confirmed','scheduled','in_progress'].includes(ord.status)) {
      throw new ValidationError(`Inbound order is in status '${ord.status}', cannot receive`);
    }
    // Проверяем доступ к клиенту
    if (ord.client_id !== clientId) throw new ForbiddenError('This order belongs to a different client');

    // 2. Находим строку заявки по штрихкоду товара
    const lineRes = await client.query(
      `SELECT * FROM wms.inbound_order_lines
       WHERE inbound_order_id=$1 AND barcode=$2 LIMIT 1 FOR UPDATE`,
      [ord.id, itemB]
    );
    if (lineRes.rowCount === 0) {
      throw new ValidationError(`Barcode '${itemB}' is not in this inbound order`);
    }
    const line = lineRes.rows[0];

    // Проверяем не превышено ли ожидаемое количество (допускаем +10% или строго)
    const maxAllowed = line.qty_expected; // строгий режим — без превышения
    if (line.qty_received + q > maxAllowed) {
      throw new ValidationError(
        `Excess receiving: expected=${maxAllowed}, already_received=${line.qty_received}, adding=${q}, ` +
        `would_be=${line.qty_received + q}`
      );
    }

    // 3. Резолвим товар и ячейку
    const itemId = await resolveOrCreateItem({ tenantId, clientId, barcode: itemB, dbClient: client });
    const loc = await getLocationByCode({ tenantId, warehouseId: ord.warehouse_id, locationCode });

    // 4. Оприходуем
    await ledger.receiveStock({
      tenantId, warehouseId: ord.warehouse_id, clientId,
      barcode: itemB, locationId: loc.id, locationCode: loc.location_code,
      qty: q, refType: 'inbound', refId: ord.id,
      userId, dbClient: client,
    });

    // 5. Обновляем строку заявки
    const newQtyReceived = line.qty_received + q;
    const newLineStatus = newQtyReceived >= line.qty_expected ? 'received' : 'partial';
    await client.query(
      `UPDATE wms.inbound_order_lines
       SET qty_received=$1, status=$2, updated_at=NOW() WHERE id=$3`,
      [newQtyReceived, newLineStatus, line.id]
    );

    // 6. Обновляем шапку заявки
    const totalRecRes = await client.query(
      `SELECT SUM(qty_received)::int AS total FROM wms.inbound_order_lines WHERE inbound_order_id=$1`,
      [ord.id]
    );
    const totalReceived = totalRecRes.rows[0].total || 0;

    // Определяем новый статус заявки
    const allLinesRes = await client.query(
      `SELECT status FROM wms.inbound_order_lines WHERE inbound_order_id=$1`,
      [ord.id]
    );
    const allDone = allLinesRes.rows.every(r => r.status === 'received');
    const anyProgress = allLinesRes.rows.some(r => ['received','partial'].includes(r.status));
    const orderStatus = allDone ? 'completed' : anyProgress ? 'in_progress' : ord.status;

    await client.query(
      `UPDATE wms.inbound_orders
       SET total_received_qty=$1, status=$2,
           completed_at=CASE WHEN $2='completed' THEN NOW() ELSE NULL END,
           updated_at=NOW()
       WHERE id=$3`,
      [totalReceived, orderStatus, ord.id]
    );

    // 7. Запись в receiving_tasks
    await client.query(
      `INSERT INTO wms.receiving_tasks
         (tenant_id,warehouse_id,client_id,inbound_order_id,item_id,barcode,
          location_id,location_code,qty_expected,qty_received,status,receiver_id,completed_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'completed',$11,NOW())`,
      [tenantId, ord.warehouse_id, clientId, ord.id, itemId, itemB,
       loc.id, loc.location_code, line.qty_expected, q, userId]
    );

    logger.info({ tenantId, clientId, orderId: ord.id, barcode: itemB, qty: q }, 'Inbound receiving completed');

    return {
      orderId:    ord.id,
      orderNumber: ord.order_number,
      orderStatus,
      barcode:    itemB,
      qty,
      locationCode: loc.location_code,
      line: { ...line, qty_received: newQtyReceived, status: newLineStatus },
    };
  });

  triggerRedistributionForClient({ tenantId, clientId });

  return receiveResult;
}

/**
 * История приёмок
 */
async function listReceivingHistory({ tenantId, clientId = null, dateFrom = null, dateTo = null, limit = 200, offset = 0 }) {
  const params = [tenantId]; const conds = ['rt.tenant_id=$1']; let idx = 2;
  if (clientId) { conds.push(`rt.client_id=$${idx++}`); params.push(clientId); }
  if (dateFrom) { conds.push(`rt.completed_at>=$${idx++}::date`); params.push(dateFrom); }
  if (dateTo)   { conds.push(`rt.completed_at<($${idx++}::date+interval '1 day')`); params.push(dateTo); }
  params.push(Math.min(limit,1000), Math.max(offset,0));
  const r = await query(
    `SELECT rt.*, i.item_name, c.client_name, l.location_code AS loc_code, u.username AS receiver_name
     FROM wms.receiving_tasks rt
     LEFT JOIN wms.items i ON i.id=rt.item_id
     LEFT JOIN wms.clients c ON c.id=rt.client_id
     LEFT JOIN wms.locations l ON l.id=rt.location_id
     LEFT JOIN wms.users u ON u.id=rt.receiver_id
     WHERE ${conds.join(' AND ')} ORDER BY rt.completed_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params
  );
  return r.rows;
}

module.exports = { acceptFree, acceptByInbound, listReceivingHistory };
