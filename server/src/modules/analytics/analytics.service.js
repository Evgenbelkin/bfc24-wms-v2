'use strict';

const { query } = require('../../config/database');

// =============================================================================
// Analytics Service
//
// Аналитика WMS: товарооборот, остатки, операционные KPI.
//
// Все запросы — read-only, без транзакций.
//
// API:
//   getStockSnapshot       — срез остатков на текущий момент
//   getTurnoverReport      — оборачиваемость по barcode за период
//   getReceivingStats      — статистика приёмки
//   getPickingStats        — статистика сборки
//   getShippingStats       — статистика отгрузки
//   getOperatorStats       — KPI по операторам
//   getClientReport        — сводный отчёт по клиенту
//   getMovementTimeline    — временная шкала движений
// =============================================================================

/**
 * Актуальный срез остатков (итог по клиенту/barcode)
 */
async function getStockSnapshot({
  tenantId,
  clientId    = null,
  warehouseId = null,
  onlyNonZero = true,
  limit  = 1000,
  offset = 0,
}) {
  const params = [tenantId];
  const conds  = ['sb.tenant_id=$1'];
  let idx = 2;

  if (clientId)    { conds.push(`sb.client_id=$${idx++}`);    params.push(clientId); }
  if (warehouseId) { conds.push(`sb.warehouse_id=$${idx++}`); params.push(warehouseId); }
  if (onlyNonZero) { conds.push('sb.qty_on_hand>0'); }

  const total = (await query(
    `SELECT COUNT(DISTINCT sb.barcode)::int AS n FROM wms.stock_balances sb WHERE ${conds.join(' AND ')}`,
    params
  )).rows[0].n;

  params.push(Math.min(limit, 5000), Math.max(offset, 0));
  const r = await query(
    `SELECT
       sb.barcode,
       i.item_name, i.vendor_code, i.unit,
       c.client_name,
       SUM(sb.qty_on_hand)::int    AS total_on_hand,
       SUM(sb.qty_reserved)::int   AS total_reserved,
       SUM(sb.qty_available)::int  AS total_available,
       SUM(sb.qty_on_hand * COALESCE(sb.avg_cost,0))::numeric AS total_cost_value,
       COUNT(DISTINCT sb.location_id)::int AS location_count,
       MAX(sb.last_movement_at) AS last_movement_at
     FROM wms.stock_balances sb
     LEFT JOIN wms.items i ON i.id=sb.item_id
     LEFT JOIN wms.clients c ON c.id=sb.client_id
     WHERE ${conds.join(' AND ')}
     GROUP BY sb.barcode, i.item_name, i.vendor_code, i.unit, c.client_name
     ORDER BY i.item_name, sb.barcode
     LIMIT $${idx++} OFFSET $${idx}`,
    params
  );
  return { rows: r.rows, total, limit, offset };
}

/**
 * Оборачиваемость: сколько единиц принято/отгружено за период
 */
async function getTurnoverReport({
  tenantId,
  clientId    = null,
  warehouseId = null,
  dateFrom,
  dateTo,
  limit  = 500,
  offset = 0,
}) {
  const params = [tenantId];
  const conds  = ['m.tenant_id=$1'];
  let idx = 2;

  if (clientId)    { conds.push(`m.client_id=$${idx++}`);    params.push(clientId); }
  if (warehouseId) { conds.push(`m.warehouse_id=$${idx++}`); params.push(warehouseId); }
  if (dateFrom)    { conds.push(`m.created_at>=$${idx++}::date`); params.push(dateFrom); }
  if (dateTo)      { conds.push(`m.created_at<($${idx++}::date+interval '1 day')`); params.push(dateTo); }

  params.push(Math.min(limit, 2000), Math.max(offset, 0));
  const r = await query(
    `SELECT
       m.barcode,
       i.item_name, i.vendor_code, i.unit,
       c.client_name,
       SUM(CASE WHEN m.movement_type IN ('receiving','inbound') AND m.qty>0 THEN m.qty ELSE 0 END)::int AS qty_received,
       SUM(CASE WHEN m.movement_type='picking' AND m.qty<0 THEN ABS(m.qty) ELSE 0 END)::int            AS qty_picked,
       SUM(CASE WHEN m.movement_type='shipping' AND m.qty<0 THEN ABS(m.qty) ELSE 0 END)::int           AS qty_shipped,
       SUM(CASE WHEN m.movement_type='return' AND m.qty>0 THEN m.qty ELSE 0 END)::int                  AS qty_returned,
       SUM(CASE WHEN m.movement_type IN ('writeoff','adjust') AND m.qty<0 THEN ABS(m.qty) ELSE 0 END)::int AS qty_writeoff,
       COUNT(DISTINCT DATE(m.created_at))::int AS active_days
     FROM wms.stock_movements m
     LEFT JOIN wms.items i ON i.id=m.item_id
     LEFT JOIN wms.clients c ON c.id=m.client_id
     WHERE ${conds.join(' AND ')}
     GROUP BY m.barcode, i.item_name, i.vendor_code, i.unit, c.client_name
     HAVING SUM(ABS(m.qty)) > 0
     ORDER BY qty_picked DESC, qty_received DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params
  );
  return r.rows;
}

/**
 * Статистика приёмки (по дням)
 */
async function getReceivingStats({ tenantId, clientId = null, warehouseId = null, dateFrom, dateTo }) {
  const params = [tenantId];
  const conds  = ["rt.tenant_id=$1", "rt.status='completed'"];
  let idx = 2;

  if (clientId)    { conds.push(`rt.client_id=$${idx++}`);    params.push(clientId); }
  if (warehouseId) { conds.push(`rt.warehouse_id=$${idx++}`); params.push(warehouseId); }
  if (dateFrom)    { conds.push(`rt.completed_at>=$${idx++}::date`); params.push(dateFrom); }
  if (dateTo)      { conds.push(`rt.completed_at<($${idx++}::date+interval '1 day')`); params.push(dateTo); }

  const r = await query(
    `SELECT
       DATE(rt.completed_at)::text AS date,
       COUNT(*)::int AS operations_count,
       SUM(rt.qty_received)::int AS total_units,
       COUNT(DISTINCT rt.receiver_id)::int AS operators_count,
       COUNT(DISTINCT rt.client_id)::int AS clients_count,
       COUNT(DISTINCT rt.barcode)::int AS sku_count
     FROM wms.receiving_tasks rt
     WHERE ${conds.join(' AND ')}
     GROUP BY DATE(rt.completed_at)
     ORDER BY DATE(rt.completed_at) DESC
     LIMIT 90`,
    params
  );
  return r.rows;
}

/**
 * Статистика сборки (по дням)
 */
async function getPickingStats({ tenantId, clientId = null, warehouseId = null, dateFrom, dateTo }) {
  const params = [tenantId];
  const conds  = ["pt.tenant_id=$1"];
  let idx = 2;

  if (clientId)    { conds.push(`pt.client_id=$${idx++}`);    params.push(clientId); }
  if (warehouseId) { conds.push(`pt.warehouse_id=$${idx++}`); params.push(warehouseId); }
  if (dateFrom)    { conds.push(`pt.finished_at>=$${idx++}::date`); params.push(dateFrom); }
  if (dateTo)      { conds.push(`pt.finished_at<($${idx++}::date+interval '1 day')`); params.push(dateTo); }

  const r = await query(
    `SELECT
       DATE(pt.finished_at)::text AS date,
       COUNT(*) FILTER(WHERE pt.status='done')::int    AS tasks_done,
       COUNT(*) FILTER(WHERE pt.status='skipped')::int AS tasks_skipped,
       SUM(pt.qty_picked)::int AS total_picked,
       COUNT(DISTINCT pt.picker_id)::int AS pickers_count,
       COUNT(DISTINCT pt.shipment_code)::int AS shipments_count,
       ROUND(AVG(
         EXTRACT(EPOCH FROM (pt.finished_at - pt.started_at))/60
       )::numeric, 1) AS avg_task_minutes
     FROM wms.picking_tasks pt
     WHERE ${conds.join(' AND ')} AND pt.finished_at IS NOT NULL
     GROUP BY DATE(pt.finished_at)
     ORDER BY DATE(pt.finished_at) DESC
     LIMIT 90`,
    params
  );
  return r.rows;
}

/**
 * Статистика отгрузки (по дням)
 */
async function getShippingStats({ tenantId, clientId = null, warehouseId = null, dateFrom, dateTo }) {
  const params = [tenantId];
  const conds  = ["s.tenant_id=$1"];
  let idx = 2;

  if (clientId)    { conds.push(`s.client_id=$${idx++}`);    params.push(clientId); }
  if (warehouseId) { conds.push(`s.warehouse_id=$${idx++}`); params.push(warehouseId); }
  if (dateFrom)    { conds.push(`s.shipped_at>=$${idx++}::date`); params.push(dateFrom); }
  if (dateTo)      { conds.push(`s.shipped_at<($${idx++}::date+interval '1 day')`); params.push(dateTo); }

  const r = await query(
    `SELECT
       DATE(s.shipped_at)::text AS date,
       COUNT(*)::int AS shipments_count,
       SUM(s.total_shipped_qty)::int AS total_units,
       COUNT(DISTINCT s.client_id)::int AS clients_count,
       SUM(CASE WHEN s.status='in_transit' THEN 1 ELSE 0 END)::int AS in_transit,
       SUM(CASE WHEN s.status='done' THEN 1 ELSE 0 END)::int AS done
     FROM wms.shipments s
     WHERE ${conds.join(' AND ')} AND s.shipped_at IS NOT NULL
     GROUP BY DATE(s.shipped_at)
     ORDER BY DATE(s.shipped_at) DESC
     LIMIT 90`,
    params
  );
  return r.rows;
}

/**
 * KPI по операторам
 */
async function getOperatorStats({ tenantId, dateFrom, dateTo }) {
  const params = [tenantId];
  let idx = 2;
  const dateConds = [];
  if (dateFrom) { dateConds.push(`m.created_at>=$${idx++}::date`); params.push(dateFrom); }
  if (dateTo)   { dateConds.push(`m.created_at<($${idx++}::date+interval '1 day')`); params.push(dateTo); }
  const dateWhere = dateConds.length ? ' AND ' + dateConds.join(' AND ') : '';

  const r = await query(
    `SELECT
       u.id AS user_id, u.username, u.full_name, u.role,
       COUNT(m.id)::int AS total_movements,
       SUM(ABS(m.qty))::int AS total_units,
       COUNT(DISTINCT DATE(m.created_at))::int AS active_days,
       COUNT(DISTINCT m.barcode)::int AS unique_sku,
       MAX(m.created_at) AS last_activity
     FROM wms.users u
     LEFT JOIN wms.stock_movements m ON m.user_id=u.id AND m.tenant_id=u.tenant_id ${dateWhere}
     WHERE u.tenant_id=$1 AND u.is_active=TRUE
       AND u.role NOT IN ('seller','analyst')
     GROUP BY u.id, u.username, u.full_name, u.role
     ORDER BY total_movements DESC NULLS LAST`,
    params
  );
  return r.rows;
}

/**
 * Сводный отчёт по клиенту
 */
async function getClientReport({ tenantId, clientId, dateFrom, dateTo }) {
  if (!clientId) throw new Error('clientId is required');

  const period = [tenantId, clientId];
  let pidx = 3;
  const periodConds = [];
  if (dateFrom) { periodConds.push(`m.created_at>=$${pidx++}::date`); period.push(dateFrom); }
  if (dateTo)   { periodConds.push(`m.created_at<($${pidx++}::date+interval '1 day')`); period.push(dateTo); }
  const periodWhere = periodConds.length ? ' AND ' + periodConds.join(' AND ') : '';

  // Текущие остатки
  const stockRes = await query(
    `SELECT
       SUM(sb.qty_on_hand)::int   AS total_on_hand,
       SUM(sb.qty_reserved)::int  AS total_reserved,
       SUM(sb.qty_available)::int AS total_available,
       COUNT(DISTINCT sb.barcode)::int AS sku_count,
       SUM(sb.qty_on_hand * COALESCE(sb.avg_cost,0)) AS total_stock_value
     FROM wms.stock_balances sb
     WHERE sb.tenant_id=$1 AND sb.client_id=$2`,
    [tenantId, clientId]
  );

  // Движения за период
  const movRes = await query(
    `SELECT
       SUM(CASE WHEN m.movement_type IN ('receiving','inbound') AND m.qty>0 THEN m.qty ELSE 0 END)::int AS received,
       SUM(CASE WHEN m.movement_type='picking'   AND m.qty<0 THEN ABS(m.qty) ELSE 0 END)::int AS picked,
       SUM(CASE WHEN m.movement_type='shipping'  AND m.qty<0 THEN ABS(m.qty) ELSE 0 END)::int AS shipped,
       SUM(CASE WHEN m.movement_type='return'    AND m.qty>0 THEN m.qty ELSE 0 END)::int       AS returned,
       COUNT(DISTINCT m.ref_id) FILTER(WHERE m.movement_type='shipping')::int AS shipments_count,
       COUNT(DISTINCT m.ref_id) FILTER(WHERE m.movement_type IN ('receiving','inbound'))::int AS receiving_count
     FROM wms.stock_movements m
     WHERE m.tenant_id=$1 AND m.client_id=$2 ${periodWhere}`,
    period
  );

  return {
    stock:   stockRes.rows[0],
    period:  movRes.rows[0],
  };
}

/**
 * Временная шкала движений по barcode (для карточки товара)
 */
async function getMovementTimeline({ tenantId, barcode, clientId = null, limit = 100 }) {
  const b = String(barcode || '').trim();
  if (!b) throw new Error('barcode is required');

  const params = [tenantId, b];
  let idx = 3;
  let cond = '';
  if (clientId) { cond = `AND m.client_id=$${idx++}`; params.push(clientId); }

  params.push(Math.min(limit, 500));
  const r = await query(
    `SELECT
       m.id, m.movement_type, m.qty,
       m.from_location_code, m.to_location_code,
       m.ref_type, m.ref_id, m.comment,
       m.created_at,
       u.username AS operator,
       -- running balance: сумма всех qty до этой записи включительно
       SUM(m.qty) OVER (ORDER BY m.created_at, m.id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::int AS running_balance
     FROM wms.stock_movements m
     LEFT JOIN wms.users u ON u.id=m.user_id
     WHERE m.tenant_id=$1 AND m.barcode=$2 ${cond}
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT $${idx}`,
    params
  );
  return r.rows;
}

module.exports = {
  getStockSnapshot,
  getTurnoverReport,
  getReceivingStats,
  getPickingStats,
  getShippingStats,
  getOperatorStats,
  getClientReport,
  getMovementTimeline,
};
