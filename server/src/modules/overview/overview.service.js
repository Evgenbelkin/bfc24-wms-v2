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
    stuckOrders,
  ] = await Promise.all([
    getReceivingStats(tenantId),
    getPlacementStats(tenantId),
    getWaveBacklogStats(tenantId),
    getPickingStats(tenantId),
    getPackingStats(tenantId),
    getShippingStats(tenantId),
    getStuckOrdersStats(tenantId),
  ]);

  return { receiving, placement, waveBacklog, picking, packing, shipping, stuckOrders };
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

/** WB-заказы, полученные синком, но ещё не сгруппированные в волну/поставку.
    Раньше фильтровали "исключением" (NOT IN confirm/complete/cancel), из-за
    чего заказы в статусе 'external' (уже забраны через личный кабинет WB,
    в волну им попадать не нужно и незачем) всё равно засчитывались в бэклог
    и раздували число "без волны" (реальный кейс: показывало 64, хотя
    реально годных к волне — 12). В волну можно взять только заказ в
    статусе 'new' — остальные статусы так или иначе уже не актуальны для
    формирования волны, поэтому фильтруем по явному "разрешению", а не
    "исключению".

    04.09.2026: та же история повторилась со складами WB, отключёнными для
    сборки этим тенантом (is_enabled_for_picking=FALSE - "этот склад
    обслуживает другой ФФ", см. /wb/orders и /generate-wave) - их заказы
    физически никогда не попадут в волну ЭТОГО фулфилмента, но всё равно
    считались в "без волны" на табло, раздувая число тем же образом. */
async function getWaveBacklogStats(tenantId) {
  const r = await query(
    `SELECT COUNT(*)::int AS backlog_orders
     FROM wms.wb_orders o
     WHERE o.tenant_id=$1 AND o.wb_supply_id IS NULL AND o.status='new'
       AND NOT EXISTS (
         SELECT 1 FROM wms.wb_seller_warehouses w
         WHERE w.mp_account_id=o.mp_account_id AND w.wb_warehouse_id=o.warehouse_id
           AND w.is_enabled_for_picking=FALSE
       )`,
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

/** Заказы ВБ, подтверждённые в поставку (status='confirm'), у которых локальная
    отгрузка WMS не отражает реальный ход дел на стороне ВБ:
      - отгрузку в WMS отменили (cancelShipment), но wms.wb_orders так и
        остался 'confirm' навсегда - реконсиляция его не видит, т.к. она
        трогает только заказы БЕЗ wb_supply_id (см. fetchAndUpsertOrders);
      - либо отгрузка вообще не найдена по wb_supply_id (сироты);
      - либо отгрузка жива, но застряла дольше 48ч и не дошла до
        in_transit/done (забытая волна, заблокированная упаковка и т.п.).
    Реальный инцидент (09.09.2026, WB-GI-274281627): супервайзер отменил
    зависшую отгрузку с комментарием "отгружено", думая что уже отгрузил её
    напрямую через кабинет ВБ - но заказ реально висел "на сборке" на ВБ ещё
    3 дня, а WMS никак это не показывала (cancelled-отгрузки нигде не видны
    отдельным списком). wb_status (обновляется раз в 30 мин job'ом
    wbFbsStatusSync.js, независимо от wb_supply_id) используется, чтобы не
    дёргать зря уже реально закрытые на ВБ заказы (sold/canceled/...). */
async function getStuckOrdersGroups(tenantId) {
  const r = await query(
    `SELECT
       o.wb_supply_id AS external_id,
       o.client_id,
       cl.client_name,
       s.id AS shipment_id,
       s.status AS shipment_status,
       s.cancelled_at,
       s.cancel_reason,
       s.created_at AS shipment_created_at,
       COUNT(*)::int AS orders_count,
       MIN(o.created_at) AS earliest_order_at
     FROM wms.wb_orders o
     LEFT JOIN wms.shipments s ON s.tenant_id = o.tenant_id AND s.external_id = o.wb_supply_id
     LEFT JOIN wms.clients cl ON cl.id = o.client_id
     WHERE o.tenant_id = $1
       AND o.status = 'confirm'
       AND o.wb_supply_id IS NOT NULL
       AND COALESCE(o.wb_status,'') NOT IN ('sold','canceled','canceled_by_client','declined_by_client','defect')
       AND (
         s.id IS NULL
         OR s.status = 'cancelled'
         OR (s.status NOT IN ('in_transit','done') AND s.created_at < NOW() - INTERVAL '48 hours')
       )
     GROUP BY o.wb_supply_id, o.client_id, cl.client_name, s.id, s.status, s.cancelled_at, s.cancel_reason, s.created_at
     ORDER BY MIN(o.created_at) ASC
     LIMIT 50`,
    [tenantId]
  );
  return r.rows;
}

async function getStuckOrdersStats(tenantId) {
  const groups = await getStuckOrdersGroups(tenantId);
  const stuckOrders = groups.reduce((sum, g) => sum + Number(g.orders_count), 0);
  return { stuck_supplies: groups.length, stuck_orders: stuckOrders, groups };
}

module.exports = { getFunnelOverview, getStuckOrdersGroups };
