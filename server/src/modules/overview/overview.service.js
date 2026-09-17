'use strict';

const { query } = require('../../config/database');
const analyticsService = require('../analytics/analytics.service');
const { CHECKIN_VALID_HOURS } = require('../../middleware/requireCheckedIn');

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
    fbsOnTimeToday,
  ] = await Promise.all([
    getReceivingStats(tenantId),
    getPlacementStats(tenantId),
    getWaveBacklogStats(tenantId),
    getPickingStats(tenantId),
    getPackingStats(tenantId),
    getShippingStats(tenantId),
    getStuckOrdersStats(tenantId),
    getFbsOnTimeToday(tenantId),
  ]);

  return { receiving, placement, waveBacklog, picking, packing, shipping, stuckOrders, fbsOnTimeToday };
}

/** % заказов, принятых ВБ СЕГОДНЯ (wb_accepted_at), уложившихся в 48ч от
 *  создания заказа до приёмки ВБ. ДОБАВЛЕНО 13.09.2026 по просьбе клиента -
 *  "табло наполовину пустое, добавь что-то полезное". Специально считаем по
 *  ДАТЕ ПРИЁМКИ (wb_accepted_at), а не по дате СОЗДАНИЯ заказа (как делает
 *  fbsAnalyticsService.getProcessingSpeed для отчётов за период) - если
 *  фильтровать по created_at='сегодня', большая часть заказов, созданных
 *  сегодня, физически ещё не успела дойти до приёмки ВБ (окно приёмки до
 *  48ч) и tile почти весь день показывал бы "processed:0" - бесполезно для
 *  табло, которое смотрят прямо сейчас, в моменте дня. */
async function getFbsOnTimeToday(tenantId) {
  const r = await query(
    `SELECT wo.created_at, s.wb_accepted_at AS accepted_at
     FROM wms.wb_orders wo
     JOIN wms.shipments s ON s.tenant_id = wo.tenant_id AND s.external_id = wo.wb_supply_id
     WHERE wo.tenant_id = $1
       AND s.wb_accepted_at >= date_trunc('day', NOW())
       AND s.wb_accepted_at < date_trunc('day', NOW()) + INTERVAL '1 day'`,
    [tenantId]
  );
  let onTime = 0;
  const processed = r.rowCount;
  for (const row of r.rows) {
    const hours = (new Date(row.accepted_at) - new Date(row.created_at)) / 3600000;
    if (hours <= 48) onTime++;
  }
  return {
    processed,
    on_time_rate: processed > 0 ? (onTime / processed) * 100 : null,
  };
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
    дёргать зря уже реально закрытые на ВБ заказы (sold/canceled/...).
    ФИКС 12.09.2026: 'sorted' (ВБ реально отсканировал заказ у себя на складе -
    в fbsAnalytics.service.js это уже классифицируется как бакет "in_transit",
    т.е. заказ уже поехал дальше) не был в списке исключений - алерт продолжал
    висеть даже после того, как товар физически отсканировали на стороне ВБ.
    ФИКС 13.09.2026: та же история со статусом 'ready_for_pickup' (посылка уже
    физически лежит на ПВЗ и ждёт покупателя - дальше "стоять на сборке" уже
    физически не может) - подтверждено реальными данными заказов
    5674794578/5676799351 в поставке WB-GI-274281627. */
async function getStuckOrdersGroups(tenantId) {
  const r = await query(
    `SELECT
       o.wb_supply_id AS external_id,
       COALESCE(s.client_id, ma.client_id) AS client_id,
       cl.client_name,
       s.id AS shipment_id,
       s.status AS shipment_status,
       s.cancelled_at,
       s.cancel_reason,
       s.created_at AS shipment_created_at,
       COUNT(*)::int AS orders_count,
       MIN(o.created_at) AS earliest_order_at
     FROM wms.wb_orders o
     JOIN wms.mp_accounts ma ON ma.id = o.mp_account_id
     LEFT JOIN wms.shipments s ON s.tenant_id = o.tenant_id AND s.external_id = o.wb_supply_id
     LEFT JOIN wms.clients cl ON cl.id = COALESCE(s.client_id, ma.client_id)
     WHERE o.tenant_id = $1
       AND o.status = 'confirm'
       AND o.wb_supply_id IS NOT NULL
       AND COALESCE(o.wb_status,'') NOT IN ('sorted','ready_for_pickup','sold','canceled','canceled_by_client','declined_by_client','defect')
       AND (
         s.id IS NULL
         OR s.status = 'cancelled'
         OR (s.status NOT IN ('in_transit','done') AND s.created_at < NOW() - INTERVAL '48 hours')
       )
     GROUP BY o.wb_supply_id, COALESCE(s.client_id, ma.client_id), cl.client_name, s.id, s.status, s.cancelled_at, s.cancel_reason, s.created_at
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

// =============================================================================
// Диспетчерская: "живая сводка" (ДОБАВЛЕНО 13.09.2026 по просьбе пользователя -
// "не нравится наполнение Диспетчерской", страница почти всегда пустая между
// волнами). Четыре независимых блока:
//   1. staff       - кто отмечен на смене (employee_checkins, живёт 12ч - см.
//      CHECKIN_VALID_HOURS) и чем занят ПРЯМО СЕЙЧАС: активная волна сборки
//      (pick_waves.status='active'), активная упаковка (packing_tasks.
//      status='in_progress') или просто "на месте" (employee_active_station).
//   2. printQueue  - застрявшие задания печати (status='new' дольше 3 минут -
//      если агент/принтер встал, тут это видно раньше, чем сборщики начнут
//      жаловаться на отсутствие стикеров) и задания с ошибкой.
//   3. shiftSummary - сводка за СЕГОДНЯ (волн закрыто, строк/штук собрано,
//      отгрузок/юнитов отгружено) - чтобы страница не выглядела мёртвой,
//      когда волн прямо сейчас нет.
//   4. throughput  - выработка по сотрудникам за сегодня (собрано/упаковано),
//      отдельно от табло/аналитики - тут это сборка ПО КОНКРЕТНОМУ человеку.
// =============================================================================

async function getDispatcherLive({ tenantId }) {
  const [staff, printQueue, throughputPicking, throughputPacking, wavesClosedToday, pickStatsToday, shipStatsToday] = await Promise.all([
    getStaffRoster(tenantId),
    getPrintQueueHealth(tenantId),
    getPickingThroughputToday(tenantId),
    getPackingThroughputToday(tenantId),
    getWavesClosedToday(tenantId),
    analyticsService.getPickingStats({ tenantId, dateFrom: todayStr(), dateTo: todayStr() }),
    analyticsService.getShippingStats({ tenantId, dateFrom: todayStr(), dateTo: todayStr() }),
  ]);

  const throughputByUser = new Map();
  for (const row of throughputPicking) {
    throughputByUser.set(row.user_id, { user_id: row.user_id, username: row.username, full_name: row.full_name, units_picked: row.units_picked, tasks_picked: row.tasks_picked, units_packed: 0, shipments_packed: 0 });
  }
  for (const row of throughputPacking) {
    const existing = throughputByUser.get(row.user_id);
    if (existing) {
      existing.units_packed = row.units_packed;
      existing.shipments_packed = row.shipments_packed;
    } else {
      throughputByUser.set(row.user_id, { user_id: row.user_id, username: row.username, full_name: row.full_name, units_picked: 0, tasks_picked: 0, units_packed: row.units_packed, shipments_packed: row.shipments_packed });
    }
  }

  return {
    staff,
    printQueue,
    shiftSummary: {
      waves_closed: wavesClosedToday,
      tasks_done: pickStatsToday[0]?.tasks_done || 0,
      units_picked: pickStatsToday[0]?.total_picked || 0,
      avg_task_minutes: pickStatsToday[0]?.avg_task_minutes || null,
      shipments_count: shipStatsToday[0]?.shipments_count || 0,
      units_shipped: shipStatsToday[0]?.total_units || 0,
    },
    throughput: Array.from(throughputByUser.values()).sort((a, b) => (b.units_picked + b.units_packed) - (a.units_picked + a.units_packed)),
  };
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function getStaffRoster(tenantId) {
  // CHECKIN_VALID_HOURS считаем в JS и передаём готовой границей времени -
  // "число || ' hours' :: interval" в SQL требует лишнего каста типов и
  // менее надёжно, чем просто сравнить timestamptz с timestamptz.
  const sinceTs = new Date(Date.now() - CHECKIN_VALID_HOURS * 3600 * 1000);
  const r = await query(
    `SELECT
       u.id AS user_id, u.username, u.full_name, u.role,
       ec.checked_in_at,
       ws.station_name,
       w.id AS wave_id, w.shipment_code AS wave_shipment_code,
       (SELECT COUNT(*)::int FROM wms.picking_tasks t WHERE t.wave_id=w.id) AS wave_task_count,
       (SELECT COUNT(*)::int FROM wms.picking_tasks t WHERE t.wave_id=w.id AND t.status='done') AS wave_done_count,
       pk.shipment_code AS packing_shipment_code
     FROM wms.employee_checkins ec
     JOIN wms.users u ON u.id = ec.employee_id
     LEFT JOIN wms.employee_active_station eas ON eas.employee_id = u.id AND eas.tenant_id = u.tenant_id
     LEFT JOIN wms.workstations ws ON ws.id = eas.station_id
     LEFT JOIN wms.pick_waves w ON w.picker_id = u.id AND w.tenant_id = u.tenant_id AND w.status = 'active'
     LEFT JOIN wms.packing_tasks pk ON pk.packer_id = u.id AND pk.tenant_id = u.tenant_id AND pk.status = 'in_progress'
     WHERE ec.tenant_id = $1 AND ec.checked_in_at >= $2
     ORDER BY u.full_name NULLS LAST, u.username`,
    [tenantId, sinceTs]
  );
  return r.rows;
}

/** Задания печати, застрявшие дольше 3 минут (агент/принтер, скорее всего,
 *  не в порядке - реальная печать почти всегда забирает задание за секунды),
 *  плюс явные ошибки печати - за последние сутки, чтобы старый мусор не
 *  висел в счётчике вечно. */
async function getPrintQueueHealth(tenantId) {
  const r = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status='new' AND created_at < NOW() - INTERVAL '3 minutes')::int AS stuck_new,
       COUNT(*) FILTER (WHERE status='error')::int AS errors
     FROM wms.print_jobs
     WHERE tenant_id=$1 AND created_at > NOW() - INTERVAL '24 hours'`,
    [tenantId]
  );
  return r.rows[0] || { stuck_new: 0, errors: 0 };
}

async function getPickingThroughputToday(tenantId) {
  const r = await query(
    `SELECT pt.picker_id AS user_id, u.username, u.full_name,
       COUNT(*) FILTER (WHERE pt.status='done')::int AS tasks_picked,
       COALESCE(SUM(pt.qty_picked),0)::int AS units_picked
     FROM wms.picking_tasks pt
     JOIN wms.users u ON u.id = pt.picker_id
     WHERE pt.tenant_id=$1 AND pt.finished_at >= date_trunc('day', NOW())
       AND pt.finished_at < date_trunc('day', NOW()) + INTERVAL '1 day'
     GROUP BY pt.picker_id, u.username, u.full_name`,
    [tenantId]
  );
  return r.rows;
}

async function getPackingThroughputToday(tenantId) {
  const r = await query(
    `SELECT s.packer_id AS user_id, u.username, u.full_name,
       COUNT(*)::int AS shipments_packed,
       COALESCE(SUM(s.total_packed_qty),0)::int AS units_packed
     FROM wms.shipments s
     JOIN wms.users u ON u.id = s.packer_id
     WHERE s.tenant_id=$1 AND s.packing_finished_at >= date_trunc('day', NOW())
       AND s.packing_finished_at < date_trunc('day', NOW()) + INTERVAL '1 day'
     GROUP BY s.packer_id, u.username, u.full_name`,
    [tenantId]
  );
  return r.rows;
}

async function getWavesClosedToday(tenantId) {
  const r = await query(
    `SELECT COUNT(*)::int AS n FROM wms.pick_waves
     WHERE tenant_id=$1 AND status='done' AND updated_at >= date_trunc('day', NOW())`,
    [tenantId]
  );
  return r.rows[0]?.n || 0;
}

module.exports = { getFunnelOverview, getStuckOrdersGroups, getDispatcherLive };
