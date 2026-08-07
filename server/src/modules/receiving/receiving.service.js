'use strict';

const { query, transaction } = require('../../config/database');
const ledger = require('../stock/stock.ledger');
const { resolveOrCreateItem, resolveExistingItem } = require('../masterdata/items/items.service');
const { getLocationByCode } = require('../masterdata/locations/locations.service');
const { getInboundOrderByBarcode, getInboundOrderLines } = require('../inbound/inbound.service');
const { NotFoundError, ValidationError, ForbiddenError } = require('../../utils/errors');
const { validateBarcode, validateQty } = require('../../utils/validators');
const { getDefaultWarehouse } = require('../warehouses/warehouses.service');
const { triggerRedistributionForClient } = require('../wb/wb.service');
const { chargeForOperation } = require('../billing/billing.service');
const marking = require('../marking/marking.service');
const { generateItemLabelSvg } = require('../../utils/qrcode');
const { resolvePrinter } = require('../printing/printerResolver');
const logger = require('../../utils/logger');

/**
 * Если у товара включена маркировка "Честный знак" с триггером 'receiving' —
 * (1) аллоцировать и напечатать по одному коду ЧЗ на каждую принятую единицу,
 * (2) напечатать столько же обычных штрихкодовых стикеров товара (item_barcode)
 * — той же операцией, чтобы у приёмщика сразу были ОБА стикера на руках.
 *
 * ВЫЗЫВАЕТСЯ ВНУТРИ ТРАНЗАКЦИИ ПРИЁМКИ (client=dbClient, БЕЗ try/catch вокруг
 * marking.allocateAndPrint) — явное решение пользователя: если в пуле не
 * хватает кодов или не настроен принтер под marking_code, вся приёмка должна
 * откатиться целиком, а не тихо пройти без стикера ЧЗ. Печать обычного
 * item_barcode стикера ниже — отдельная забота, не связанная с дефицитом
 * кодов ЧЗ, поэтому она остаётся soft-fail (как и раньше у WB-стикера).
 */
async function handleMarkingAtReceiving(client, { tenantId, clientId, itemId, barcode, qty, refType, refId, userId, dataMatrixCodes = null }) {
  const itemRes = await client.query(
    `SELECT id, item_name, vendor_code, requires_marking, marking_trigger, marking_mode
     FROM wms.items WHERE id=$1 AND tenant_id=$2`,
    [itemId, tenantId]
  );
  if (itemRes.rowCount === 0) return;
  const item = itemRes.rows[0];
  if (!marking.shouldMarkAt(item, 'receiving')) return;

  if (item.marking_mode === 'scan') {
    // Товар промаркирован клиентом заранее — печатать код ЧЗ нечего,
    // регистрируем уже существующие на товаре коды DataMatrix в пул.
    // Жёсткий блок: по одному коду на каждую принимаемую единицу.
    // Обычный item_barcode стикер (ниже по функции) всё равно может
    // понадобиться складу для внутренних операций — не пропускаем его.
    const codes = Array.isArray(dataMatrixCodes) ? dataMatrixCodes.filter(Boolean) : [];
    if (codes.length !== qty) {
      throw new ValidationError(
        `Товар промаркирован клиентом (Честный знак) — нужно отсканировать ровно ${qty} код(ов) ` +
        `DataMatrix (по одному на каждую единицу), отсканировано: ${codes.length}.`
      );
    }
    await marking.registerScannedCodes({ tenantId, itemId, codes, userId, dbClient: client });
  } else {
    // Жёсткий блок: бросает ValidationError, если кодов не хватает или нет принтера.
    await marking.allocateAndPrint({
      tenantId, clientId, itemId, itemBarcode: barcode, itemName: item.item_name,
      qty, refType, refId, userId, employeeId: userId, dbClient: client,
    });
  }

  try {
    const resolved = await resolvePrinter(client.query.bind(client), { tenantId, docType: 'item_barcode', employeeId: userId, clientId });
    if (resolved) {
      const svg = generateItemLabelSvg(barcode, item.item_name, { vendorCode: item.vendor_code });
      const copies = Math.max(1, Math.round(Number(qty) || 1));
      for (let i = 0; i < copies; i++) {
        const jobCode = `ITEMLBL-${itemId}-${Date.now()}-${i}`;
        await client.query(
          `INSERT INTO wms.print_jobs
             (tenant_id,job_code,printer_id,route_id,doc_type,entity_type,entity_id,copies,payload_json,status,created_by)
           VALUES($1,$2,$3,$4,'item_barcode','item',$5,1,$6::jsonb,'new',$7)`,
          [tenantId, jobCode, resolved.printerId, resolved.routeId, itemId,
           JSON.stringify({ sticker: svg, barcode, item_name: item.item_name }), userId]
        );
      }
    }
  } catch (err) {
    logger.warn({ err, tenantId, itemId, barcode }, 'item_barcode print at receiving: soft-fail (не блокирует приёмку)');
  }
}

// =============================================================================
// Receiving Service
// Два режима:
//  1. Свободная приёмка (free) — без заявки
//  2. Приёмка по заявке (inbound) — строгое соответствие
// =============================================================================

/**
 * Свободная приёмка — оприходовать товар напрямую
 */
async function acceptFree({ tenantId, warehouseId, clientId, barcode, locationCode, qty, unitCost, userId, comment, dataMatrixCodes = null }) {
  const b = validateBarcode(barcode);
  const q = validateQty(qty, 'qty');

  const receiveResult = await transaction(async (client) => {
    // Свободная приёмка - товар должен быть заранее заведён в каталоге клиента
    // (см. resolveExistingItem) - раньше здесь стоял resolveOrCreateItem, который
    // тихо заводил новый товар на любой отсканированный штрихкод.
    const itemId = await resolveExistingItem({ tenantId, clientId, barcode: b, dbClient: client });
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

    // Маркировка "Честный знак" — ВНУТРИ транзакции, без try/catch (см.
    // handleMarkingAtReceiving) — нехватка кодов/принтера откатывает всю приёмку.
    await handleMarkingAtReceiving(client, {
      tenantId, clientId, itemId, barcode: b, qty: q,
      refType: 'receiving', refId: itemId, userId, dataMatrixCodes,
    });

    logger.info({ tenantId, clientId, barcode: b, qty: q, locationCode }, 'Free receiving completed');
    return { ...result, itemId };
  });

  // Пересчитать и отправить в WB распределение остатков по складам клиента -
  // после приёмки итоговое количество на складе изменилось так, как WB сам
  // узнать не мог. Fire-and-forget (см. wb.service.js) - приёмщик не должен
  // ждать похода в WB API.
  triggerRedistributionForClient({ tenantId, clientId });

  // Начисление клиенту за приёмку (silent no-op, если для клиента не настроен
  // прайс на 'receiving' — см. billing.service.js:chargeForOperation).
  chargeForOperation({ tenantId, clientId, serviceType: 'receiving', quantity: q, refType: 'receiving', refId: receiveResult.itemId });

  return receiveResult;
}

/**
 * Приёмка по заявке (inbound order)
 * barcode — штрихкод заявки, scannedBarcode — штрихкод товара
 */
async function acceptByInbound({ tenantId, warehouseId, clientId, inboundOrderBarcode, scannedBarcode, locationCode, qty, userId, dataMatrixCodes = null }) {
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

    // Маркировка "Честный знак" — ВНУТРИ транзакции, без try/catch (см.
    // handleMarkingAtReceiving) — нехватка кодов/принтера откатывает всю приёмку.
    await handleMarkingAtReceiving(client, {
      tenantId, clientId, itemId, barcode: itemB, qty: q,
      refType: 'inbound', refId: ord.id, userId, dataMatrixCodes,
    });

    logger.info({ tenantId, clientId, orderId: ord.id, barcode: itemB, qty: q }, 'Inbound receiving completed');

    return {
      orderId:    ord.id,
      orderNumber: ord.order_number,
      orderStatus,
      itemId,
      barcode:    itemB,
      qty,
      locationCode: loc.location_code,
      line: { ...line, qty_received: newQtyReceived, status: newLineStatus },
    };
  });

  triggerRedistributionForClient({ tenantId, clientId });

  chargeForOperation({ tenantId, clientId, serviceType: 'receiving', quantity: q, refType: 'inbound', refId: receiveResult.orderId });

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
