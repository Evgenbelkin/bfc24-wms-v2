'use strict';

const { query } = require('../../config/database');
const wbClient = require('../wb/wb.client');
const wbService = require('../wb/wb.service');
const logger = require('../../utils/logger');

// =============================================================================
// Модуль "Аналитика FBS" — по образцу конкурентов (TrueStats и т.п.), но с
// поправкой на то, что мы не только тянем данные из WB API, а сами физически
// проводим заказ через склад. Фаза 1 (текущая): сводка заказов по статусам.
//
// wms.wb_orders.status — это НАШ локальный жизненный цикл (new -> confirm ->
// shipped/external -> cancel), он НЕ совпадает с реальным статусом заказа на
// стороне WB (wbStatus). Раньше wbStatus нигде не сохранялся - использовался
// только "на лету" в syncDeliveryStatusForTenant и сразу выбрасывался. Здесь
// заводим постоянное хранение (wb_status/wb_status_updated_at, миграция 051)
// и периодический опрос (см. jobs/wbFbsStatusSync.js), чтобы можно было
// строить сводку и (в будущих фазах) графики динамики.
//
// WB реально документирует только эти значения wbStatus (POST
// /api/v3/orders/status): waiting, sorted, sold, canceled, canceled_by_client,
// declined_by_client, defect. Отдельного "ждёт на ПВЗ" WB через этот метод не
// отдаёт (в отличие от TrueStats, у нас пока нет для этого источника данных) -
// поэтому здесь 6 корзин вместо их 7, "В пути к клиенту" включает и то время,
// что посылка уже физически на ПВЗ и ждёт покупателя.
// =============================================================================

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const TERMINAL_STATUSES = ['sold', 'canceled', 'canceled_by_client', 'declined_by_client', 'defect'];

const BUCKET_LABELS = {
  new:         'Новые',
  in_progress: 'В работе',
  in_transit:  'В пути к клиенту',
  purchased:   'Выкуплено',
  cancelled:   'Отменено',
  problem:     'Проблемные',
};
const BUCKET_ORDER = ['new', 'in_progress', 'in_transit', 'purchased', 'cancelled', 'problem'];

/**
 * Обновить wb_status для заказов тенанта, которым это ещё не сделано или чей
 * статус ещё не финальный. Прицельно только за последние 90 дней - WB и сам
 * дальше эту историю не хранит (см. документацию /api/v3/orders/status).
 */
async function refreshWbStatusesForAccount({ tenantId, mpAccountId, apiToken }) {
  const ordersRes = await query(
    `SELECT wb_order_id FROM wms.wb_orders
     WHERE tenant_id=$1 AND mp_account_id=$2
       AND (wb_status IS NULL OR wb_status NOT IN (${TERMINAL_STATUSES.map((_, i) => `$${i + 3}`).join(',')}))
       AND created_at >= NOW() - INTERVAL '90 days'`,
    [tenantId, mpAccountId, ...TERMINAL_STATUSES]
  );
  const orderIds = ordersRes.rows.map(r => Number(r.wb_order_id)).filter(Boolean);
  if (!orderIds.length) return { checked: 0, updated: 0 };

  let updated = 0;
  for (const chunk of chunkArray(orderIds, 1000)) {
    let statuses;
    try {
      statuses = await wbClient.fetchOrderStatuses(apiToken, chunk);
    } catch (e) {
      logger.error({ err: e, tenantId, mpAccountId, chunkSize: chunk.length }, 'FBS-analytics: fetchOrderStatuses failed');
      continue;
    }
    for (const s of statuses) {
      const orderId = s.id ?? s.orderId ?? s.nmId;
      if (!orderId || !s.wbStatus) continue;
      await query(
        `UPDATE wms.wb_orders SET wb_status=$1, wb_status_updated_at=NOW()
         WHERE tenant_id=$2 AND mp_account_id=$3 AND wb_order_id=$4 AND (wb_status IS DISTINCT FROM $1)`,
        [s.wbStatus, tenantId, mpAccountId, orderId]
      );
      updated++;
    }
  }
  return { checked: orderIds.length, updated };
}

async function refreshWbStatusesForTenant(tenantId) {
  const accounts = await wbService.listActiveAccounts(tenantId);
  let totalChecked = 0, totalUpdated = 0;
  for (const acc of accounts) {
    try {
      const r = await refreshWbStatusesForAccount({ tenantId, mpAccountId: acc.id, apiToken: acc.api_token });
      totalChecked += r.checked;
      totalUpdated += r.updated;
    } catch (e) {
      logger.error({ err: e, tenantId, mpAccountId: acc.id }, 'FBS-analytics: refresh failed for account');
    }
  }
  return { accounts: accounts.length, checked: totalChecked, updated: totalUpdated };
}

/** Заказ -> одна из 6 корзин, на основе НАШЕГО status + WB wbStatus. */
function classify(row) {
  if (row.status === 'cancel' || ['canceled', 'canceled_by_client', 'declined_by_client'].includes(row.wb_status)) {
    return 'cancelled';
  }
  if (row.wb_status === 'defect') return 'problem';
  if (row.wb_status === 'sold') return 'purchased';
  if (row.wb_status === 'sorted') return 'in_transit';
  if (row.status === 'confirm' || row.status === 'shipped') return 'in_progress';
  return 'new';
}

async function computeSummary({ tenantId, clientId = null, mpAccountId = null, dateFrom, dateTo }) {
  const params = [tenantId, dateFrom, dateTo];
  const conds = ['wo.tenant_id=$1', 'wo.created_at >= $2', 'wo.created_at < $3'];
  let idx = 4;
  if (clientId) { conds.push(`ma.client_id=$${idx++}`); params.push(clientId); }
  if (mpAccountId) { conds.push(`wo.mp_account_id=$${idx++}`); params.push(mpAccountId); }

  const r = await query(
    `SELECT wo.status, wo.wb_status, wo.converted_price
     FROM wms.wb_orders wo
     JOIN wms.mp_accounts ma ON ma.id = wo.mp_account_id
     WHERE ${conds.join(' AND ')}`,
    params
  );

  // wo.converted_price хранится КАК ПРИШЁЛ ОТ WB - в копейках (WB API:
  // "convertedPrice ... multiplied by 100"), нигде в проекте раньше не
  // делился на 100, потому что нигде раньше и не суммировался для показа
  // денег пользователю. Делим здесь, при чтении - сырое значение в БД не
  // трогаем, чтобы не ломать другой код, который когда-нибудь тоже до него
  // доберётся и будет знать про эту особенность.
  const buckets = {};
  for (const key of BUCKET_ORDER) buckets[key] = { qty: 0, amount: 0 };
  for (const row of r.rows) {
    const bucket = classify(row);
    buckets[bucket].qty += 1;
    buckets[bucket].amount += (Number(row.converted_price) || 0) / 100;
  }

  const totalQty = r.rows.length;
  const totalAmount = BUCKET_ORDER.reduce((s, k) => s + buckets[k].amount, 0);
  const purchaseBase = buckets.purchased.qty + buckets.cancelled.qty;
  const purchaseRate = purchaseBase > 0 ? (buckets.purchased.qty / purchaseBase) * 100 : null;

  return {
    total: { qty: totalQty, amount: totalAmount },
    purchase_rate: purchaseRate,
    buckets: BUCKET_ORDER.map(key => ({ key, label: BUCKET_LABELS[key], qty: buckets[key].qty, amount: buckets[key].amount })),
  };
}

/** Сводка за период + сравнение с предыдущим периодом такой же длины. */
async function getFbsSummary({ tenantId, clientId = null, mpAccountId = null, dateFrom, dateTo }) {
  const from = new Date(dateFrom);
  const to = new Date(dateTo);
  const periodMs = to.getTime() - from.getTime();
  const prevTo = new Date(from);
  const prevFrom = new Date(from.getTime() - periodMs);

  const [current, previous] = await Promise.all([
    computeSummary({ tenantId, clientId, mpAccountId, dateFrom: from, dateTo: to }),
    computeSummary({ tenantId, clientId, mpAccountId, dateFrom: prevFrom, dateTo: prevTo }),
  ]);

  return { current, previous, period: { from: dateFrom, to: dateTo }, previous_period: { from: prevFrom.toISOString(), to: prevTo.toISOString() } };
}

module.exports = {
  refreshWbStatusesForAccount,
  refreshWbStatusesForTenant,
  getFbsSummary,
};
