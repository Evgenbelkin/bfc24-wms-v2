'use strict';

const { query, transaction } = require('../../config/database');
const wbClient = require('./wb.client');
const { NotFoundError, ValidationError } = require('../../utils/errors');
const logger = require('../../utils/logger');

// =============================================================================
// WB Service — переиспользуемая логика синхронизации, общая для:
//  - ручной кнопки "Синхронизировать заказы" (один аккаунт)
//  - ручной кнопки "Синхронизировать все" (все аккаунты тенанта)
//  - фонового автосинка (server/src/jobs/wbAutoSync.js)
// =============================================================================

// Дебаунс pre-push синка заказов (см. distributeStockForAccount) — при
// высоком темпе событий (приёмка/возврат/инвентаризация одну за другой у
// клиента с большим потоком заказов) синхронный поход в WB API + апсерт
// перед КАЖДЫМ пересчётом остатка стал бы дорогим (лишние запросы к WB,
// лишняя нагрузка на БД на каждое действие сборщика/приёмщика). Свежесть
// важна для правильности расчёта, но секунд в 20 запаса вполне достаточно -
// WB не продаёт настолько быстро, чтобы за 20 секунд накопилась ощутимая
// ошибка, а нагрузка при этом падает на порядки при частых событиях подряд.
// In-memory (не переживает рестарт процесса) - это осознанно: не критичная
// для целостности данных оптимизация, а не источник истины. PM2 держит
// каждое приложение в одном process (fork, не cluster) - общий Map безопасен.
const PRE_SYNC_DEBOUNCE_MS = 20_000;
const lastPreSyncAtByAccount = new Map();

async function getMpAccount(tenantId, accountId) {
  const r = await query(
    `SELECT id, client_id, api_token, marketplace FROM wms.mp_accounts
     WHERE id=$1 AND tenant_id=$2 AND is_active=TRUE LIMIT 1`,
    [accountId, tenantId]
  );
  if (r.rowCount === 0) throw new NotFoundError('MP Account', accountId);
  const acc = r.rows[0];
  if (!acc.api_token) throw new ValidationError(`MP account ${accountId} has no api_token`);
  return acc;
}

/** Активные WB-аккаунты тенанта с заполненным токеном */
async function listActiveAccounts(tenantId) {
  const r = await query(
    `SELECT id, client_id, api_token, account_name FROM wms.mp_accounts
     WHERE tenant_id=$1 AND is_active=TRUE AND marketplace='wb'
       AND api_token IS NOT NULL AND length(trim(api_token))>0`,
    [tenantId]
  );
  return r.rows;
}

/** Синхронизация новых заказов по одному аккаунту (acc уже должен содержать api_token).
 *
 *  Помимо сохранения новых заказов, здесь же живёт РЕКОНСИЛИАЦИЯ: WB отдаёт в
 *  /api/v3/orders/new только те заказы, которые ВСЁ ЕЩЁ ждут сборки. Если владелец
 *  кабинета вручную сгруппировал заказ в поставку прямо в своём ЛК WB (в обход
 *  нашего софта), этот заказ просто перестаёт приходить в ответе — а наша старая
 *  запись в БД как была 'new' без wb_supply_id, так и остаётся, будто заказ всё ещё
 *  ждёт нас. Раньше это "зависшее" состояние ничем не лечилось: такой заказ мог
 *  попасть в "Сформировать волну" и упасть с ошибкой WB (заказ уже в другой поставке).
 *  Теперь при КАЖДОЙ синхронизации (ручной, "синхронизировать всё", фоновой раз в
 *  15 минут) мы сверяем, какие из наших "new"-заказов пропали из свежего ответа WB,
 *  и помечаем их status='external' — это выводит их из очереди на волну и делает
 *  видимыми в фильтре как "Занято в кабинете WB", вместо того чтобы бесконечно висеть. */
// Сколько строк за один INSERT — на клиентов с большим потоком заказов
// (обсуждали: у некоторых будет по ~20 000 заказов/сутки) один запрос на
// заказ означал бы тысячи последовательных round-trip'ов к БД на каждый
// синк. Батчим по ROWS_PER_INSERT строк за один INSERT ... VALUES(...),(...)
// - на 16 колонках/строку это ~3200 параметров на батч, далеко от лимита
// Postgres (65535) и укладывается в разумный размер одного запроса.
const ORDERS_INSERT_BATCH = 200;

async function fetchAndUpsertOrders({ tenantId, accountId, apiToken }) {
  const orders = await wbClient.fetchNewOrders(apiToken);

  let saved = 0;
  const freshIds = [];
  const touchedBarcodes = new Set();
  const rows = [];
  for (const o of orders) {
    const wbOrderId = o.id || o.odid || o.orderId;
    if (!wbOrderId) continue;
    freshIds.push(Number(wbOrderId));
    const barcode = Array.isArray(o.skus) ? o.skus[0] : (o.barcode || null);
    if (barcode) touchedBarcodes.add(barcode);
    rows.push([
      tenantId, accountId, wbOrderId,
      o.nmId||o.nmID||null, o.chrtId||null, o.article||null, barcode,
      o.warehouseId||null, (o.offices||[]).join(',')||o.warehouseName||null,
      o.regionName||null, o.price||null, o.convertedPrice||null, o.currencyCode||null,
      'new', o.createdAt||null,
      JSON.stringify(o),
      o.rid||null, // связующий ключ с Statistics API (см. 053_wb_orders_region_stats.sql)
    ]);
  }

  const COLS = 17;
  for (let i = 0; i < rows.length; i += ORDERS_INSERT_BATCH) {
    const chunk = rows.slice(i, i + ORDERS_INSERT_BATCH);
    const params = [];
    const valuesSql = chunk.map((row, ri) => {
      const base = ri * COLS;
      params.push(...row);
      const placeholders = row.map((_, ci) => `$${base + ci + 1}`).join(',');
      return `(${placeholders})`;
    }).join(',');

    await query(
      // ВАЖНО (найдено по жалобе "в 'Новых' заказах видно то, что уже в
      // поставке"): WB в /api/v3/orders/new продолжает отдавать заказ ещё
      // какое-то время ПОСЛЕ того как он добавлен в поставку (wb_supply_id
      // проставлен, статус у нас уже 'confirm') - не только пока он реально
      // "новый". Раньше ON CONFLICT слепо перезаписывал status=EXCLUDED.status
      // (буквально строка 'new' из VALUES) при КАЖДОЙ синхронизации - это
      // откатывало уже продвинутый статус ('confirm'/'shipped'/'external'/
      // 'complete'/'cancel') обратно на 'new', пока wb_supply_id оставался
      // на месте (он в UPDATE не участвует). Раньше это било редко (только
      // по фоновому крону раз в 15 минут/ручной синк), но после добавления
      // pre-push синка перед КАЖДЫМ пересчётом остатка (см. distributeStockForAccount)
      // стало происходить на порядок чаще - отсюда и жалоба. status на
      // конфликте теперь не трогаем вообще - "новым" он проставляется только
      // при первой вставке заказа, которого мы раньше не видели.
      `INSERT INTO wms.wb_orders
         (tenant_id,mp_account_id,wb_order_id,nm_id,chrt_id,article,barcode,
          warehouse_id,warehouse_name,region_name,price,converted_price,currency_code,
          status,created_at,raw,rid)
       VALUES ${valuesSql}
       ON CONFLICT(mp_account_id,wb_order_id) DO UPDATE SET
         fetched_at=NOW(), raw=EXCLUDED.raw,
         rid=COALESCE(wms.wb_orders.rid, EXCLUDED.rid)`,
      params
    );
    saved += chunk.length;
  }

  // Реконсилиация: наши "new"-заказы без поставки, которых больше нет в свежем
  // ответе WB — значит их забрали в поставку/отменили не через нас.
  const reconciled = await query(
    `UPDATE wms.wb_orders SET status='external', fetched_at=NOW()
     WHERE tenant_id=$1 AND mp_account_id=$2 AND status='new' AND wb_supply_id IS NULL
       AND NOT (wb_order_id = ANY($3::bigint[]))
     RETURNING wb_order_id`,
    [tenantId, accountId, freshIds]
  );

  return { fetched: orders.length, saved, marked_external: reconciled.rowCount, touchedBarcodes };
}

/** Синхронизация новых заказов по одному аккаунту (acc уже должен содержать api_token).
 *
 *  Помимо сохранения новых заказов, здесь же живёт РЕКОНСИЛИАЦИЯ: WB отдаёт в
 *  /api/v3/orders/new только те заказы, которые ВСЁ ЕЩЁ ждут сборки. Если владелец
 *  кабинета вручную сгруппировал заказ в поставку прямо в своём ЛК WB (в обход
 *  нашего софта), этот заказ просто перестаёт приходить в ответе — а наша старая
 *  запись в БД как была 'new' без wb_supply_id, так и остаётся, будто заказ всё ещё
 *  ждёт нас. Раньше это "зависшее" состояние ничем не лечилось: такой заказ мог
 *  попасть в "Сформировать волну" и упасть с ошибкой WB (заказ уже в другой поставке).
 *  Теперь при КАЖДОЙ синхронизации (ручной, "синхронизировать всё", фоновой раз в
 *  15 минут) мы сверяем, какие из наших "new"-заказов пропали из свежего ответа WB,
 *  и помечаем их status='external' — это выводит их из очереди на волну и делает
 *  видимыми в фильтре как "Занято в кабинете WB", вместо того чтобы бесконечно висеть. */
async function syncOrdersForAccount({ tenantId, accountId, apiToken, clientId = null }) {
  const { fetched, saved, marked_external, touchedBarcodes } =
    await fetchAndUpsertOrders({ tenantId, accountId, apiToken });

  // ПРАВКА 29.08.2026 (возврат реактивного пуша после разбора "Сверки
  // остатков" - расхождения +1/+2 "риск оверселла" по многим SKU клиента
  // Yellow Fish): правка от 28.08.2026 (см. предыдущую версию этого
  // комментария в истории git, коммит fdb901d) убрала этот вызов, исходя из
  // допущения "WB уже уменьшает показываемый остаток на своей стороне в
  // момент создания заказа". Проверено и это НЕВЕРНО именно для эндпоинта
  // /api/v3/stocks (см. fetchFbsStocks/updateFbsStocks в wb.client.js) - это
  // не живой остаток, а декларативное значение продавца ("SET"), WB его сам
  // не декрементирует. Пока мы не пушим - в WB висит СТАРОЕ (более высокое)
  // число, и окно риска оверселла растягивается до следующего реального
  // пуша - раньше это было до 8 часов (контрольный пересчёт,
  // WB_STOCK_SYNC_INTERVAL_MINUTES).
  //
  // Возвращаем пуш, но точечно - только по barcode, реально затронутым ЭТИМ
  // тиком синка (touchedBarcodes из fetchAndUpsertOrders), а не по всему
  // ассортименту клиента: полный пересчёт по одному событию - это и есть
  // причина другого, более старого инцидента (2006784216833, Yellow Fish,
  // 11-12.08.2026, см. комментарий над distributeStockForAccount) - задевает
  // чужие товары, у которых WMS ещё не в курсе про уже принятые, но не
  // собранные заказы, и в WB улетает завышенное число.
  //
  // Нагрузка на WB API при высоком темпе заказов (аргумент правки 28.08,
  // актуален для клиентов ~20 000 заказов/сутки) не воспроизводится заново:
  // touchedBarcodes - это Set, т.е. один пуш на клиента за тик синка (раз в
  // 15 минут, WB_AUTO_SYNC_INTERVAL_MINUTES) с уже задедупленным списком
  // barcode, а не пуш на каждый отдельный заказ.
  if (clientId && touchedBarcodes && touchedBarcodes.size > 0) {
    triggerRedistributionForClient({ tenantId, clientId, barcodes: Array.from(touchedBarcodes) });
  }
  return { fetched, saved, marked_external };
}

/** Синхронизировать заказы по ВСЕМ активным WB-аккаунтам тенанта (кнопка "Синхронизировать все") */
async function syncAllAccountsForTenant(tenantId) {
  const accounts = await listActiveAccounts(tenantId);
  const results = [];
  for (const acc of accounts) {
    try {
      const r = await syncOrdersForAccount({ tenantId, accountId: acc.id, apiToken: acc.api_token, clientId: acc.client_id });
      results.push({ account_id: acc.id, account_name: acc.account_name, ok: true, ...r });
    } catch (e) {
      logger.error({ err: e, tenantId, accountId: acc.id }, 'WB sync-all: account sync failed');
      results.push({ account_id: acc.id, account_name: acc.account_name, ok: false, error: e.message });
    }
  }
  return results;
}

const STATS_SYNC_LOOKBACK_DAYS = 90; // Statistics API хранит историю не больше 90 дней

/** Все активные WB-аккаунты по ВСЕМ тенантам с включённым модулем
 *  wb_integration - в отличие от listActiveAccounts (один тенант), нужен
 *  плоский список сразу для фоновой очереди wbStatsRegionSync.js (см.
 *  комментарий про лимит 1 запрос/минуту у Statistics API в
 *  wb.client.js::fetchStatisticsOrders). */
async function listAllWbAccountsForStatsSync() {
  const r = await query(
    `SELECT ma.id, ma.tenant_id, ma.api_token, ma.account_name, ma.settings
     FROM wms.mp_accounts ma
     JOIN platform.tenants t ON t.id = ma.tenant_id AND t.status IN ('trial','active')
     JOIN platform.tenant_modules tm ON tm.tenant_id = t.id AND tm.module_code = 'wb_integration'
     WHERE ma.marketplace='wb' AND ma.is_active=TRUE AND ma.api_token IS NOT NULL
     ORDER BY ma.id`
  );
  return r.rows;
}

/** Синхронизация региона/округа/СЦ WB на заказах ОДНОГО аккаунта через
 *  Statistics API (см. wbClient.fetchStatisticsOrders - лимит 1 запрос/минуту
 *  у WB, поэтому вызывается по одному аккаунту за тик из wbStatsRegionSync.js,
 *  не для всех сразу). Матчинг заказов - по srid=rid (подтверждено на живых
 *  данных 30.08.2026, см. комментарий в 053_wb_orders_region_stats.sql).
 *  Курсор (lastChangeDate последней полученной строки) хранится в
 *  mp_accounts.settings->stats_sync, чтобы каждый следующий тик забирал
 *  только новое, а не всю историю заново - как и предписывает документация
 *  WB для пагинации этого метода. */
async function syncStatsRegionForAccount({ tenantId, accountId, apiToken, settings }) {
  const cursorRaw = settings?.stats_sync?.last_change_date;
  const dateFrom = cursorRaw
    || new Date(Date.now() - STATS_SYNC_LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString();

  const orders = await wbClient.fetchStatisticsOrders(apiToken, dateFrom);
  if (!orders.length) {
    return { fetched: 0, matched: 0 };
  }

  const srids = [], regions = [], oblasts = [], countries = [], scNames = [], orderDates = [];
  for (const o of orders) {
    if (!o.srid) continue;
    srids.push(o.srid);
    regions.push(o.regionName || null);
    oblasts.push(o.oblastOkrugName || null);
    countries.push(o.countryName || null);
    scNames.push(o.warehouseName || null);
    // WB отдаёт наивное время без таймзоны - по документации это московское
    // время (UTC+3, без перехода на летнее/зимнее с 2014 года).
    orderDates.push(o.date ? `${o.date}+03:00` : null);
  }

  const upd = await query(
    `UPDATE wms.wb_orders wo
     SET region_name = v.region_name,
         oblast_okrug_name = v.oblast_okrug_name,
         country_name = v.country_name,
         wb_sc_name = v.wb_sc_name,
         stats_order_date = v.stats_order_date,
         stats_synced_at = NOW()
     FROM (
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::timestamptz[])
         AS t(srid, region_name, oblast_okrug_name, country_name, wb_sc_name, stats_order_date)
     ) v
     WHERE wo.mp_account_id = $7 AND wo.rid = v.srid`,
    [srids, regions, oblasts, countries, scNames, orderDates, accountId]
  );

  const lastRow = orders[orders.length - 1];
  const nextCursor = lastRow?.lastChangeDate || dateFrom;
  await query(
    `UPDATE wms.mp_accounts
     SET settings = jsonb_set(COALESCE(settings,'{}'::jsonb), '{stats_sync}',
       jsonb_build_object('last_change_date', $2::text, 'updated_at', NOW()::text), true)
     WHERE id = $1`,
    [accountId, nextCursor]
  );

  return { fetched: orders.length, matched: upd.rowCount, nextCursor };
}

/** Проверяет через WB API, принял ли WB физически заказы отгрузок, которые у
 *  нас всё ещё висят в status='in_transit' (скан QR поставки отгрузчиком уже
 *  сделан, но подтверждения от самой WB мы никогда не спрашивали — раньше
 *  счётчик "в пути" на табло копился бесконечно, т.к. ничего не переводило
 *  отгрузку дальше). wbStatus='waiting' у заказа означает "продавец
 *  подтвердил, WB ещё не получил физически" — как только у ВСЕХ заказов
 *  поставки wbStatus вышел из 'waiting' (sorted/sold/и т.п. — WB реально
 *  принял), переводим отгрузку в status='done' локально. */
async function syncDeliveryStatusForTenant(tenantId) {
  // Самолечение (добавлено 28.08.2026, инцидент с массовым "не ушло в WB" по
  // множеству клиентов одновременно): 'confirm'-заказы, чья поставка УЖЕ
  // физически отгружена ('in_transit' или 'done') - неважно, каким путём это
  // произошло (реакция на переход in_transit->done ниже по этой же функции,
  // подтверждение отгрузки - см. shipping.service.js, которое теперь само
  // закрывает 'confirm'->'shipped' в момент физической отгрузки, ручное
  // подтверждение доставки MANUAL-отгрузки, либо поставка уехала ещё ДО того
  // как вычитание 'confirm' из остатка вообще появилось) - таким заказам
  // следующий вызов этой функции уже не поможет сам по себе: ветка ниже
  // переводит 'confirm'->'shipped' только В МОМЕНТ обнаружения перехода
  // 'in_transit'->'done', а если поставка уже физически уехала ('in_transit')
  // или уже 'done' - этот момент мог уже наступить или никогда не наступить
  // повторно, и заказ навсегда зависает в 'confirm', бесконечно вычитаясь из
  // остатка, доступного для отправки в WB (см. newOrdersByBarcode в
  // distributeStockForAccount). ВАЖНО: 'in_transit' тоже считается "уже
  // отгружено", а не только 'done' - реальное списание остатка происходит в
  // picking (до in_transit), к моменту in_transit товар уже физически ушёл
  // со склада независимо от того, подтвердил ли это ещё сам WB - см.
  // обсуждение 28.08.2026. Именно так по множеству клиентов накопилось
  // расхождение "в WMS есть, в WB нет" (обнаружено 27.08.2026, "Сверка
  // остатков" смотри wb-stock-reconcile.js). Закрываем такие заказы здесь же,
  // при каждом прогоне (идемпотентно - WHERE status='confirm' сам собой
  // перестаёт находить уже закрытые строки), и сразу пересчитываем/пушим
  // освободившийся остаток по затронутым штрихкодам, а не ждём случайного
  // следующего события или редкого полного пересчёта (раз в 8 часов).
  const healedRes = await query(
    `UPDATE wms.wb_orders wo
     SET status='shipped'
     FROM wms.shipments s
     WHERE wo.tenant_id=$1 AND wo.status='confirm'
       AND s.tenant_id=wo.tenant_id AND s.external_id=wo.wb_supply_id AND s.status IN ('in_transit', 'done')
     RETURNING wo.barcode, wo.mp_account_id`,
    [tenantId]
  );
  if (healedRes.rowCount > 0) {
    const accIds = [...new Set(healedRes.rows.map(r => r.mp_account_id))];
    const accRes = await query(`SELECT id, client_id FROM wms.mp_accounts WHERE id = ANY($1::int[])`, [accIds]);
    const accToClient = new Map(accRes.rows.map(r => [r.id, r.client_id]));
    const byClient = new Map();
    for (const row of healedRes.rows) {
      const clientId = accToClient.get(row.mp_account_id);
      if (!clientId || !row.barcode) continue;
      if (!byClient.has(clientId)) byClient.set(clientId, new Set());
      byClient.get(clientId).add(row.barcode);
    }
    for (const [clientId, barcodes] of byClient.entries()) {
      triggerRedistributionForClient({ tenantId, clientId, barcodes: Array.from(barcodes) });
    }
    logger.info(
      { tenantId, healed: healedRes.rowCount, clients: byClient.size },
      'syncDeliveryStatusForTenant: закрыты зависшие confirm-заказы (отгрузка уже done) и запущен пересчёт остатка по затронутым штрихкодам'
    );
  }

  const shipRes = await query(
    `SELECT id, external_id FROM wms.shipments WHERE tenant_id=$1 AND status='in_transit'`,
    [tenantId]
  );
  if (shipRes.rowCount === 0) return { checked: 0, updated: 0 };

  let updated = 0;
  for (const shipment of shipRes.rows) {
    try {
      const ordersRes = await query(
        `SELECT wo.wb_order_id, ma.api_token
         FROM wms.wb_orders wo
         JOIN wms.mp_accounts ma ON ma.id=wo.mp_account_id
         WHERE wo.tenant_id=$1 AND wo.wb_supply_id=$2 AND ma.api_token IS NOT NULL`,
        [tenantId, shipment.external_id]
      );
      if (ordersRes.rowCount === 0) continue; // ещё не досинхронизировано/нет токена — попробуем в следующий прогон

      // Поставка всегда привязана к одному WB-аккаунту, поэтому один токен на все её заказы.
      const token = ordersRes.rows[0].api_token;
      const orderIds = ordersRes.rows.map(r => Number(r.wb_order_id));

      const statuses = await wbClient.fetchOrderStatuses(token, orderIds);
      if (!statuses.length) continue;

      const allAccepted = statuses.every(s => s.wbStatus && s.wbStatus !== 'waiting');
      if (allAccepted) {
        await query(
          `UPDATE wms.shipments SET status='done', wb_accepted_at=NOW(), updated_at=NOW() WHERE id=$1`,
          [shipment.id]
        );
        // Закрываем цепочку статусов заказа: 'confirm' выставляется один раз при
        // добавлении в поставку (см. /generate-wave) и без этого шага НИКОГДА не
        // менялся дальше - даже после реального отъезда поставки. Из-за этого
        // distributeStockForAccount не мог считать 'confirm'-заказы "ещё
        // зарезервированными" (это привело бы к вечному занижению остатка) и
        // учитывал только 'new' - а окно между "заказ добавлен в поставку" и
        // "WB физически принял поставку" оставалось совсем неучтённым: остаток
        // в этот момент казался WB'у полностью свободным, хотя единицы уже
        // обещаны confirm'нутым заказам. См. инцидент с 2006784216833 (26.08.2026).
        // Теперь, когда WB подтвердил приёмку, помечаем 'shipped' - и можем
        // спокойно вычитать 'confirm' тоже (см. distributeStockForAccount),
        // не рискуя зависнуть навсегда.
        await query(
          `UPDATE wms.wb_orders SET status='shipped' WHERE tenant_id=$1 AND wb_supply_id=$2 AND status='confirm'`,
          [tenantId, shipment.external_id]
        );
        updated++;
      }
    } catch (e) {
      logger.warn({ err: e.message, tenantId, shipmentId: shipment.id }, 'WB delivery-status check failed for shipment (non-fatal)');
    }
  }
  return { checked: shipRes.rowCount, updated };
}

// =============================================================================
// Автораспределение остатков по складам WB (собственные склады продавца, FBS)
//
// Идея: клиент хранит товар у нас на складе, а на WB зарегистрировано
// несколько его собственных складов (например Подольск/Видное), между
// которыми раньше приходилось руками раскидывать остатки в личном кабинете
// WB. Мы уже физически знаем, сколько чего есть на складе (wms.stock_balances)
// - осталось только: 1) знать вес/долю каждого склада WB (задаёт клиент,
// wms.wb_seller_warehouses.weight), 2) посчитать доступное к раздаче
// количество (с резервом, который не раздаём никуда) и 3) отправить в WB
// через уже готовый updateFbsStocks().
//
// Когда пересчитывать - НЕ после каждого шага picking/packing/shipping: сам
// WB уже резервирует остаток на своей стороне в момент создания заказа
// (раньше, чем мы вообще узнаём о заказе) - у нас и у него счётчики и так
// разъезжаются одинаково в обе стороны. Пересчёт нужен только когда меняется
// ИТОГОВОЕ количество на складе способом, о котором WB не мог узнать сам:
// приёмка нового товара, инвентаризация/списание, и смена клиентом
// весов/резерва. См. вызовы triggerRedistributionForClient() в
// receiving.service.js, inventory.service.js, seller.router.js.
// =============================================================================

/** Подтянуть список складов продавца из WB (/api/v3/warehouses) в нашу таблицу.
 *  Новый склад сохраняется с weight=1.0 (дефолт колонки) - это автоматически
 *  даёт РАВНОМЕРНОЕ распределение между складами, пока клиент не задаст свои
 *  проценты вручную (веса нормализуются по сумме при расчёте, не обязаны
 *  быть именно процентами). Склад, который клиент убрал у себя в WB, помечаем
 *  is_active=false, а не удаляем - настройки (weight/is_enabled_for_dist) не
 *  теряются, если он вернётся. */
async function syncSellerWarehouses({ tenantId, mpAccountId }) {
  const acc = await getMpAccount(tenantId, mpAccountId);
  const warehouses = await wbClient.fetchSellerWarehouses(acc.api_token);

  let synced = 0;
  for (const w of warehouses) {
    if (!w || w.id == null) continue;
    const warehouseCode = String(w.id);
    await query(
      `INSERT INTO wms.wb_seller_warehouses
         (tenant_id, mp_account_id, wb_warehouse_id, warehouse_code, warehouse_name, is_active, source, last_synced_at)
       VALUES ($1,$2,$3,$4,$5,TRUE,'wb_api',NOW())
       ON CONFLICT (mp_account_id, warehouse_code)
       DO UPDATE SET warehouse_name=$5, is_active=TRUE, wb_warehouse_id=$3, last_synced_at=NOW(), updated_at=NOW()`,
      [tenantId, mpAccountId, w.id, warehouseCode, w.name || null]
    );
    synced++;
  }

  const currentCodes = warehouses.filter(w => w && w.id != null).map(w => String(w.id));
  if (currentCodes.length > 0) {
    await query(
      `UPDATE wms.wb_seller_warehouses SET is_active=FALSE, updated_at=NOW()
       WHERE mp_account_id=$1 AND NOT (warehouse_code = ANY($2::text[]))`,
      [mpAccountId, currentCodes]
    );
  }
  return { synced, total: warehouses.length };
}

/** Пересчитать и отправить в WB распределение остатков по складам для ОДНОГО
 *  аккаунта. Возвращает сводку (для лога/ручного вызова из панели), сам по
 *  себе не бросает наружу ошибки похода в WB API по отдельным складам -
 *  каждый склад пушится независимо, один упавший не должен блокировать
 *  остальные.
 *
 *  barcodes (опционально) - пересчитать и отправить ТОЛЬКО эти штрихкоды,
 *  а не весь ассортимент аккаунта. Важно для приёмки/инвентаризации ОДНОГО
 *  товара: раньше событие по одному товару запускало полный пересчёт ВСЕХ
 *  штрихкодов клиента, а это пересчитывает qty_available и по другим товарам,
 *  у которых в этот момент могут быть уже принятые WB заказы, ещё не
 *  собранные в волну (резерв в WMS проставляется только при генерации волны
 *  сборки, а не при синке заказа) - остаток по НИМ в WMS ещё "полный", и
 *  полный пересчёт заново отправляет в WB завышенное число, фактически
 *  возвращая то, что WB уже продал. Точечный пересчёт по одному
 *  затронутому штрихкоду эту дыру не открывает. Полный пересчёт по всему
 *  аккаунту остаётся - но только по расписанию (wbStockSync, редко) и при
 *  смене клиентом весов/резерва (там по-другому никак, меняется всё сразу). */
async function distributeStockForAccount({ tenantId, mpAccountId, barcodes = null }) {
  const accRes = await query(
    `SELECT id, client_id, api_token, settings FROM wms.mp_accounts
     WHERE id=$1 AND tenant_id=$2 AND is_active=TRUE AND marketplace='wb'`,
    [mpAccountId, tenantId]
  );
  if (accRes.rowCount === 0) return { skipped: true, reason: 'account_not_found' };
  const account = accRes.rows[0];
  if (!account.api_token) return { skipped: true, reason: 'no_api_token' };

  // Свежий подсинк заказов ПЕРЕД расчётом (а не полагаемся на то, что уже
  // лежит в wb_orders после последнего фонового синка). Раньше окно риска
  // было ровно в промежуток между "покупатель заказал на WB" и "фоновый
  // wbAutoSync это увидел" (до 15 минут, WB_AUTO_SYNC_INTERVAL_MINUTES) - всё
  // это время distributeStockForAccount мог не знать о свежем заказе и
  // отправить в WB завышенный остаток. Теперь сам расчёт всегда тянет
  // актуальный список заказов непосредственно перед вычитанием - окно риска
  // схлопывается до времени одного похода в WB API (секунды), а не до
  // интервала фонового крона. Мягкий отказ: если WB API недоступен прямо
  // сейчас, не блокируем весь пересчёт целиком - считаем по тому, что уже
  // есть в базе (это не хуже, чем было раньше).
  const lastPreSync = lastPreSyncAtByAccount.get(mpAccountId) || 0;
  if (Date.now() - lastPreSync >= PRE_SYNC_DEBOUNCE_MS) {
    try {
      await fetchAndUpsertOrders({ tenantId, accountId: mpAccountId, apiToken: account.api_token });
      lastPreSyncAtByAccount.set(mpAccountId, Date.now());
    } catch (e) {
      logger.warn({ err: e, tenantId, mpAccountId }, 'distributeStockForAccount: pre-sync заказов не удался, считаем по данным из БД');
    }
  }

  // Рубильник "не отправлять остатки в WB для этого аккаунта" — нужен,
  // например, когда клиент тестирует систему и не хочет, чтобы WMS автоматом
  // раскидывала остатки по складам WB, пока он сам обнулил их в кабинете.
  // Один этот guard перекрывает и плановый пересчёт (wbStockSync, по
  // расписанию), и событийный (triggerRedistributionForClient при приёмке/
  // инвентаризации) — оба идут через эту же функцию, отдельно гасить нигде
  // больше не нужно.
  if (account.settings && account.settings.stock_sync_disabled) {
    return { skipped: true, reason: 'stock_sync_disabled_by_admin' };
  }

  const whRes = await query(
    `SELECT wb_warehouse_id, warehouse_code, weight FROM wms.wb_seller_warehouses
     WHERE mp_account_id=$1 AND is_active=TRUE AND is_enabled_for_dist=TRUE AND weight > 0`,
    [mpAccountId]
  );
  const warehouses = whRes.rows;
  if (warehouses.length === 0) return { skipped: true, reason: 'no_enabled_warehouses' };

  const totalWeight = warehouses.reduce((s, w) => s + Number(w.weight), 0);
  if (totalWeight <= 0) return { skipped: true, reason: 'zero_total_weight' };

  const settings = account.settings || {};
  const reservePct = Number.isFinite(Number(settings.stock_reserve_pct)) ? Number(settings.stock_reserve_pct) : 5;

  // Только штрихкоды, реально зарегистрированные у WB под этим аккаунтом -
  // иначе рискуем пушить в WB товары, которых там вообще нет в карточках
  // (например клиент хранит у нас что-то не для WB).
  // ВАЖНО: раньше здесь был HAVING SUM(...) > 0 — товары, у которых остаток
  // дошёл ровно до нуля, выпадали из пересчёта НАВСЕГДА (barcode просто не
  // попадал в цикл ниже), и в WB никогда не уходила команда "поставь 0".
  // Последнее переданное ненулевое количество так и висело на стороне WB
  // сколько угодно долго, WB продолжал его продавать поверх реального нуля -
  // конкретный кейс, который это вскрыл: 2006784216833 (11-12.08.2026).
  // Теперь обнулившиеся товары остаются в выборке и явно уходят в WB как 0.
  const barcodesFilter = Array.isArray(barcodes) && barcodes.length > 0
    ? ` AND wib.barcode = ANY($4::text[])` : '';
  const stockParams = barcodesFilter ? [tenantId, account.client_id, mpAccountId, barcodes]
                                      : [tenantId, account.client_id, mpAccountId];
  // Считаем остаток ТОЛЬКО по ячейкам отбора (is_pick_location=TRUE) - товар,
  // который лежит в зоне приёмки/размещения и ещё не разложен в ячейку
  // сборки, физически недоступен для сборщика прямо сейчас, поэтому в WB его
  // показывать как "в наличии" нельзя (иначе при больших объёмах WB будет
  // продавать то, что ещё только предстоит разложить по ячейкам, а не то, что
  // реально можно взять и собрать).
  // ВАЖНО: база выборки - wb_item_barcodes (все штрихкоды аккаунта), а не
  // stock_balances, через LEFT JOIN + FILTER. Если считать наоборот (JOIN от
  // stock_balances с WHERE is_pick_location=TRUE), то товар, весь остаток
  // которого лежит в зоне размещения (ещё не разложен по ячейкам отбора),
  // выпадает из выборки целиком - и тогда никогда не уходит в WB как явный 0,
  // что воспроизводит уже однажды пофикшенный баг с "зависшим" ненулевым
  // остатком на стороне WB (см. комментарий выше, кейс 2006784216833).
  //
  // НО: клиент может параллельно работать с НЕСКОЛЬКИМИ фулфилментами на
  // одном и том же WB-аккаунте - часть товаров физически лежит у нас, часть
  // у другого ФФ, а карточка в WB (wb_item_barcodes) у них общая, потому что
  // это один и тот же магазин WB. Раз мы никогда не видели этот товар у себя
  // (ни одной строки в stock_movements - ни приёмки, ни инвентаризации,
  // вообще ничего), значит это чужой для нас физически товар - и слать по
  // нему 0 нельзя ни в коем случае, это затрёт реальный остаток другого ФФ.
  // Инцидент: баркод 1282578471 (19.08.2026) - товар только у другого ФФ,
  // у нас 0 строк вообще везде, но мы всё равно отправили за него 0 в WB и
  // затёрли чужой остаток. Поэтому включаем в выборку только те штрихкоды, у
  // которых есть ХОТЯ БЫ ОДНО движение в нашем WMS - то есть мы этот товар
  // хоть раз физически трогали (даже если сейчас остаток честно 0 - тогда
  // логика выше про явный 0 по-прежнему работает, это НАШ товар).
  const stockRes = await query(
    `SELECT wib.barcode,
            COALESCE(SUM(sb.qty_available) FILTER (WHERE l.is_pick_location = TRUE), 0)::int AS qty
     FROM wms.wb_item_barcodes wib
     LEFT JOIN wms.stock_balances sb
       ON sb.tenant_id=$1 AND sb.client_id=$2 AND sb.barcode=wib.barcode
     LEFT JOIN wms.locations l ON l.id = sb.location_id
     WHERE wib.mp_account_id=$3${barcodesFilter}
       AND EXISTS (
         SELECT 1 FROM wms.stock_movements sm
         WHERE sm.tenant_id=$1 AND sm.client_id=$2 AND sm.barcode=wib.barcode
       )
     GROUP BY wib.barcode`,
    stockParams
  );

  // Заказы WB, которые он УЖЕ считает своими (списал у себя из показанного
  // остатка), а в WMS это никак не отражено: волна сборки ещё не
  // сформирована/не отгружена, резерва (qty_reserved) нет, товар в
  // stock_balances выглядит полностью свободным. Если это не учесть, пересчёт
  // отправит в WB "полный" остаток и фактически вернёт то, что WB уже продал
  // (см. инцидент 2006784214907 - изначальный повод завести это вычитание).
  //
  // ВАЖНО: раньше здесь стоял только 'new' - статус 'confirm' (заказ уже
  // добавлен в поставку, но физически ещё не забран/принят WB) сознательно
  // исключался, потому что ничего не переводило его дальше даже после
  // реальной отгрузки - 'confirm' завис бы навсегда, и остаток по такому
  // заказу считался бы недоступным вечно. Это открывало ДРУГУЮ дыру: всё
  // окно между "заказ добавлен в поставку" (см. wb.router.js:/generate-wave)
  // и "WB физически принял поставку" (см. syncDeliveryStatusForTenant) заказ
  // висел НИКАК не учтённым - остаток казался WB'у полностью свободным для
  // новых продаж, хотя единицы уже обещаны confirm'нутым заказам. Именно
  // так поймали разъезд по 2006784216833 (26.08.2026): возврат физически
  // добавил товар в ячейку, пересчёт корректно это увидел, но не вычел
  // несколько confirm-заказов, которые в этот момент уже сидели в поставке,
  // но ещё не были физически собраны - остаток в WB завысило.
  // Дыру с "confirm зависает навсегда" закрыли с другой стороны:
  // syncDeliveryStatusForTenant теперь переводит заказ в 'shipped', как
  // только WB подтвердил приёмку поставки - так что 'confirm' здесь больше
  // не рискует остаться недоучтённым навечно, и его можно спокойно вычитать.
  //
  // ПРАВКА 29.08.2026 (двойное вычитание, найдено на живой "Сверке остатков" -
  // клиент ИП Житкова, расхождение росло на глазах +1 -> +7 за 5 минут в
  // процессе сборки волны): 'confirm'-заказ, по которому УЖЕ прошла физическая
  // сборка (picking_tasks.status='done' - выставляется РОВНО В ОДНОМ месте
  // кода, picking.service.js, сразу вслед за списанием остатка с ячейки
  // отбора, см. ledger.consumeStock), к этому моменту уже вычтен ИЗ
  // физического row.qty (stockRes выше - SUM(qty_available) WHERE
  // is_pick_location=TRUE, а собранный товар с ячейки отбора уже списан).
  // Вычитать его ЕЩЁ РАЗ здесь, по одному только статусу заказа - двойной учёт:
  // по мере сборки волны expected проваливается всё ниже, хотя по факту ничего
  // не изменилось для покупателей - эти единицы как были обещаны своим
  // заказам, так и остаются. Теперь вычитаем только ещё НЕ собранные заказы
  // (picking_task для этого wb_order_id либо не создан, либо не 'done') -
  // ровно один раз на единицу товара, физически или по статусу заказа,
  // никогда оба раза сразу. Под оверселл это не открывает: собранный заказ и
  // так уже вычтен физически, просто перестаём вычитать его повторно.
  const newOrdersRes = await query(
    `SELECT wo.barcode, COUNT(*)::int AS n
     FROM wms.wb_orders wo
     WHERE wo.tenant_id=$1 AND wo.mp_account_id=$2 AND wo.status IN ('new','confirm') AND wo.barcode IS NOT NULL${barcodesFilter ? ' AND wo.barcode = ANY($3::text[])' : ''}
       AND NOT EXISTS (
         SELECT 1 FROM wms.picking_tasks pt
         WHERE pt.tenant_id = wo.tenant_id AND pt.wb_order_id = wo.wb_order_id AND pt.status = 'done'
       )
     GROUP BY wo.barcode`,
    barcodesFilter ? [tenantId, mpAccountId, barcodes] : [tenantId, mpAccountId]
  );
  const newOrdersByBarcode = new Map(newOrdersRes.rows.map(r => [r.barcode, r.n]));

  const distByWarehouse = {};
  warehouses.forEach(w => { distByWarehouse[w.warehouse_code] = []; });

  for (const row of stockRes.rows) {
    const barcode = row.barcode;
    // Вычитаем "новые" WB-заказы по этому штрихкоду - см. комментарий выше
    // про newOrdersByBarcode. Не может уйти в минус - GREATEST(0, ...).
    const openNewOrders = newOrdersByBarcode.get(barcode) || 0;
    const totalQty = Math.max(0, Number(row.qty) - openNewOrders);
    // Резерв - часть остатка, которую сознательно НЕ раздаём по складам WB
    // (буфер на случай ошибок/повреждений, чтобы не продать то, чего
    // физически может не оказаться).
    const toDistribute = Math.floor(totalQty * (1 - reservePct / 100));

    // Largest remainder method - целые количества по складам, которые в
    // сумме дают ровно toDistribute (простое round() по каждому складу
    // отдельно почти всегда даёт сумму, отличную от toDistribute).
    const raw  = warehouses.map(w => toDistribute * (Number(w.weight) / totalWeight));
    const base = raw.map(r => Math.floor(r));
    const assigned = base.reduce((a, b) => a + b, 0);
    let remainder = toDistribute - assigned;
    const order = raw
      .map((r, i) => ({ i, frac: r - base[i] }))
      .sort((a, b) => b.frac - a.frac);
    for (let k = 0; k < remainder && order.length > 0; k++) {
      base[order[k % order.length].i]++;
    }

    for (let i = 0; i < warehouses.length; i++) {
      const w = warehouses[i];
      const qty = base[i];
      // Раньше пушили в WB только qty>0 - при обнулившемся товаре это значило
      // "молчим", и WB так и не узнавал, что стало 0 (см. комментарий у
      // stockRes выше). Теперь шлём amount:0 явно - WB должен принимать 0 как
      // валидное значение "нет в наличии".
      distByWarehouse[w.warehouse_code].push({ sku: barcode, amount: qty });
      await query(
        `INSERT INTO wms.wb_stock_distribution(tenant_id, mp_account_id, barcode, warehouse_code, qty, calculated_at)
         VALUES($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (mp_account_id, barcode, warehouse_code)
         DO UPDATE SET qty=$5, calculated_at=NOW(), updated_at=NOW()`,
        [tenantId, mpAccountId, barcode, w.warehouse_code, qty]
      );
    }
  }

  let pushedWarehouses = 0;
  let failedWarehouses = 0;
  for (const w of warehouses) {
    const stocks = distByWarehouse[w.warehouse_code];
    if (!stocks.length) continue;
    try {
      await wbClient.updateFbsStocks(account.api_token, w.wb_warehouse_id, stocks);
      pushedWarehouses++;
    } catch (e) {
      failedWarehouses++;
      logger.warn({ err: e.message, mpAccountId, warehouseCode: w.warehouse_code }, 'Failed to push FBS stocks to WB (soft-fail)');
    }
  }

  logger.info(
    { tenantId, mpAccountId, warehouses: warehouses.length, skus: stockRes.rowCount, pushedWarehouses, failedWarehouses },
    'Stock redistribution finished'
  );
  return { ok: true, warehousesCount: warehouses.length, skusCount: stockRes.rowCount, pushedWarehouses, failedWarehouses };
}

/** Найти активные WB-аккаунты клиента и пересчитать/отправить распределение
 *  для каждого. Fire-and-forget с точки зрения вызывающего кода (приёмка/
 *  инвентаризация не должны ждать похода в WB API и тем более падать, если
 *  он недоступен) - сам логирует все ошибки внутри.
 *
 *  barcodes (опционально) - см. комментарий у distributeStockForAccount:
 *  событие по конкретному товару (приёмка/инвентаризация/сборка комплекта)
 *  должно пересчитывать только ЕГО, а не весь ассортимент клиента - иначе
 *  заодно пересчитываются и другие товары, у которых остаток в WMS ещё не
 *  учитывает уже принятые, но не собранные WB-заказы, и в WB улетает
 *  завышенное число. Без barcodes (для смены весов складов клиентом) -
 *  пересчёт всего ассортимента, там по-другому нельзя. */
function triggerRedistributionForClient({ tenantId, clientId, barcodes = null }) {
  query(
    `SELECT id FROM wms.mp_accounts WHERE tenant_id=$1 AND client_id=$2 AND marketplace='wb' AND is_active=TRUE`,
    [tenantId, clientId]
  ).then(accRes => {
    for (const row of accRes.rows) {
      distributeStockForAccount({ tenantId, mpAccountId: row.id, barcodes }).catch(e => {
        logger.warn({ err: e.message, mpAccountId: row.id, clientId }, 'Stock redistribution failed (soft-fail)');
      });
    }
  }).catch(e => {
    logger.warn({ err: e.message, tenantId, clientId }, 'Failed to look up WB accounts for redistribution (soft-fail)');
  });
}

// =============================================================================
// Остатки по складам FBS + оборачиваемость (кабинет клиента, одно окно)
//
// Показываем НЕ реальный остаток на складе WB (WB его нам не отдаёт по
// складам напрямую), а то, что сама WMS рассчитала и отправила в рамках
// автораспределения выше (wms.wb_stock_distribution) - клиент явно выбрал
// этот вариант. Рядом с количеством - оценка "хватит на N дней" по средней
// скорости продаж этого товара на этом складе за последние 30 дней
// (analytics.wb_sales_raw, сопоставление по warehouse_name - WB не даёт
// стабильного числового id склада в отчёте продаж, только человекочитаемое
// имя, поэтому сопоставляем по имени в рамках одного mp_account).
//
// Порог подсорта (reorder_min_qty/reorder_min_days) задаётся НА ТОВАР
// (wms.items), не на склад - у разных товаров разная оборачиваемость, а один
// и тот же порог должен действовать одинаково на каждом складе этого товара
// (см. миграцию 037 - изначально клали порог на склад, оказалось неверно).
// =============================================================================

const TURNOVER_WINDOW_DAYS = 30;

async function getStockDistributionReport({ tenantId, clientId }) {
  const accRes = await query(
    `SELECT id FROM wms.mp_accounts WHERE tenant_id=$1 AND client_id=$2 AND marketplace='wb' AND is_active=TRUE ORDER BY id LIMIT 1`,
    [tenantId, clientId]
  );
  if (accRes.rowCount === 0) return { has_account: false, warehouses: [], items: [], calculated_at: null };
  const mpAccountId = accRes.rows[0].id;

  const whRes = await query(
    `SELECT id, warehouse_code, warehouse_name
     FROM wms.wb_seller_warehouses
     WHERE mp_account_id=$1 AND is_active=TRUE AND is_enabled_for_dist=TRUE
     ORDER BY warehouse_name`,
    [mpAccountId]
  );
  const warehouses = whRes.rows;
  if (!warehouses.length) return { has_account: true, warehouses: [], items: [], calculated_at: null };

  const distRes = await query(
    `SELECT d.barcode, d.warehouse_code, d.qty, d.calculated_at,
            i.id AS item_id, i.item_name, i.vendor_code, i.reorder_min_qty, i.reorder_min_days
     FROM wms.wb_stock_distribution d
     LEFT JOIN wms.items i ON i.tenant_id=$2 AND i.client_id=$3 AND i.barcode=d.barcode
     WHERE d.mp_account_id=$1`,
    [mpAccountId, tenantId, clientId]
  );

  const salesRes = await query(
    `SELECT barcode, warehouse_name, COUNT(*)::numeric / $2 AS avg_daily_qty
     FROM analytics.wb_sales_raw
     WHERE mp_account_id=$1 AND barcode IS NOT NULL
       AND sale_datetime >= NOW() - ($2::text || ' days')::interval
     GROUP BY barcode, warehouse_name`,
    [mpAccountId, TURNOVER_WINDOW_DAYS]
  );
  const salesMap = new Map();
  for (const r of salesRes.rows) salesMap.set(`${r.barcode}|${r.warehouse_name}`, Number(r.avg_daily_qty));

  const whByCode = new Map(warehouses.map(w => [w.warehouse_code, w]));
  const itemsMap = new Map();
  let calculatedAt = null;

  for (const row of distRes.rows) {
    if (!itemsMap.has(row.barcode)) {
      itemsMap.set(row.barcode, {
        barcode: row.barcode,
        item_id: row.item_id || null,
        item_name: row.item_name || null,
        vendor_code: row.vendor_code || null,
        reorder_min_qty: row.reorder_min_qty != null ? Number(row.reorder_min_qty) : null,
        reorder_min_days: row.reorder_min_days != null ? Number(row.reorder_min_days) : null,
        by_warehouse: {},
      });
    }
    const item = itemsMap.get(row.barcode);
    const wh = whByCode.get(row.warehouse_code);
    const qty = Number(row.qty);
    const avgDaily = wh ? (salesMap.get(`${row.barcode}|${wh.warehouse_name}`) || 0) : 0;
    const daysOfStock = avgDaily > 0 ? qty / avgDaily : null;
    let lowStock = false;
    if (item.reorder_min_qty != null && qty < item.reorder_min_qty) lowStock = true;
    if (item.reorder_min_days != null && daysOfStock != null && daysOfStock < item.reorder_min_days) lowStock = true;
    item.by_warehouse[row.warehouse_code] = {
      qty,
      avg_daily_qty: Math.round(avgDaily * 100) / 100,
      days_of_stock: daysOfStock != null ? Math.round(daysOfStock * 10) / 10 : null,
      low_stock: lowStock,
    };
    if (!calculatedAt || row.calculated_at > calculatedAt) calculatedAt = row.calculated_at;
  }

  const items = [...itemsMap.values()].sort((a, b) =>
    (a.item_name || a.barcode).localeCompare(b.item_name || b.barcode, 'ru')
  );

  return { has_account: true, warehouses, items, calculated_at: calculatedAt };
}

// Числовой код status_ex нигде официально не задокументирован, а прямое
// сопоставление "код N = такой-то текст" на практике оказалось ОШИБОЧНЫМ:
// две заявки с status_ex=0 у одного клиента были фактически "ожидают решения
// продавца" (ещё не одобрены), хотя ЛК WB в разделе "Активные" в это же время
// показывал под тем же кодом совсем другую заявку со статусом "В пути в ПВЗ" —
// т.е. один и тот же код не гарантирует один и тот же текстовый статус.
// Поэтому статус выводим не по коду, а по составу поля actions (какие решения
// доступны прямо сейчас) — это единственное, что подтверждено напрямую самим
// продавцом ("эти товары я ещё не одобрил").
function deriveClaimStatusLabel(c) {
  const actions = Array.isArray(c.actions) ? c.actions : [];
  const needsDecision = actions.some(a => /^(approve|reject)/i.test(String(a)));
  if (needsDecision) return 'Ожидает вашего решения (одобрить/отклонить в ЛК WB)';
  const code = c.status_ex ?? c.status ?? null;
  return code != null ? `Статус WB: код ${code}` : null;
}

/**
 * Заявки на возврат от покупателей — ТОЛЬКО ВИДИМОСТЬ ("заявлено в WB, но ещё
 * не доехало физически до склада"). Не создаёт и не трогает wms.returns —
 * фактическая регистрация возврата остаётся ручной (см. returns.service.js),
 * т.к. решение "продажа/утиль" может принять только человек, вскрывший короб.
 * Один клиент может иметь несколько WB-кабинетов — собираем заявки по всем,
 * soft-fail на каждый аккаунт отдельно (протухший токен одного кабинета не
 * должен ронять весь список).
 */
async function listReturnClaimsForClient({ tenantId, clientId, isArchive = false }) {
  const accRes = await query(
    `SELECT id, account_name, api_token FROM wms.mp_accounts
     WHERE tenant_id=$1 AND client_id=$2 AND marketplace='wb' AND is_active=TRUE
       AND api_token IS NOT NULL AND length(trim(api_token))>0`,
    [tenantId, clientId]
  );

  const claims = [];
  for (const acc of accRes.rows) {
    try {
      const raw = await wbClient.fetchReturnClaims(acc.api_token, { isArchive });
      for (const c of raw) {
        const rawSrid = c.srid ?? null;
        // WB отдаёт srid обёрнутым в составную строку вида "eS.i<hex32>.0.0" —
        // достаём чистый 32-символьный hex-идентификатор, как показывает сам ЛК WB.
        const hexMatch = typeof rawSrid === 'string' ? rawSrid.match(/[0-9a-f]{32}/i) : null;
        claims.push({
          claim_id:     c.id ?? null,
          nm_id:        c.nm_id ?? null,
          item_name:    c.imt_name ?? null,
          tech_size:    c.tech_size ?? c.size ?? null,
          order_srid:   hexMatch ? hexMatch[0] : rawSrid,
          status:       deriveClaimStatusLabel(c),
          comment:      c.user_comment ?? c.wb_comment ?? null,
          photo:        Array.isArray(c.photos) ? c.photos[0] : null,
          order_dt:     c.order_dt ?? null,
          created_at:   c.dt ?? null,
          account_name: acc.account_name,
        });
      }
    } catch (e) {
      logger.warn({ err: e.message, tenantId, clientId, mpAccountId: acc.id }, 'fetchReturnClaims failed (soft-fail)');
    }
  }
  return claims;
}

/** Импорт карточек товаров WB (номенклатура) в wms.items — заполняет размер
 *  (techSize/wbSize), габариты и объём по каждому barcode карточки. Логика
 *  перенесена сюда из POST /wb/import-items без изменений, чтобы её можно
 *  было переиспользовать и в фоновой синхронизации (wbItemsSync.js), а не
 *  только по кнопке "Импортировать карточки из WB" в панели — до этого
 *  размер товара оставался пустым до первого ручного клика администратора,
 *  что на практике для многих клиентов просто никогда не происходило. */
async function importItemsForAccount({ tenantId, accountId, apiToken, clientId }) {
  const cards = await wbClient.fetchItems(apiToken, { limit: 100, maxPages: 50 });

  let savedItems = 0; let savedBarcodes = 0; let filledVolume = 0;
  await transaction(async (client) => {
    for (const card of cards) {
      const previewUrl = card.mediaFiles?.[0] || card.photos?.[0]?.big || null;

      const dim = card.dimensions || {};
      const lengthCm = Number(dim.length) || null;
      const widthCm  = Number(dim.width)  || null;
      const heightCm = Number(dim.height) || null;
      const volumeLiters = (lengthCm && widthCm && heightCm)
        ? Number(((lengthCm * widthCm * heightCm) / 1000).toFixed(4))
        : null;
      const weightGrams = dim.weightBrutto ? Math.round(Number(dim.weightBrutto) * 1000) : null;

      await client.query(
        `INSERT INTO wms.wb_items(tenant_id,mp_account_id,nm_id,imt_id,vendor_code,brand,title,preview_url)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT(mp_account_id,nm_id) DO UPDATE SET vendor_code=EXCLUDED.vendor_code,
           brand=EXCLUDED.brand,title=EXCLUDED.title,preview_url=EXCLUDED.preview_url,updated_at=NOW()`,
        [tenantId, accountId, card.nmID, card.imtID||null,
         card.vendorCode||null, card.brand||null, card.title||null, previewUrl]
      );
      savedItems++;

      const barcodes = wbClient.extractCardBarcodes(card);
      for (const b of barcodes) {
        await client.query(
          `INSERT INTO wms.wb_item_barcodes(tenant_id,mp_account_id,nm_id,chrt_id,barcode)
           VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [tenantId, accountId, b.nm_id, b.chrt_id, b.barcode]
        );
        savedBarcodes++;

        const item = await client.query(
          `SELECT id, volume_liters, size FROM wms.items WHERE tenant_id=$1 AND client_id=$2 AND barcode=$3 LIMIT 1`,
          [tenantId, clientId, b.barcode]
        );
        if (item.rowCount === 0 && card.title) {
          await client.query(
            `INSERT INTO wms.items(tenant_id,client_id,barcode,item_name,vendor_code,brand,unit,source,wb_nm_id,preview_url,
                                    length_cm,width_cm,height_cm,volume_liters,weight_grams,size)
             VALUES($1,$2,$3,$4,$5,$6,'шт','wb',$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`,
            [tenantId, clientId, b.barcode,
             card.title, card.vendorCode||null, card.brand||null, card.nmID, previewUrl,
             lengthCm, widthCm, heightCm, volumeLiters, weightGrams, b.tech_size||null]
          );
          if (volumeLiters) filledVolume++;
        } else if (item.rowCount > 0 && ((item.rows[0].volume_liters == null && volumeLiters) || (item.rows[0].size == null && b.tech_size))) {
          await client.query(
            `UPDATE wms.items SET
               length_cm = COALESCE(length_cm, $1),
               width_cm  = COALESCE(width_cm, $2),
               height_cm = COALESCE(height_cm, $3),
               volume_liters = COALESCE(volume_liters, $4),
               weight_grams = COALESCE(weight_grams, $5),
               size = COALESCE(size, $6),
               updated_at = NOW()
             WHERE id=$7`,
            [lengthCm, widthCm, heightCm, volumeLiters, weightGrams, b.tech_size||null, item.rows[0].id]
          );
          if (volumeLiters) filledVolume++;
        }
      }
    }
  });

  return { fetched_cards: cards.length, saved_items: savedItems, saved_barcodes: savedBarcodes, filled_volume: filledVolume };
}

/** Импорт карточек по ВСЕМ активным WB-аккаунтам тенанта (фоновый джоб) */
async function importItemsForAllAccounts(tenantId) {
  const accounts = await listActiveAccounts(tenantId);
  const results = [];
  for (const acc of accounts) {
    try {
      const r = await importItemsForAccount({ tenantId, accountId: acc.id, apiToken: acc.api_token, clientId: acc.client_id });
      results.push({ account_id: acc.id, account_name: acc.account_name, ok: true, ...r });
    } catch (e) {
      logger.error({ err: e, tenantId, accountId: acc.id }, 'WB items-sync: account import failed');
      results.push({ account_id: acc.id, account_name: acc.account_name, ok: false, error: e.message });
    }
  }
  return results;
}

/** tenant_id всех тенантов с включённым модулем wb_integration и активным доступом (для фонового джоба) */
async function listTenantsWithWbIntegration() {
  const r = await query(
    `SELECT t.id FROM platform.tenants t
     JOIN platform.tenant_modules tm ON tm.tenant_id = t.id AND tm.module_code = 'wb_integration'
     WHERE t.status IN ('trial','active')`
  );
  return r.rows.map(row => row.id);
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Живая сверка "что WB реально отдаёт по /api/v3/stocks" против "что сейчас
 *  физически доступно в WMS" — по ВСЕМ активным WB-аккаунтам тенанта.
 *
 *  Специально НЕ смотрит в wms.wb_stock_distribution (это только то, что мы
 *  сами в последний раз посчитали и попытались отправить — она может быть
 *  устаревшей, ровно это и стало причиной инцидента с 2006784216833).
 *  Спрашивает у WB напрямую, что у него сейчас записано по каждому SKU на
 *  каждом складе — это единственный способ увидеть реальное расхождение, а
 *  не ещё раз довериться собственным расчётам. Раньше это была ручная
 *  консольная утилита (scripts/wb-stock-reconcile.js, тот же алгоритм) — эта
 *  функция даёт то же самое из интерфейса, кнопкой, по своему тенанту. */
async function reconcileStockForTenant(tenantId) {
  const SKU_CHUNK = 1000; // лимит WB на кол-во skus в одном запросе
  const PAUSE_MS = 350;   // пауза между запросами к WB, чтобы не словить 429
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const accountsRes = await query(
    `SELECT ma.id, ma.client_id, ma.api_token, ma.account_name, ma.settings, c.client_name
     FROM wms.mp_accounts ma
     JOIN wms.clients c ON c.id = ma.client_id
     WHERE ma.tenant_id=$1 AND ma.marketplace='wb' AND ma.is_active=TRUE AND ma.api_token IS NOT NULL
     ORDER BY ma.id`,
    [tenantId]
  );

  const accounts = [];
  let totalMismatches = 0;
  let checkedAt = new Date().toISOString();

  for (const acc of accountsRes.rows) {
    // ВАЖНО (найдено 28.08.2026 на конкретном кейсе): считаем WB-итого ТОЛЬКО
    // по складам, включённым в автораспределение (is_enabled_for_dist=TRUE) -
    // ровно тем, куда реально пушит distributeStockForAccount. Склад, который
    // клиент сознательно выключил из автораспределения, мы никогда не трогаем
    // (ни цифрой, ни явным нулём) - что бы там ни висело у WB (остаток от
    // ручного управления или старый), это не в зоне нашей ответственности и
    // сравнивать с ним нечестно - именно так раньше "находился" ложный
    // оверселл +5 на товаре, который на самом деле был отправлен верно.
    const whRes = await query(
      `SELECT wb_warehouse_id, warehouse_name FROM wms.wb_seller_warehouses
       WHERE mp_account_id=$1 AND is_active=TRUE AND is_enabled_for_dist=TRUE ORDER BY warehouse_name`,
      [acc.id]
    );
    if (whRes.rowCount === 0) {
      accounts.push({ account_id: acc.id, account_name: acc.account_name, client_name: acc.client_name, skipped: 'no_warehouses', mismatches: [] });
      continue;
    }

    const barcodesRes = await query(
      `SELECT DISTINCT barcode FROM wms.wb_item_barcodes WHERE mp_account_id=$1`,
      [acc.id]
    );
    const skus = barcodesRes.rows.map(r => r.barcode).filter(Boolean);
    if (skus.length === 0) {
      accounts.push({ account_id: acc.id, account_name: acc.account_name, client_name: acc.client_name, skipped: 'no_barcodes', mismatches: [] });
      continue;
    }
    const skuChunks = chunkArray(skus, SKU_CHUNK);

    const wbTotals = new Map();
    const errors = [];
    for (const w of whRes.rows) {
      for (const c of skuChunks) {
        let stocks;
        try {
          stocks = await wbClient.fetchFbsStocks(acc.api_token, w.wb_warehouse_id, c);
        } catch (e) {
          errors.push(`${w.warehouse_name}: ${e.message}`);
          continue;
        }
        for (const s of stocks) {
          const barcode = s.sku;
          if (!barcode) continue;
          const qty = Number(s.amount || 0);
          // ВАЖНО: раньше здесь пропускались строки с qty<=0 - это означало,
          // что явный ноль от WB вообще не попадал в wbTotals, а ниже цикл
          // сверки шёл ТОЛЬКО по wbTotals.entries() - то есть случай "в WMS
          // остаток есть, а в WB реально 0" в принципе не мог быть замечен
          // (ни как отдельная запись, ни тем более как расхождение). Именно
          // так был упущен случай 27.08.2026: WB partners показывал 0 по
          // всем складам при 42 доступных в WMS, а "Сверка остатков" молчала.
          // Теперь копим amount как есть (в т.ч. 0) - см. also цикл ниже,
          // который сверяет по ПОЛНОМУ списку зарегистрированных штрихкодов
          // (skus), а не только по тем, что вернул WB с ненулевым остатком.
          wbTotals.set(barcode, (wbTotals.get(barcode) || 0) + qty);
        }
        await sleep(PAUSE_MS);
      }
    }

    // ВАЖНО (правка 28.08.2026, по итогам разбора конкретных "расхождений"):
    // сравнивать WB нужно не с сырым qty_available, а с тем, сколько реально
    // ДОЛЖНО быть отправлено - той же формулой, что и сам пуш
    // (distributeStockForAccount): минус штучно открытые заказы ('new'/
    // 'confirm', ещё не отгруженные) и минус резерв (settings.stock_reserve_pct,
    // по умолчанию 5%). Без этого сверка честно показывала МНОГО "расхождений",
    // которые на самом деле не расхождение, а законные придержанные единицы -
    // например 878 в WMS, 826 в WB это не баг, а 8 шт под открытыми заказами
    // + 5% резерва, именно это число и было отправлено. Раньше такие строки
    // было не отличить от настоящих зависших/непроталкивающихся остатков -
    // приходилось руками разбирать каждую через diag-barcode-detail.js.
    const settings = acc.settings || {};
    const reservePct = Number.isFinite(Number(settings.stock_reserve_pct)) ? Number(settings.stock_reserve_pct) : 5;

    const physicalRes = await query(
      `SELECT wib.barcode,
              COALESCE(SUM(sb.qty_available) FILTER (WHERE l.is_pick_location = TRUE), 0)::int AS qty,
              MAX(i.item_name) AS item_name
       FROM wms.wb_item_barcodes wib
       LEFT JOIN wms.stock_balances sb ON sb.tenant_id=$1 AND sb.client_id=$2 AND sb.barcode=wib.barcode
       LEFT JOIN wms.locations l ON l.id = sb.location_id
       LEFT JOIN wms.items i ON i.tenant_id=$1 AND i.client_id=$2 AND i.barcode=wib.barcode
       WHERE wib.mp_account_id=$3
         AND EXISTS (
           SELECT 1 FROM wms.stock_movements sm
           WHERE sm.tenant_id=$1 AND sm.client_id=$2 AND sm.barcode=wib.barcode
         )
       GROUP BY wib.barcode`,
      [tenantId, acc.client_id, acc.id]
    );
    const physicalMap = new Map(physicalRes.rows.map(r => [r.barcode, { qty: Number(r.qty), name: r.item_name }]));

    // ПРАВКА 29.08.2026: та же формула, что и в distributeStockForAccount (см.
    // комментарий там) - не вычитаем повторно заказы, которые уже физически
    // собраны (picking_tasks.status='done'), их единицы уже вычтены из
    // physicalRes выше через уменьшение остатка на ячейке отбора.
    const openOrdersRes = await query(
      `SELECT wo.barcode, COUNT(*)::int AS n
       FROM wms.wb_orders wo
       WHERE wo.tenant_id=$1 AND wo.mp_account_id=$2 AND wo.status IN ('new','confirm') AND wo.barcode IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM wms.picking_tasks pt
           WHERE pt.tenant_id = wo.tenant_id AND pt.wb_order_id = wo.wb_order_id AND pt.status = 'done'
         )
       GROUP BY wo.barcode`,
      [tenantId, acc.id]
    );
    const openOrdersMap = new Map(openOrdersRes.rows.map(r => [r.barcode, r.n]));

    // ВАЖНО (правка 27.08.2026): раньше цикл шёл только по wbTotals.entries()
    // и флагом расхождения было ТОЛЬКО diff>0 (WB продаёт больше, чем реально
    // есть - риск оверселла, ради этого сверку и заводили изначально). Оба
    // решения вместе давали слепую зону: если WB присылал по штрихкоду 0 (или
    // не присылал вовсе), а в WMS остаток был - такая пара НИКОГДА не
    // попадала в отчёт, ни как строка, ни тем более как расхождение. Именно
    // это скрыло реальный сбой push'а остатков 27.08.2026 - "Сверка остатков"
    // показывала "всё чисто" при том, что по многим товарам WB реально
    // показывал 0 при ненулевом остатке в WMS. Теперь идём по ПОЛНОМУ списку
    // зарегистрированных для аккаунта штрихкодов (skus, весь wb_item_barcodes)
    // и сравниваем в обе стороны - diff!==0 - не только WB>WMS (риск
    // оверселла), но и "ожидаемое">WB (остаток "застрял", в WB не ушёл).
    const mismatches = [];
    for (const barcode of skus) {
      const wbQty = wbTotals.get(barcode) || 0;
      const phys = physicalMap.get(barcode) || { qty: 0, name: '(нет остатка в WMS)' };
      const openOrders = openOrdersMap.get(barcode) || 0;
      const afterOrders = Math.max(0, phys.qty - openOrders);
      const expected = Math.floor(afterOrders * (1 - reservePct / 100));
      const diff = wbQty - expected;
      if (diff !== 0) {
        mismatches.push({
          barcode, name: phys.name, wb_qty: wbQty, wms_qty: phys.qty,
          open_orders: openOrders, reserve_pct: reservePct, expected_qty: expected, diff,
        });
      }
    }
    mismatches.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
    totalMismatches += mismatches.length;

    accounts.push({
      account_id: acc.id,
      account_name: acc.account_name,
      client_name: acc.client_name,
      mismatches,
      errors,
    });
  }

  return { checked_at: checkedAt, accounts, total_mismatches: totalMismatches };
}

module.exports = {
  getMpAccount,
  listActiveAccounts,
  syncOrdersForAccount,
  syncAllAccountsForTenant,
  syncDeliveryStatusForTenant,
  listTenantsWithWbIntegration,
  importItemsForAccount,
  importItemsForAllAccounts,
  syncSellerWarehouses,
  distributeStockForAccount,
  triggerRedistributionForClient,
  listReturnClaimsForClient,
  getStockDistributionReport,
  reconcileStockForTenant,
  listAllWbAccountsForStatsSync,
  syncStatsRegionForAccount,
};
