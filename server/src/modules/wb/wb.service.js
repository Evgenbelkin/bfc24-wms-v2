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
async function syncOrdersForAccount({ tenantId, accountId, apiToken }) {
  const orders = await wbClient.fetchNewOrders(apiToken);

  let saved = 0;
  const freshIds = [];
  for (const o of orders) {
    const wbOrderId = o.id || o.odid || o.orderId;
    if (!wbOrderId) continue;
    freshIds.push(Number(wbOrderId));
    const barcode = Array.isArray(o.skus) ? o.skus[0] : (o.barcode || null);
    await query(
      `INSERT INTO wms.wb_orders
         (tenant_id,mp_account_id,wb_order_id,nm_id,chrt_id,article,barcode,
          warehouse_id,warehouse_name,region_name,price,converted_price,currency_code,
          status,created_at,raw)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT(mp_account_id,wb_order_id) DO UPDATE SET
         status=EXCLUDED.status, fetched_at=NOW(), raw=EXCLUDED.raw`,
      [
        tenantId, accountId, wbOrderId,
        o.nmId||o.nmID||null, o.chrtId||null, o.article||null, barcode,
        o.warehouseId||null, (o.offices||[]).join(',')||o.warehouseName||null,
        o.regionName||null, o.price||null, o.convertedPrice||null, o.currencyCode||null,
        'new', o.createdAt||null,
        JSON.stringify(o),
      ]
    );
    saved++;
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

  return { fetched: orders.length, saved, marked_external: reconciled.rowCount };
}

/** Синхронизировать заказы по ВСЕМ активным WB-аккаунтам тенанта (кнопка "Синхронизировать все") */
async function syncAllAccountsForTenant(tenantId) {
  const accounts = await listActiveAccounts(tenantId);
  const results = [];
  for (const acc of accounts) {
    try {
      const r = await syncOrdersForAccount({ tenantId, accountId: acc.id, apiToken: acc.api_token });
      results.push({ account_id: acc.id, account_name: acc.account_name, ok: true, ...r });
    } catch (e) {
      logger.error({ err: e, tenantId, accountId: acc.id }, 'WB sync-all: account sync failed');
      results.push({ account_id: acc.id, account_name: acc.account_name, ok: false, error: e.message });
    }
  }
  return results;
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
    ? ` AND sb.barcode = ANY($4::text[])` : '';
  const stockParams = barcodesFilter ? [tenantId, account.client_id, mpAccountId, barcodes]
                                      : [tenantId, account.client_id, mpAccountId];
  const stockRes = await query(
    `SELECT sb.barcode, SUM(sb.qty_available)::int AS qty
     FROM wms.stock_balances sb
     WHERE sb.tenant_id=$1 AND sb.client_id=$2
       AND EXISTS (SELECT 1 FROM wms.wb_item_barcodes wib WHERE wib.mp_account_id=$3 AND wib.barcode=sb.barcode)${barcodesFilter}
     GROUP BY sb.barcode`,
    stockParams
  );

  // "Новые" заказы WB (status='new') по этим же штрихкодам - WB уже списал их
  // у себя из показанного остатка (резервирует в момент создания заказа, ещё
  // до того как мы вообще его увидим), а в WMS они никак не отражены: волна
  // сборки ещё не сформирована, резерва (qty_reserved) нет, товар в
  // stock_balances выглядит полностью свободным. Если это не учесть, пересчёт
  // отправит в WB "полный" остаток и фактически вернёт то, что WB уже продал
  // (см. инцидент 2006784216833 - механизм подсказал сам пользователь).
  //
  // Статус 'confirm' и дальше для этой цели НЕ годится - выставляется один
  // раз при добавлении в поставку и потом никогда не обновляется до
  // 'complete', даже после реальной отгрузки (deliverSupply это не делает) -
  // то есть 'confirm' почти всегда висит и на давно отгруженных заказах.
  // 'new' же надёжен: перезаписывается на каждой синхронизации напрямую из
  // живого ответа WB (/api/v3/orders/new), и заказ, ушедший в поставку,
  // сразу помечается 'confirm' (см. wb.router.js) - то есть 'new' у нас
  // всегда актуален и означает "WB точно ещё удерживает эту единицу, мы её
  // точно ещё не трогали".
  const newOrdersRes = await query(
    `SELECT barcode, COUNT(*)::int AS n
     FROM wms.wb_orders
     WHERE tenant_id=$1 AND mp_account_id=$2 AND status='new' AND barcode IS NOT NULL${barcodesFilter ? ' AND barcode = ANY($3::text[])' : ''}
     GROUP BY barcode`,
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
};
