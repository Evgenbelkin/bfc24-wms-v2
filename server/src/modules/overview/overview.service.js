'use strict';

const { query } = require('../../config/database');

// =============================================================================
// Overview Service ("Табло")
// Сводка по всей воронке склада одним запросом: приёмка → размещение →
// волна (WB-заказы, ещё не сгруппированные) → сборка → упаковка → отгрузка.
// Каждый блок — независимый агрегат, без пересечения ответственности с
// экранами-исполнителями (picking/packing/shipping) — там детальные списки,
// здесь только объём по всему складу тенанта.
// =============================================================================

async function getFunnelOverview({ tenantId }) {
  const [
    receiving,
    placement,
    waveBacklog,
    picking,
    packing,
    shipping,
  ] = await Promise.all([
    getReceivingStats(tenantId),
    getPlacementStats(tenantId),
    getWaveBacklogStats(tenantId),
    getPickingStats(tenantId),
    getPackingStats(tenantId),
    getShippingStats(tenantId),
  ]);

  return { receiving, placement, waveBacklog, picking, packing, shipping };
}

/** Приёмка: активные заявки (не completed/cancelled) — план vs факт */
async function getReceivingStats(tenantId) {
  const r = await query(
    `SELECT
       COUNT(*)::int AS active_orders,
       COALESCE(SUM(total_expected_qty),0)::int AS units_expected,
       COALESCE(SUM(total_received_qty),0)::int AS units_received
     FROM wms.inbound_orders
     WHERE tenant_id=$1 AND status NOT IN ('completed','cancelled')`,
    [tenantId]
  );
  return r.rows[0];
}

/** Размещение: сколько лежит в зоне приёмки/буфере/карантине — ещё не на полке */
async function getPlacementStats(tenantId) {
  const r = await query(
    `SELECT
       COUNT(*)::int AS lines_pending,
       COALESCE(SUM(sb.qty_on_hand),0)::int AS units_pending
     FROM wms.stock_balances sb
     JOIN wms.locations l ON l.id = sb.location_id
     WHERE sb.tenant_id=$1 AND sb.qty_on_hand > 0
       AND l.location_type IN ('receiving','buffer','quarantine')`,
    [tenantId]
  );
  return r.rows[0];
}

/** WB-заказы, полученные синком, но ещё не сгруппированные в волну/поставку */
async function getWaveBacklogStats(tenantId) {
  const r = await query(
    `SELECT COUNT(*)::int AS backlog_orders
     FROM wms.wb_orders
     WHERE tenant_id=$1 AND wb_supply_id IS NULL
       AND COALESCE(status,'') NOT IN ('confirm','complete','cancel')`,
    [tenantId]
  );
  return r.rows[0];
}

/** Сборка: сколько строк/штук ещё не собрано по всем открытым волнам */
async function getPickingStats(tenantId) {
  const r = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('new','in_progress'))::int AS tasks_pending,
       COUNT(*) FILTER (WHERE status='done')::int AS tasks_done,
       COALESCE(SUM(qty) FILTER (WHERE status IN ('new','in_progress')),0)::int AS qty_pending
     FROM wms.picking_tasks
     WHERE tenant_id=$1`,
    [tenantId]
  );
  return r.rows[0];
}

/** Упаковка: сколько задач ещё не упаковано */
async function getPackingStats(tenantId) {
  const r = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('new','in_progress'))::int AS tasks_pending,
       COUNT(*) FILTER (WHERE status='done')::int AS tasks_done
     FROM wms.packing_tasks
     WHERE tenant_id=$1`,
    [tenantId]
  );
  return r.rows[0];
}

/** Отгрузка: сколько готово к отгрузке и сколько уже в пути */
async function getShippingStats(tenantId) {
  const r = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status='ready_to_ship')::int AS ready_to_ship,
       COUNT(*) FILTER (WHERE status='in_transit')::int AS in_transit,
       COUNT(*) FILTER (WHERE status='done')::int AS done_total
     FROM wms.shipments
     WHERE tenant_id=$1`,
    [tenantId]
  );
  return r.rows[0];
}

module.exports = { getFunnelOverview };
