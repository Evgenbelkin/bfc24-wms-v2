'use strict';

const { query, transaction } = require('../../config/database');
const ledger = require('../stock/stock.ledger');
const { resolveOrCreateItem } = require('../masterdata/items/items.service');
const { getLocationByCode } = require('../masterdata/locations/locations.service');
const { validateBarcode, validateQty } = require('../../utils/validators');
const { ValidationError } = require('../../utils/errors');
const { chargeForOperation } = require('../billing/billing.service');
const { triggerRedistributionForClient } = require('../wb/wb.service');
const logger = require('../../utils/logger');

// =============================================================================
// Returns Service — возвраты товара с ПВЗ маркетплейсов
//
// Процесс (со слов клиента): товар возвращается на ПВЗ, фулфилмент забирает
// его и везёт на склад, там проверяют/переупаковывают и СРАЗУ (в один шаг)
// решают: обратно в продажу (resale — возвращается в остатки) или в утиль
// (writeoff — списание, в остатки не идёт).
// =============================================================================

const DISPOSITIONS = ['resale', 'writeoff'];

/**
 * Зарегистрировать возврат — единственная точка входа (один шаг, без
 * промежуточного статуса "принято, но не разобрано").
 */
async function registerReturn({
  tenantId, warehouseId, clientId, barcode, qty, disposition,
  marketplaceOrderNo = null, locationCode = null, comment = null, userId,
}) {
  const b = validateBarcode(barcode);
  const q = validateQty(qty, 'qty');
  if (!DISPOSITIONS.includes(disposition)) {
    throw new ValidationError(`disposition must be one of: ${DISPOSITIONS.join(', ')}`);
  }
  if (disposition === 'resale' && !locationCode) {
    throw new ValidationError('locationCode is required when disposition=resale (куда положить товар)');
  }

  const result = await transaction(async (client) => {
    const itemId = await resolveOrCreateItem({ tenantId, clientId, barcode: b, dbClient: client });

    let locationId = null;
    let locCode = null;
    if (disposition === 'resale') {
      const loc = await getLocationByCode({ tenantId, warehouseId, locationCode });
      locationId = loc.id;
      locCode = loc.location_code;

      // Возвращаем товар в остатки — тот же ledger, что и обычная приёмка,
      // только movement_type='return' (уже зарезервированное значение enum),
      // чтобы отличать возвраты от обычной приёмки в истории движений.
      await ledger.receiveStock({
        tenantId, warehouseId, clientId,
        barcode: b, locationId, locationCode: locCode,
        qty: q, refType: 'return', movementType: 'return',
        userId, comment: comment || null, dbClient: client,
      });
    }
    // disposition === 'writeoff' — остатки не трогаем: товар физически не
    // возвращается на продажу, это только факт для отчётности.

    const r = await client.query(
      `INSERT INTO wms.returns
         (tenant_id, warehouse_id, client_id, item_id, barcode, qty, disposition,
          marketplace_order_no, location_id, location_code, received_by, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [tenantId, warehouseId, clientId, itemId, b, q, disposition,
       marketplaceOrderNo || null, locationId, locCode, userId, comment || null]
    );
    return r.rows[0];
  });

  // Возврат "в продажу" кладёт товар в ячейку и сразу увеличивает остаток -
  // если это ячейка отбора (а это обычный случай для resale), доступное для
  // WB количество выросло, но WB об этом не узнает сам. Без этого триггера
  // возвращённый товар не продавался бы на WB до случайного нового заказа по
  // нему же или планового пересчёта раз в 8ч (см. тот же фикс в
  // placement.service.js / movement.service.js).
  if (disposition === 'resale') {
    logger.info({ tenantId, clientId, barcode: b }, 'Return (resale) triggered WB redistribution');
    triggerRedistributionForClient({ tenantId, clientId, barcodes: [b] });
  }

  // Начисление клиенту за обработку возврата (silent no-op, если прайс на
  // service_type='returns' не настроен — см. billing.service.js:chargeForOperation).
  // Начисляем за ЛЮБОЙ возврат (и resale, и writeoff) — работу склад проделал
  // в обоих случаях одинаковую (приёмка, проверка, сортировка).
  const chargeId = await chargeForOperation({
    tenantId, clientId, serviceType: 'returns', quantity: q,
    refType: 'return', refId: result.id,
  });
  if (chargeId) {
    await query(`UPDATE wms.returns SET charge_id=$1 WHERE id=$2`, [chargeId, result.id]);
    result.charge_id = chargeId;
  }

  logger.info({ tenantId, clientId, barcode: b, qty: q, disposition }, 'Return registered');
  return result;
}

/** История возвратов с фильтрами */
async function listReturns({ tenantId, clientId = null, disposition = null, dateFrom = null, dateTo = null, limit = 200, offset = 0 }) {
  const params = [tenantId]; const conds = ['r.tenant_id=$1']; let idx = 2;
  if (clientId)    { conds.push(`r.client_id=$${idx++}`); params.push(clientId); }
  if (disposition) { conds.push(`r.disposition=$${idx++}`); params.push(disposition); }
  if (dateFrom)    { conds.push(`r.created_at>=$${idx++}::date`); params.push(dateFrom); }
  if (dateTo)      { conds.push(`r.created_at<($${idx++}::date+interval '1 day')`); params.push(dateTo); }

  const countRes = await query(`SELECT COUNT(*)::int AS total FROM wms.returns r WHERE ${conds.join(' AND ')}`, params);
  const total = countRes.rows[0].total;

  // См. тот же фикс в receiving.service.js:listReceivingHistory — потолок в
  // 1000 обрезал историю без пагинации на клиентском экране, из-за чего
  // старые возвраты выглядели пропавшими. Поднимаем запас с большим кол-вом.
  params.push(Math.min(limit, 50000), Math.max(offset, 0));
  const res = await query(
    `SELECT r.id, r.barcode, r.qty, r.disposition, r.marketplace_order_no,
            r.location_code, r.comment, r.created_at,
            i.item_name, i.vendor_code, i.size, c.client_name, u.username AS received_by_name
     FROM wms.returns r
     LEFT JOIN wms.items i ON i.id=r.item_id
     LEFT JOIN wms.clients c ON c.id=r.client_id
     LEFT JOIN wms.users u ON u.id=r.received_by
     WHERE ${conds.join(' AND ')}
     ORDER BY r.created_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params
  );
  return { returns: res.rows, total, limit, offset };
}

/** Сводка (счётчики) — общая или по конкретному клиенту */
async function getReturnsSummary({ tenantId, clientId = null, dateFrom = null, dateTo = null }) {
  const params = [tenantId]; const conds = ['tenant_id=$1']; let idx = 2;
  if (clientId) { conds.push(`client_id=$${idx++}`); params.push(clientId); }
  if (dateFrom) { conds.push(`created_at>=$${idx++}::date`); params.push(dateFrom); }
  if (dateTo)   { conds.push(`created_at<($${idx++}::date+interval '1 day')`); params.push(dateTo); }
  const res = await query(
    `SELECT
       COUNT(*)::int AS total_returns,
       COALESCE(SUM(qty),0)::numeric AS total_qty,
       COUNT(*) FILTER (WHERE disposition='resale')::int   AS resale_count,
       COALESCE(SUM(qty) FILTER (WHERE disposition='resale'),0)::numeric AS resale_qty,
       COUNT(*) FILTER (WHERE disposition='writeoff')::int AS writeoff_count,
       COALESCE(SUM(qty) FILTER (WHERE disposition='writeoff'),0)::numeric AS writeoff_qty
     FROM wms.returns WHERE ${conds.join(' AND ')}`,
    params
  );
  return res.rows[0];
}

/** Разбивка по клиентам — для админки ("возвраты по клиенту") */
async function getReturnsByClient({ tenantId, dateFrom = null, dateTo = null }) {
  const params = [tenantId]; const conds = ['r.tenant_id=$1']; let idx = 2;
  if (dateFrom) { conds.push(`r.created_at>=$${idx++}::date`); params.push(dateFrom); }
  if (dateTo)   { conds.push(`r.created_at<($${idx++}::date+interval '1 day')`); params.push(dateTo); }
  const res = await query(
    `SELECT c.id AS client_id, c.client_name,
       COUNT(*)::int AS total_returns,
       COALESCE(SUM(r.qty),0)::numeric AS total_qty,
       COUNT(*) FILTER (WHERE r.disposition='resale')::int   AS resale_count,
       COUNT(*) FILTER (WHERE r.disposition='writeoff')::int AS writeoff_count
     FROM wms.returns r
     JOIN wms.clients c ON c.id = r.client_id
     WHERE ${conds.join(' AND ')}
     GROUP BY c.id, c.client_name
     ORDER BY total_returns DESC`,
    params
  );
  return res.rows;
}

module.exports = { registerReturn, listReturns, getReturnsSummary, getReturnsByClient };
