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
      const upd = await query(
        `UPDATE wms.wb_orders SET wb_status=$1, wb_status_updated_at=NOW()
         WHERE tenant_id=$2 AND mp_account_id=$3 AND wb_order_id=$4 AND (wb_status IS DISTINCT FROM $1)
         RETURNING id`,
        [s.wbStatus, tenantId, mpAccountId, orderId]
      );
      if (upd.rowCount > 0) {
        updated++;
        // История ПЕРВЫХ переходов - для расчёта сроков обработки (фаза 2).
        // ON CONFLICT DO NOTHING: UNIQUE(mp_account_id, wb_order_id, wb_status)
        // гарантирует, что сохраняется именно первое наблюдение этого статуса,
        // даже если тот же статус вернётся повторно позже (не должно
        // случаться у WB, но на всякий случай не даём это задвоить).
        await query(
          `INSERT INTO wms.wb_order_status_events (tenant_id, mp_account_id, wb_order_id, wb_status, observed_at)
           VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT (mp_account_id, wb_order_id, wb_status) DO NOTHING`,
          [tenantId, mpAccountId, orderId, s.wbStatus]
        );
      }
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

// -----------------------------------------------------------------------------
// Фаза 2: сроки обработки и комиссия WB.
//
// WB меняет комиссию в зависимости от того, СКОЛЬКО ВРЕМЕНИ ПРОШЛО ОТ
// СОЗДАНИЯ ЗАКАЗА ДО ТОГО, КАК WB ФИЗИЧЕСКИ ПРИНЯЛ ПОСТАВКУ У СЕБЯ НА СКЛАДЕ
// (не до доставки покупателю!) - по словам Джеки, это момент, когда WB
// сканирует QR-код поставки на приёмке. Пороги те же, что в документации
// WB/конкурентов:
//   0–13ч   — максимальная скидка на комиссию (-5 п.п.)
//   13–42ч  — скидка (-3.5 п.п.)
//   42–48ч  — базовая ставка ("вовремя")
//   48–54ч  — штраф +0.30 п.п./ч
//   54–60ч  — штраф +0.35 п.п./ч
//   >60ч    — штраф +0.45 п.п./ч
// "Доставлено вовремя" = доля заказов, уложившихся в 48ч.
//
// ВАЖНО (правка 28.08.2026, вторая версия этой метрики): изначально момент
// "заказ покинул 'waiting'" пытались ловить ПО ОТДЕЛЬНОМУ ЗАКАЗУ через
// wbStatus (см. историю в git - сначала "любой статус != waiting", потом
// сужали до конкретно 'sorted'). Оба варианта оказались ненадёжны: реальные
// значения wbStatus, которые правда приходят от WB (например
// 'ready_for_pickup'), не совпадали с тем, что было задокументировано по
// стороннему блог-посту, из-за чего метрика либо путала срок с временем до
// выкупа, либо вообще не считалась ни по одному заказу. Правильный источник
// для "когда WB принял ПОСТАВКУ" уже был в системе: wms.shipments.wb_accepted_at
// - его выставляет syncDeliveryStatusForTenant (wb.service.js, фоновый крон
// раз в 15 минут, WB_AUTO_SYNC_INTERVAL_MINUTES) в момент, когда ВСЕ заказы
// поставки перестают быть 'waiting' - то есть именно тот момент "поставку
// приняли", который нужен, и не зависит от того, как называется конкретный
// статус отдельного заказа. Берём created_at заказа и wb_accepted_at
// поставки, в которую он попал (join по wb_orders.wb_supply_id =
// shipments.external_id) - заказы, ещё не попавшие в принятую поставку,
// просто не участвуют в расчёте (см. processed).
// -----------------------------------------------------------------------------

const SPEED_BUCKETS = [
  { key: 'h0_13',  label: '0–13 ч (макс. скидка)',   maxHours: 13 },
  { key: 'h13_42', label: '13–42 ч (скидка)',         maxHours: 42 },
  { key: 'h42_48', label: '42–48 ч (база)',           maxHours: 48 },
  { key: 'h48_54', label: '48–54 ч (штраф +0.30 п.п./ч)', maxHours: 54 },
  { key: 'h54_60', label: '54–60 ч (штраф +0.35 п.п./ч)', maxHours: 60 },
  { key: 'h60plus',label: '>60 ч (штраф +0.45 п.п./ч)',   maxHours: Infinity },
];

function bucketForHours(hours) {
  for (const b of SPEED_BUCKETS) if (hours <= b.maxHours) return b.key;
  return 'h60plus';
}

async function getProcessingSpeed({ tenantId, clientId = null, mpAccountId = null, dateFrom, dateTo }) {
  const params = [tenantId, dateFrom, dateTo];
  const conds = ['wo.tenant_id=$1', 'wo.created_at >= $2', 'wo.created_at < $3'];
  let idx = 4;
  if (clientId) { conds.push(`ma.client_id=$${idx++}`); params.push(clientId); }
  if (mpAccountId) { conds.push(`wo.mp_account_id=$${idx++}`); params.push(mpAccountId); }

  // wb_accepted_at ставится, когда WB подтвердил приём ВСЕЙ поставки (см.
  // комментарий выше) - джойним заказ к его поставке через wb_supply_id.
  // sold_at по-прежнему берём из истории статусов заказа (там 'sold' -
  // надёжный, честно проверенный на реальных данных статус, см. диагностику
  // 28.08.2026 - в отличие от "какой статус означает именно приёмку", тут
  // сомнений не было).
  const r = await query(
    `SELECT wo.created_at, s.wb_accepted_at AS accepted_at, sold.observed_at AS sold_at
     FROM wms.wb_orders wo
     JOIN wms.mp_accounts ma ON ma.id = wo.mp_account_id
     LEFT JOIN wms.shipments s ON s.tenant_id = wo.tenant_id AND s.external_id = wo.wb_supply_id
     LEFT JOIN LATERAL (
       SELECT observed_at FROM wms.wb_order_status_events e2
       WHERE e2.mp_account_id = wo.mp_account_id AND e2.wb_order_id = wo.wb_order_id AND e2.wb_status = 'sold'
       ORDER BY observed_at ASC LIMIT 1
     ) sold ON TRUE
     WHERE ${conds.join(' AND ')}`,
    params
  );

  const buckets = {};
  for (const b of SPEED_BUCKETS) buckets[b.key] = 0;
  let onTime = 0, processed = 0;
  let sumToWb = 0, cntToWb = 0;
  let sumWbToSold = 0, cntWbToSold = 0;
  let sumToSold = 0, cntToSold = 0;

  for (const row of r.rows) {
    if (row.accepted_at) {
      const hoursToWb = (new Date(row.accepted_at) - new Date(row.created_at)) / 3600000;
      buckets[bucketForHours(hoursToWb)]++;
      processed++;
      if (hoursToWb <= 48) onTime++;
      sumToWb += hoursToWb; cntToWb++;

      if (row.sold_at) {
        const hoursWbToSold = (new Date(row.sold_at) - new Date(row.accepted_at)) / 3600000;
        if (hoursWbToSold >= 0) { sumWbToSold += hoursWbToSold; cntWbToSold++; }
        const hoursToSold = (new Date(row.sold_at) - new Date(row.created_at)) / 3600000;
        sumToSold += hoursToSold; cntToSold++;
      }
    }
  }

  return {
    processed, // сколько заказов из периода уже в принятой WB поставке (по ним считаем сроки)
    on_time_rate: processed > 0 ? (onTime / processed) * 100 : null,
    avg_hours_to_wb:      cntToWb > 0     ? sumToWb / cntToWb          : null,
    avg_hours_wb_to_sold: cntWbToSold > 0 ? sumWbToSold / cntWbToSold  : null,
    avg_hours_to_sold:    cntToSold > 0   ? sumToSold / cntToSold      : null,
    buckets: SPEED_BUCKETS.map(b => ({
      key: b.key, label: b.label, qty: buckets[b.key],
      pct: processed > 0 ? (buckets[b.key] / processed) * 100 : 0,
    })),
  };
}

/** Тот же расчёт "сроки до передачи в WB", но в разрезе по клиентам - чтобы
 *  видеть, кто из клиентов регулярно затягивает сборку и получает штраф к
 *  комиссии WB. Только для персонала (в seller-роутере такого нет - там
 *  клиент видит только себя, разрез не нужен). Корзины те же (SPEED_BUCKETS),
 *  что и в общем виджете - только каждая строка теперь на одного клиента. */
async function getProcessingSpeedByClient({ tenantId, dateFrom, dateTo }) {
  // wb_accepted_at поставки - см. подробное объяснение в getProcessingSpeed()
  // выше про то, почему считаем именно так (а не по wbStatus заказа).
  const r = await query(
    `SELECT ma.client_id, c.client_name, wo.created_at, s.wb_accepted_at AS accepted_at
     FROM wms.wb_orders wo
     JOIN wms.mp_accounts ma ON ma.id = wo.mp_account_id
     JOIN wms.clients c ON c.id = ma.client_id
     LEFT JOIN wms.shipments s ON s.tenant_id = wo.tenant_id AND s.external_id = wo.wb_supply_id
     WHERE wo.tenant_id=$1 AND wo.created_at >= $2 AND wo.created_at < $3`,
    [tenantId, dateFrom, dateTo]
  );

  const byClient = new Map();
  for (const row of r.rows) {
    if (!row.accepted_at) continue; // поставка ещё не принята WB - в сроки пока не считаем
    const hoursToWb = (new Date(row.accepted_at) - new Date(row.created_at)) / 3600000;
    if (!byClient.has(row.client_id)) {
      const buckets = {};
      for (const b of SPEED_BUCKETS) buckets[b.key] = 0;
      byClient.set(row.client_id, { client_id: row.client_id, client_name: row.client_name, processed: 0, onTime: 0, sumHours: 0, buckets });
    }
    const agg = byClient.get(row.client_id);
    agg.processed++;
    agg.sumHours += hoursToWb;
    if (hoursToWb <= 48) agg.onTime++;
    agg.buckets[bucketForHours(hoursToWb)]++;
  }

  const clients = [...byClient.values()].map(a => ({
    client_id: a.client_id,
    client_name: a.client_name,
    processed: a.processed,
    on_time_rate: (a.onTime / a.processed) * 100,
    avg_hours_to_wb: a.sumHours / a.processed,
    buckets: SPEED_BUCKETS.map(b => ({
      key: b.key, label: b.label, qty: a.buckets[b.key],
      pct: (a.buckets[b.key] / a.processed) * 100,
    })),
  }));
  // Худшие (по доле "вовремя") - первыми, чтобы сразу было видно, кого подтянуть.
  clients.sort((x, y) => x.on_time_rate - y.on_time_rate);

  return { clients };
}

module.exports = {
  refreshWbStatusesForAccount,
  refreshWbStatusesForTenant,
  getFbsSummary,
  getProcessingSpeed,
  getProcessingSpeedByClient,
};
