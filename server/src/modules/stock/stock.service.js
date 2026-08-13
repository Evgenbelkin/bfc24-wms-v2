'use strict';

const { query } = require('../../config/database');
const { validateBarcode, validatePositiveInt } = require('../../utils/validators');

// =============================================================================
// Stock Service — запросы (read-only)
// Для изменений используй stock.ledger.js
// =============================================================================

/**
 * Остатки с фильтрами
 */
async function listStockBalances({
  tenantId, warehouseId = null, clientId = null,
  barcode = null, locationCode = null,
  onlyWithStock = true,
  limit = 500, offset = 0,
}) {
  const params = [tenantId];
  const conds = ['sb.tenant_id = $1'];
  let idx = 2;

  if (warehouseId)  { conds.push(`sb.warehouse_id = $${idx++}`); params.push(warehouseId); }
  if (clientId)     { conds.push(`sb.client_id = $${idx++}`); params.push(clientId); }
  if (barcode)      { conds.push(`sb.barcode = $${idx++}`); params.push(validateBarcode(barcode)); }
  if (locationCode) { conds.push(`l.location_code = $${idx++}`); params.push(locationCode); }
  if (onlyWithStock){ conds.push(`sb.qty_on_hand > 0`); }

  const countRes = await query(
    `SELECT COUNT(*)::int AS total FROM wms.stock_balances sb
     LEFT JOIN wms.locations l ON l.id = sb.location_id
     WHERE ${conds.join(' AND ')}`,
    params
  );
  const total = countRes.rows[0].total;

  // Агрегаты считаются по ВСЕЙ выборке (без учёта limit/offset страницы) —
  // иначе "итого" на экране было бы только по текущей странице и вводило бы
  // в заблуждение при пагинации. total_volume — сумма (остаток × объём товара
  // в литрах); нужно, чтобы понимать, сколько места реально занято на складе
  // (задел на будущее: сравнивать с объёмом ячеек и считать свободные места).
  // У товаров без указанного объёма (volume_liters IS NULL) вклад в сумму — 0,
  // а не придуманное число, поэтому total_volume — это "минимум, который точно
  // знаем", а не гарантированно полный объём склада.
  const sumRes = await query(
    `SELECT
       SUM(sb.qty_on_hand * COALESCE(i.cost_price, sb.avg_cost, 0))::numeric AS total_cost_value,
       SUM(sb.qty_on_hand)::numeric AS total_qty,
       SUM(sb.qty_on_hand * COALESCE(i.volume_liters, 0))::numeric AS total_volume,
       COUNT(*) FILTER (WHERE i.volume_liters IS NULL)::int AS items_without_volume
     FROM wms.stock_balances sb
     LEFT JOIN wms.locations l ON l.id = sb.location_id
     LEFT JOIN wms.items i ON i.id = sb.item_id
     WHERE ${conds.join(' AND ')}`,
    params.slice(0, idx - 1)
  );
  const totalCostValue = Number(sumRes.rows[0].total_cost_value || 0);
  const totalQty = Number(sumRes.rows[0].total_qty || 0);
  const totalVolume = Number(sumRes.rows[0].total_volume || 0);
  const itemsWithoutVolume = Number(sumRes.rows[0].items_without_volume || 0);

  params.push(Math.min(limit, 2000), Math.max(offset, 0));
  const res = await query(
    `SELECT
       sb.id, sb.client_id, sb.item_id, sb.barcode,
       sb.qty_on_hand, sb.qty_reserved, sb.qty_available,
       sb.avg_cost, sb.last_movement_at, i.cost_price,
       (sb.qty_on_hand * COALESCE(i.cost_price, sb.avg_cost, 0))::numeric AS cost_value,
       l.id AS location_id, l.location_code, l.zone_code, l.location_type,
       w.id AS warehouse_id, w.warehouse_name,
       i.item_name, i.vendor_code, i.unit, i.volume_liters, i.needs_packaging,
       c.client_name
     FROM wms.stock_balances sb
     JOIN wms.locations l ON l.id = sb.location_id
     JOIN wms.warehouses w ON w.id = sb.warehouse_id
     LEFT JOIN wms.items i ON i.id = sb.item_id
     LEFT JOIN wms.clients c ON c.id = sb.client_id
     WHERE ${conds.join(' AND ')}
     ORDER BY c.client_name, i.item_name, l.location_code
     LIMIT $${idx++} OFFSET $${idx}`,
    params
  );
  return { stock: res.rows, total, totalCostValue, totalQty, totalVolume, itemsWithoutVolume, limit, offset };
}

/**
 * Остатки по штрихкоду (все ячейки)
 */
async function getStockByBarcode({ tenantId, clientId, barcode, warehouseId = null }) {
  const b = validateBarcode(barcode);
  const params = [tenantId, b];
  const conds = [`sb.tenant_id = $1`, `sb.barcode = $2`, `sb.qty_on_hand > 0`];
  let idx = 3;

  if (clientId)    { conds.push(`sb.client_id = $${idx++}`); params.push(clientId); }
  if (warehouseId) { conds.push(`sb.warehouse_id = $${idx++}`); params.push(warehouseId); }

  const res = await query(
    `SELECT
       sb.barcode, sb.qty_on_hand, sb.qty_reserved, sb.qty_available,
       l.id AS location_id, l.location_code, l.zone_code,
       w.warehouse_name,
       i.item_name, i.vendor_code, i.unit
     FROM wms.stock_balances sb
     JOIN wms.locations l ON l.id = sb.location_id
     JOIN wms.warehouses w ON w.id = sb.warehouse_id
     LEFT JOIN wms.items i ON i.id = sb.item_id
     WHERE ${conds.join(' AND ')}
     ORDER BY sb.qty_available DESC, l.location_code`,
    params
  );
  return res.rows;
}

/**
 * Остатки по ячейке
 */
async function getStockByLocation({ tenantId, locationCode, warehouseId = null }) {
  const params = [tenantId, locationCode];
  const conds = [`sb.tenant_id = $1`, `l.location_code = $2`];
  let idx = 3;
  if (warehouseId) { conds.push(`sb.warehouse_id = $${idx++}`); params.push(warehouseId); }

  const res = await query(
    `SELECT
       sb.barcode, sb.client_id, sb.qty_on_hand, sb.qty_reserved, sb.qty_available,
       l.location_code, l.zone_code,
       i.item_name, i.vendor_code, i.unit,
       c.client_name
     FROM wms.stock_balances sb
     JOIN wms.locations l ON l.id = sb.location_id
     LEFT JOIN wms.items i ON i.id = sb.item_id
     LEFT JOIN wms.clients c ON c.id = sb.client_id
     WHERE ${conds.join(' AND ')} AND sb.qty_on_hand > 0
     ORDER BY c.client_name, i.item_name`,
    params
  );
  return res.rows;
}

/**
 * Сводка по клиенту (total на руках)
 */
async function getClientStockSummary({ tenantId, clientId }) {
  const res = await query(
    `SELECT
       sb.barcode,
       SUM(sb.qty_on_hand)::int    AS total_on_hand,
       SUM(sb.qty_reserved)::int   AS total_reserved,
       SUM(sb.qty_available)::int  AS total_available,
       i.id AS item_id, i.item_name, i.vendor_code, i.unit, i.cost_price, i.size,
       (SUM(sb.qty_on_hand) * COALESCE(i.cost_price,0))::numeric AS total_cost_value
     FROM wms.stock_balances sb
     LEFT JOIN wms.items i ON i.id = sb.item_id
     WHERE sb.tenant_id = $1 AND sb.client_id = $2 AND sb.qty_on_hand > 0
     GROUP BY sb.barcode, i.id, i.item_name, i.vendor_code, i.unit, i.cost_price, i.size
     ORDER BY i.item_name, sb.barcode`,
    [tenantId, clientId]
  );
  return res.rows;
}

/**
 * История движений
 */
async function listMovements({
  tenantId, clientId = null, barcode = null,
  locationCode = null, movementType = null,
  refType = null, refId = null,
  userId = null, dateFrom = null, dateTo = null,
  limit = 500, offset = 0,
}) {
  const params = [tenantId];
  const conds = ['m.tenant_id = $1'];
  let idx = 2;

  if (clientId)      { conds.push(`m.client_id = $${idx++}`); params.push(clientId); }
  if (barcode)       { conds.push(`m.barcode = $${idx++}`); params.push(validateBarcode(barcode)); }
  if (movementType)  { conds.push(`m.movement_type = $${idx++}`); params.push(movementType); }
  if (refType)       { conds.push(`m.ref_type = $${idx++}`); params.push(refType); }
  if (refId)         { conds.push(`m.ref_id = $${idx++}`); params.push(Number(refId)); }
  if (userId)        { conds.push(`m.user_id = $${idx++}`); params.push(Number(userId)); }
  if (locationCode) {
    conds.push(`(m.from_location_code = $${idx} OR m.to_location_code = $${idx})`);
    params.push(locationCode); idx++;
  }
  if (dateFrom)      { conds.push(`m.created_at >= $${idx++}::date`); params.push(dateFrom); }
  if (dateTo)        { conds.push(`m.created_at < ($${idx++}::date + interval '1 day')`); params.push(dateTo); }

  params.push(Math.min(limit, 5000), Math.max(offset, 0));
  const res = await query(
    `SELECT
       m.id, m.movement_type, m.qty,
       m.barcode, m.from_location_code, m.to_location_code,
       m.ref_type, m.ref_id, m.comment, m.created_at,
       m.user_id, u.username,
       i.item_name, c.client_name
     FROM wms.stock_movements m
     LEFT JOIN wms.users u ON u.id = m.user_id
     LEFT JOIN wms.items i ON i.id = m.item_id
     LEFT JOIN wms.clients c ON c.id = m.client_id
     WHERE ${conds.join(' AND ')}
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params
  );
  return res.rows;
}

module.exports = {
  listStockBalances, getStockByBarcode, getStockByLocation,
  getClientStockSummary, listMovements,
};
