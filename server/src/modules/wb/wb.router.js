'use strict';

const express = require('express');
const router = express.Router();
const { query, transaction } = require('../../config/database');
const wbClient = require('./wb.client');
const wbService = require('./wb.service');
const wbTariffsService = require('../platform/wbTariffs.service');
const wbAcceptanceService = require('../platform/wbAcceptance.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware, resolveClientScope } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { requireModule } = require('../../middleware/tenant');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const { resolveOrCreateItem, findItemIdByBarcode, resolveStockKey } = require('../masterdata/items/items.service');
const { getDefaultWarehouse } = require('../warehouses/warehouses.service');
const logger = require('../../utils/logger');

router.use(authRequired, tenantMiddleware, requireModule('wb_integration'));

// ─────────────── Helpers ───────────────

const getMpAccount = wbService.getMpAccount;

/**
 * Достать из тела ошибки WB (addOrdersToSupply, 409 FailedToAddSupplyOrder и
 * подобные) конкретные order_id, которые WB явно назвал отклонёнными —
 * best-effort разбор нескольких встречавшихся форм ответа, т.к. официальная
 * схема этой ошибки WB нигде не задокументирована жёстко. Возвращает [] (а
 * не бросает), если распознать ничего не удалось — вызывающий код в этом
 * случае просто падает обратно на старую эвристику (сверка со свежим
 * списком "новых" заказов), см. generate-wave ниже.
 *
 * Введено после инцидента 15-16.09.2026 (WB-GI-278465437) — WB отклонил
 * заказ 5770391750, который при этом НЕ пропал из списка "новых", поэтому
 * старая эвристика ничего не убрала из пачки, повторная попытка упала с той
 * же ошибкой, и это исключение раньше было некому ловить.
 */
function extractRejectedOrderIds(wbBody) {
  const ids = new Set();
  const collectNumeric = (val) => {
    const n = Number(val);
    if (Number.isFinite(n) && n > 0) ids.add(n);
  };
  const visit = (node) => {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const el of node) {
        if (typeof el === 'number' || typeof el === 'string') collectNumeric(el);
        else if (el && typeof el === 'object') {
          const cand = el.orderId ?? el.order_id ?? el.id ?? el.odid;
          if (cand != null) collectNumeric(cand);
        }
      }
      return;
    }
    if (typeof node === 'object') {
      if (node.orderId != null) collectNumeric(node.orderId);
      if (node.order_id != null) collectNumeric(node.order_id);
      // Известные поля-контейнеры в разных вариантах ответов WB
      for (const key of ['data', 'orders', 'errors', 'additionalErrors', 'reasons']) {
        if (node[key] != null) visit(node[key]);
      }
    }
  };
  try { visit(wbBody); } catch (_) { /* best-effort */ }
  return [...ids];
}

// ─────────────── MP Accounts ───────────────

router.get('/accounts', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const params = [req.user.tenantId]; const conds = ['ma.tenant_id=$1']; let idx=2;
    if (clientId) { conds.push(`ma.client_id=$${idx++}`); params.push(clientId); }
    const r = await query(
      `SELECT ma.id, ma.client_id, ma.marketplace, ma.account_code, ma.account_name,
         ma.supplier_id, ma.is_active,
         COALESCE((ma.settings->>'stock_sync_disabled')::boolean, false) AS stock_sync_disabled,
         (ma.api_token IS NOT NULL AND length(trim(ma.api_token))>0) AS has_token,
         (ma.api_token_stats IS NOT NULL AND length(trim(ma.api_token_stats))>0) AS has_token_stats,
         c.client_name
       FROM wms.mp_accounts ma JOIN wms.clients c ON c.id=ma.client_id
       WHERE ${conds.join(' AND ')} ORDER BY c.client_name, ma.account_name`,
      params
    );
    res.json({ ok: true, accounts: r.rows });
  } catch(e){ next(e); }
});

router.post('/accounts', requireRole('tenant_admin'), async (req,res,next)=>{
  try {
    const { client_id, marketplace='wb', account_name, account_code, supplier_id, api_token, api_token_stats } = req.body;
    const clientId = resolveClientScope(req, client_id);
    // Рубильник отправки остатков (settings.stock_sync_disabled, см.
    // distributeStockForAccount) по умолчанию должен быть ВЫКЛЮЧЕН для новых
    // аккаунтов - раньше поле settings не задавалось при создании, падало на
    // DEFAULT '{}' у колонки, а это читается как stock_sync_disabled=false,
    // то есть отправка остатков включалась сама, без явного решения селлера.
    // Явно прописываем settings=true здесь, а не меняем DEFAULT колонки, чтобы
    // не трогать уже существующие аккаунты (у них осознанно выбранное
    // состояние переключателя, менять его задним числом нельзя).
    const r = await query(
      `INSERT INTO wms.mp_accounts(tenant_id,client_id,marketplace,account_name,account_code,supplier_id,api_token,api_token_stats,created_by,settings)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'{"stock_sync_disabled":true}'::jsonb)
       RETURNING id,client_id,marketplace,account_name,is_active,
         COALESCE((settings->>'stock_sync_disabled')::boolean, false) AS stock_sync_disabled`,
      [req.user.tenantId, clientId, marketplace, account_name, account_code||null, supplier_id||null, api_token||null, api_token_stats||null, req.user.id]
    );
    res.status(201).json({ ok: true, account: r.rows[0] });
  } catch(e){ next(e); }
});

router.patch('/accounts/:id', requireRole('tenant_admin'), async (req,res,next)=>{
  try {
    const id = Number(req.params.id);
    const { account_name, account_code, supplier_id, api_token, api_token_stats, is_active, stock_sync_disabled } = req.body;
    const fields=[]; const params=[]; let idx=1;
    if (account_name !== undefined) { fields.push(`account_name=$${idx++}`); params.push(account_name); }
    if (account_code !== undefined) { fields.push(`account_code=$${idx++}`); params.push(account_code||null); }
    if (supplier_id  !== undefined) { fields.push(`supplier_id=$${idx++}`);  params.push(supplier_id||null); }
    if (api_token    !== undefined) {
      fields.push(`api_token=CASE WHEN $${idx}::text='' THEN NULL ELSE $${idx}::text END`);
      params.push(api_token||''); idx++;
    }
    if (api_token_stats !== undefined) {
      fields.push(`api_token_stats=CASE WHEN $${idx}::text='' THEN NULL ELSE $${idx}::text END`);
      params.push(api_token_stats||''); idx++;
    }
    if (is_active !== undefined) { fields.push(`is_active=$${idx++}`); params.push(!!is_active); }
    // Рубильник отправки остатков в WB — хранится внутри settings JSONB
    // (миграция не нужна, там уже живёт stock_reserve_pct, см. distributeStockForAccount).
    if (stock_sync_disabled !== undefined) {
      fields.push(`settings=COALESCE(settings,'{}'::jsonb) || jsonb_build_object('stock_sync_disabled',$${idx++}::boolean)`);
      params.push(!!stock_sync_disabled);
    }
    if (!fields.length) return res.status(400).json({ ok:false, error:{code:'VALIDATION_ERROR',message:'No fields'} });
    fields.push(`updated_at=NOW()`); params.push(id, req.user.tenantId);
    const r = await query(
      `UPDATE wms.mp_accounts SET ${fields.join(',')} WHERE id=$${idx++} AND tenant_id=$${idx}
       RETURNING id,account_name,is_active,
         COALESCE((settings->>'stock_sync_disabled')::boolean, false) AS stock_sync_disabled,
         (api_token IS NOT NULL) AS has_token,
         (api_token_stats IS NOT NULL) AS has_token_stats`,
      params
    );
    if (r.rowCount===0) throw new NotFoundError('MP Account', id);
    res.json({ ok: true, account: r.rows[0] });
  } catch(e){ next(e); }
});

// ─────────────── Склады WB аккаунта (какие обрабатывать в волнах сборки) ───────────────
//
// Отдельно от wms.wb_seller_warehouses.is_enabled_for_dist (клиентский флаг
// для автораспределения остатков) — is_enabled_for_picking решает админ этого
// тенанта: если у клиента несколько складов WB в разных городах, каждый
// обслуживается своим фулфилментом, и /generate-wave не должен захватывать
// чужие заказы. См. миграцию 035.

router.get('/accounts/:id/warehouses', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const accountId = Number(req.params.id);
    const accCheck = await query(`SELECT id FROM wms.mp_accounts WHERE id=$1 AND tenant_id=$2`, [accountId, req.user.tenantId]);
    if (accCheck.rowCount === 0) throw new NotFoundError('MP Account', accountId);
    const r = await query(
      `SELECT id, wb_warehouse_id, warehouse_code, warehouse_name, is_active,
              is_enabled_for_picking, is_enabled_for_dist, weight
       FROM wms.wb_seller_warehouses
       WHERE mp_account_id=$1
       ORDER BY is_active DESC, warehouse_name`,
      [accountId]
    );
    res.json({ ok: true, warehouses: r.rows });
  } catch(e){ next(e); }
});

/** PATCH /accounts/:id/warehouses/:whId — теперь также принимает weight и
 *  is_enabled_for_dist (доля/участие в автораспределении остатков), не только
 *  is_enabled_for_picking. ПРАВКА 13.09.2026: раньше этим управлял сам клиент
 *  на /seller/wb-warehouses.html — убрали оттуда после инцидента (ИП Макарова
 *  С.И. случайно включила 3 склада, 2 из которых физически обслуживает другой
 *  ФФ на том же WB-аккаунте, и наша программа затёрла его остаток). Теперь
 *  сотрудник сам спрашивает у клиента, какие склады реально его, и ставит
 *  галочки здесь — клиент прямого доступа к этой настройке больше не имеет. */
router.patch('/accounts/:id/warehouses/:whId', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const accountId = Number(req.params.id);
    const whId = Number(req.params.whId);
    const { is_enabled_for_picking, is_enabled_for_dist, weight } = req.body;
    if (is_enabled_for_picking === undefined && is_enabled_for_dist === undefined && weight === undefined) {
      throw new ValidationError('Nothing to update');
    }
    const fields = []; const params = []; let idx = 1;
    if (is_enabled_for_picking !== undefined) { fields.push(`is_enabled_for_picking=$${idx++}`); params.push(!!is_enabled_for_picking); }
    if (is_enabled_for_dist !== undefined) { fields.push(`is_enabled_for_dist=$${idx++}`); params.push(!!is_enabled_for_dist); }
    if (weight !== undefined) {
      const w = Number(weight);
      if (!Number.isFinite(w) || w < 0) throw new ValidationError('weight must be a non-negative number');
      fields.push(`weight=$${idx++}`); params.push(w);
    }
    fields.push(`updated_at=NOW()`);
    params.push(whId, accountId, req.user.tenantId);
    const r = await query(
      `UPDATE wms.wb_seller_warehouses w SET ${fields.join(', ')}
       FROM wms.mp_accounts ma
       WHERE w.mp_account_id = ma.id AND w.id=$${idx++} AND w.mp_account_id=$${idx++} AND ma.tenant_id=$${idx++}
       RETURNING w.id, w.is_enabled_for_picking, w.is_enabled_for_dist, w.weight, ma.client_id`,
      params
    );
    if (r.rowCount === 0) throw new NotFoundError('Warehouse', whId);
    // Пересчитать и отправить в WB, только если реально поменялась настройка
    // раздачи (а не только is_enabled_for_picking - та не влияет на остатки).
    if (is_enabled_for_dist !== undefined || weight !== undefined) {
      wbService.triggerRedistributionForClient({ tenantId: req.user.tenantId, clientId: r.rows[0].client_id });
    }
    res.json({ ok: true, warehouse: r.rows[0] });
  } catch(e){ next(e); }
});

// ─────────────── Импорт карточек WB ───────────────

router.post('/import-items', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const accountId = Number(req.body.account_id);
    const acc = await getMpAccount(req.user.tenantId, accountId);
    // Логика в wbService.importItemsForAccount — переиспользуется и фоновым
    // джобом (wbItemsSync.js), чтобы размер/габариты подтягивались сами по
    // расписанию, а не только по клику на эту кнопку.
    const result = await wbService.importItemsForAccount({
      tenantId: req.user.tenantId, accountId, apiToken: acc.api_token, clientId: acc.client_id,
    });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

// ─────────────── Синхронизация заказов ───────────────

router.post('/sync-orders', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const accountId = Number(req.body.account_id);
    const acc = await getMpAccount(req.user.tenantId, accountId);
    // Только новые заказы, ожидающие сборки — не вся история WB. Раньше здесь
    // дёргался /api/v3/orders (весь архив, включая отменённые за всё время) и
    // в status писался deliveryType ('fbs' для всех подряд), из-за чего
    // фильтр "заказы без поставки" на генерации волны не отсеивал ничего.
    const result = await wbService.syncOrdersForAccount({ tenantId: req.user.tenantId, accountId, apiToken: acc.api_token, clientId: acc.client_id });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

// Синхронизировать заказы по ВСЕМ активным WB-аккаунтам клиентов этого тенанта за один клик
router.post('/sync-orders-all', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const results = await wbService.syncAllAccountsForTenant(req.user.tenantId);
    const totalSaved = results.reduce((s,r)=>s+(r.saved||0),0);
    const totalFetched = results.reduce((s,r)=>s+(r.fetched||0),0);
    res.json({ ok: true, accounts: results, total_fetched: totalFetched, total_saved: totalSaved });
  } catch(e){ next(e); }
});

// ─────────────── Распределение остатков по складам WB ───────────────

/** POST /wb/accounts/:id/redistribute-stock — форсировать пересчёт вручную
 *  (обычно срабатывает само после приёмки/инвентаризации/смены настроек
 *  клиентом - эта кнопка для админа/саппорта, когда нужно пересчитать прямо
 *  сейчас без ожидания события). */
router.post('/accounts/:id/redistribute-stock', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const accountId = Number(req.params.id);
    await getMpAccount(req.user.tenantId, accountId); // валидирует принадлежность тенанту
    const result = await wbService.distributeStockForAccount({ tenantId: req.user.tenantId, mpAccountId: accountId });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

/** GET /wb/reconcile — живая сверка "что WB реально отдаёт по своим складам"
 *  против "что сейчас доступно в WMS", по всем WB-аккаунтам тенанта. Спрашивает
 *  сам WB API напрямую (не наши расчёты) - чтобы можно было зайти и посмотреть
 *  без похода по SSH (см. server/scripts/wb-stock-reconcile.js - та же логика,
 *  консольный вариант). Может идти небыстро (несколько запросов к WB на
 *  аккаунт, с паузами против 429) - поэтому дергать по кнопке, не по крону. */
router.get('/reconcile', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const result = await wbService.reconcileStockForTenant(req.user.tenantId);
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

/** GET /wb/tariffs — тарифы приёмки/логистики/хранения WB по складам,
 *  read-only для персонала ФФ (не для клиентов-селлеров — те на роли 'seller'
 *  вообще не доходят до этого меню, см. public/app/menu.html). Тарифы у WB
 *  одинаковые для любого продавца, поэтому данные общие для всех тенантов -
 *  собираются одним токеном владельца платформы (platform.wbTariffs.service.js,
 *  ежедневная джоба). Здесь только читаем последний снимок, никакого
 *  собственного похода к WB API и никакого ввода токена тенантом. */
router.get('/tariffs', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const result = await wbTariffsService.listLatestTariffs();
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

/** GET /wb/acceptance-coefficients — коэффициенты приёмки ФБС по складам:
 *  бесплатно/платно/закрыто сегодня + ближайшая бесплатная дата. Тоже
 *  read-only снимок общих данных (см. platform/wbAcceptance.service.js), не
 *  свой запрос к WB на тенанта. */
router.get('/acceptance-coefficients', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const result = await wbAcceptanceService.listNearestFreeSlots();
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

// ─────────────── Генерация FBS-волны ───────────────

router.post('/generate-wave', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const accountId = Number(req.body.account_id);
    const limitOrders = Math.min(Number(req.body.limit)||50, 500);
    const acc = await getMpAccount(req.user.tenantId, accountId);
    const wh = await getDefaultWarehouse(req.user.tenantId);

    // Сначала — свежая синхронизация с реконсиляцией прямо перед выборкой кандидатов.
    // Это сужает окно гонки "клиент вручную забрал заказ в своём ЛК WB, пока мы не
    // успели сформировать волну" до секунд: любой заказ, который WB уже не считает
    // новым, будет помечен status='external' и не попадёт в выборку ниже.
    await wbService.syncOrdersForAccount({ tenantId: req.user.tenantId, accountId, apiToken: acc.api_token, clientId: acc.client_id });

    // Список складов WB тоже подтягиваем по свежему — чтобы флаг
    // is_enabled_for_picking ниже применялся к актуальному набору складов
    // (некритично: если WB недоступен, используем то, что уже засинкано).
    try {
      await wbService.syncSellerWarehouses({ tenantId: req.user.tenantId, mpAccountId: accountId });
    } catch (e) {
      logger.warn({ err: e, accountId }, 'syncSellerWarehouses failed before generate-wave, using cached list');
    }

    // Заказы без поставки. Склады WB, явно выключенные админом этого тенанта
    // (is_enabled_for_picking=FALSE — «этот склад обслуживает другой ФФ»),
    // из выборки исключаем. Склад без настройки (ещё не засинкан/неизвестен)
    // остаётся включённым — обратная совместимость с прежним поведением.
    const ordersRes = await query(
      `SELECT o.wb_order_id, o.barcode, o.warehouse_id, o.warehouse_name
       FROM wms.wb_orders o
       WHERE o.tenant_id=$1 AND o.mp_account_id=$2 AND o.wb_supply_id IS NULL
         AND COALESCE(o.status,'') NOT IN ('confirm','complete','cancel','external')
         AND NOT EXISTS (
           SELECT 1 FROM wms.wb_seller_warehouses w
           WHERE w.mp_account_id=o.mp_account_id AND w.wb_warehouse_id=o.warehouse_id
             AND w.is_enabled_for_picking=FALSE
         )
       ORDER BY o.created_at ASC LIMIT $3`,
      [req.user.tenantId, accountId, limitOrders]
    );
    if (ordersRes.rowCount === 0) return res.json({ ok:true, message:'No orders without supply', supplies:[] });

    // Не включаем в волну заказы, по которым сейчас физически нет доступного
    // остатка (обсуждение с пользователем 10.09.2026) — раньше такой заказ
    // всё равно улетал в поставку ВБ, а на сборке благополучно "зависал"
    // или пропускался, разбираться приходилось постфактум. Правильнее не
    // создавать поставку под то, чего нет: заказ остаётся непривязанным
    // (wb_supply_id остаётся NULL) и естественным образом попадёт в
    // СЛЕДУЮЩИЙ запуск формирования волны, когда остаток появится — обычный
    // путь для новых заказов, ничего специального делать не надо.
    // Резолвим баркод в item_id через ту же alias-логику, что и everywhere
    // else (см. миграцию 060) — иначе для товаров с двумя штрихкодами ВБ
    // остаток по "не основному" баркоду тут не найдётся.
    const uniqueBarcodes = [...new Set(ordersRes.rows.map(r => String(r.barcode||'').trim()).filter(Boolean))];
    const itemIdByBarcode = new Map();
    for (const b of uniqueBarcodes) {
      const found = await findItemIdByBarcode({ tenantId: req.user.tenantId, clientId: acc.client_id, barcode: b });
      if (found && found.is_active) itemIdByBarcode.set(b, found.id);
    }
    const involvedItemIds = [...new Set(itemIdByBarcode.values())];

    // Пул остатков (миграция 061) — физический остаток нужно смотреть у
    // пул-клиента, если товар с ним связан, иначе поведение как раньше.
    // resolveStockKey для тенантов без пулинга просто возвращает те же
    // itemId/clientId, что и переданы — без этого товары, чей остаток лежит
    // в пуле, ложно считались бы отсутствующими и заказ вечно не попадал бы
    // в волну (поймано пользователем в обсуждении фичи).
    const stockKeyByItemId = new Map();
    for (const itemId of involvedItemIds) {
      stockKeyByItemId.set(itemId, await resolveStockKey({ tenantId: req.user.tenantId, itemId, clientId: acc.client_id }));
    }
    // Группируем по (реальному) client_id остатка — обычно один и тот же для
    // всех (acc.client_id, если пулинга нет вовсе), но пулинг может увести
    // часть товаров под client_id пула, а часть оставить как есть.
    const itemIdsByStockClient = new Map();
    for (const [itemId, key] of stockKeyByItemId) {
      if (!itemIdsByStockClient.has(key.stockClientId)) itemIdsByStockClient.set(key.stockClientId, []);
      itemIdsByStockClient.get(key.stockClientId).push(key.stockItemId);
    }
    const availByStockKey = new Map(); // `${stockClientId}:${stockItemId}` -> qty
    for (const [stockClientId, stockItemIds] of itemIdsByStockClient) {
      const availRes = await query(
        `SELECT item_id, COALESCE(SUM(qty_available),0)::int AS qty
         FROM wms.stock_balances
         WHERE tenant_id=$1 AND warehouse_id=$2 AND client_id=$3 AND item_id=ANY($4::int[])
         GROUP BY item_id`,
        [req.user.tenantId, wh.id, stockClientId, [...new Set(stockItemIds)]]
      );
      for (const row of availRes.rows) availByStockKey.set(`${stockClientId}:${row.item_id}`, row.qty);
    }
    // Заказы уже отсортированы по created_at ASC (см. запрос выше) — при
    // нехватке остатка на несколько заказов одного товара в волну попадают
    // более старые, остальные ждут следующего раза (справедливо по очереди).
    //
    // ВАЖНО про пул: несколько РАЗНЫХ original item_id (разных клиентов)
    // могут резолвиться в ОДИН и тот же пуловый stock-ключ — расход обязан
    // списываться из ОБЩЕГО availByStockKey (а не из копии на каждый
    // original item_id по отдельности), иначе заказы двух клиентов на один
    // пуловый товар в одном запуске формирования волны задвоили бы остаток
    // (каждый "видел" бы полный пуловый остаток независимо от другого).
    const stockFilteredRows = [];
    const stockShortageByBarcode = new Map(); // barcode -> {count, itemName}
    for (const row of ordersRes.rows) {
      const b = String(row.barcode||'').trim();
      const itemId = itemIdByBarcode.get(b);
      const stockKey = itemId != null ? stockKeyByItemId.get(itemId) : null;
      const stockMapKey = stockKey ? `${stockKey.stockClientId}:${stockKey.stockItemId}` : null;
      const remaining = stockMapKey != null ? (availByStockKey.get(stockMapKey) ?? 0) : 0;
      if (itemId != null && remaining > 0) {
        availByStockKey.set(stockMapKey, remaining - 1);
        stockFilteredRows.push(row);
      } else {
        const cur = stockShortageByBarcode.get(b) || 0;
        stockShortageByBarcode.set(b, cur + 1);
      }
    }
    const stockShortage = [...stockShortageByBarcode.entries()].map(([barcode, orders_skipped]) => ({ barcode, orders_skipped }));
    if (!stockFilteredRows.length) {
      return res.json({ ok:true, message:'No orders with available stock', supplies:[], stock_shortage: stockShortage });
    }

    // Группируем по складу WB
    const groups = new Map();
    for (const row of stockFilteredRows) {
      const key = String(row.warehouse_id||'')+'|'+(row.warehouse_name||'');
      if (!groups.has(key)) groups.set(key, { warehouse_id:row.warehouse_id, warehouse_name:row.warehouse_name, orders:[] });
      groups.get(key).orders.push(row);
    }

    const suppliesResult = [];
    for (const [, group] of groups) {
      const orderIds = group.orders.map(o=>Number(o.wb_order_id)).filter(x=>x>0);
      if (!orderIds.length) continue;

      const supplyName = `WMS2-${accountId}-${group.warehouse_name||'WH'}-${Date.now()}`;
      const supplyBody = await wbClient.createSupply(acc.api_token, supplyName);
      const rawSupplyId = String(supplyBody.id||supplyBody.supplyId||'').trim();
      if (!rawSupplyId) throw new Error('WB did not return supply ID');
      const shipmentCode = wbClient.normalizeShipmentCode(rawSupplyId);

      // Даже после ресинка выше остаётся микроскопическое окно гонки (пока мы
      // создаём поставку и готовим этот запрос, клиент теоретически успевает
      // забрать заказ вручную в ЛК WB) — а иногда WB отклоняет конкретный
      // заказ совсем по другой причине, из-за которой он НЕ пропадает из
      // списка "новых" (несовместимость с этой конкретной поставкой и т.п.).
      // Раньше повторная попытка убирала из пачки только заказы, пропавшие
      // из свежего списка "новых" — если причина была другой, финальный
      // список не менялся, повторная попытка падала с ТОЙ ЖЕ ошибкой, и это
      // исключение было некому ловить: оно пробрасывалось наверх уже ПОСЛЕ
      // того, как WB.createSupply() выше успел создать поставку на своей
      // стороне — а локальная транзакция (shipments/picking_tasks) так и не
      // выполнялась. Поставка оставалась существовать в кабинете WB, будучи
      // полностью невидимой в ВМС (реальный инцидент 15-16.09.2026,
      // WB-GI-278465437 — WB отклонил заказ 5770391750, который остался в
      // списке "новых").
      //
      // Теперь: до 3 попыток, на каждой неудаче убираем и заказы, которые WB
      // явно назвал отклонёнными в теле ошибки (extractRejectedOrderIds —
      // разбирает несколько известных форм ответа WB), и — как раньше —
      // заказы, пропавшие из свежего списка "новых". Если конкретную причину
      // распознать не удалось (не выявлено ни одного отклонённого id, а
      // список "новых" не изменился) — дальше повторять бессмысленно
      // (упадёт идентично), сдаёмся. Но, в отличие от старого поведения,
      // если после всего этого не осталось НИ ОДНОГО заказа — исключение
      // наверх больше не пробрасывается: пишем shipment с status='error'
      // (миграция 062), чтобы уже созданная на WB стороне поставка осталась
      // видна в ВМС, а не терялась молча так же, как в прошлый раз.
      let finalOrderIds = orderIds;
      let droppedOrderIds = [];
      let lastAddError = null;
      let addSucceeded = false;
      // Ограничение по числу ИТЕРАЦИЙ ПОДРЕЗКИ (не "попыток отправить, что
      // есть") — цикл всегда завершается ЛИБО успешным addOrdersToSupply с
      // ТЕКУЩИМ (уже подрезанным) списком, ЛИБО явной сдачей (см. ниже).
      // Раньше эта грань была смазана: после последней подрезки список мог
      // просто ни разу не быть переотправлен внутри лимита попыток, и код
      // ниже принял бы недобавленные заказы за успешно добавленные.
      const MAX_TRIM_ROUNDS = 5;

      for (let round = 0; round <= MAX_TRIM_ROUNDS; round++) {
        if (!finalOrderIds.length) break;
        try {
          await wbClient.addOrdersToSupply(acc.api_token, rawSupplyId, finalOrderIds);
          addSucceeded = true;
          lastAddError = null;
          break;
        } catch (e) {
          lastAddError = e;
          logger.warn(
            { err: e, accountId, rawSupplyId, round, orderIds: finalOrderIds, wbBody: e.wbBody },
            'WB addOrdersToSupply failed, re-checking against fresh WB state'
          );

          if (round === MAX_TRIM_ROUNDS) {
            // Лимит подрезок исчерпан, а WB всё ещё отклоняет — дальше не
            // выясняем, сдаёмся с тем, что осталось непосланным.
            droppedOrderIds.push(...finalOrderIds);
            finalOrderIds = [];
            break;
          }

          const rejectedByBody = extractRejectedOrderIds(e.wbBody);
          let survivors;
          if (rejectedByBody.length) {
            survivors = finalOrderIds.filter(id => !rejectedByBody.includes(id));
          } else {
            const freshOrders = await wbClient.fetchNewOrders(acc.api_token).catch(() => null);
            if (freshOrders) {
              const freshIdSet = new Set(freshOrders.map(o => Number(o.id||o.odid||o.orderId)).filter(Boolean));
              survivors = finalOrderIds.filter(id => freshIdSet.has(id));
            } else {
              survivors = finalOrderIds; // не смогли перепроверить — состав не меняем на этом шаге
            }
          }

          if (survivors.length === finalOrderIds.length) {
            // Ни явно отклонённых id, ни расхождений со свежим списком —
            // причину распознать не удалось, повтор с тем же списком упадёт
            // идентично. Сдаёмся: весь оставшийся список считаем отвалившимся.
            droppedOrderIds.push(...finalOrderIds);
            finalOrderIds = [];
            break;
          }
          droppedOrderIds.push(...finalOrderIds.filter(id => !survivors.includes(id)));
          finalOrderIds = survivors; // цикл идёт на следующий round и ОТПРАВЛЯЕТ этот подрезанный список
        }
      }

      // Страховка: если по каким-то причинам вышли из цикла с непустым
      // списком, но без подтверждённого успеха (не должно происходить при
      // такой структуре цикла выше, но лучше не молчать, если всё же
      // случится) — считаем это неуспехом, а не тихим "как будто добавили".
      if (finalOrderIds.length && !addSucceeded) {
        droppedOrderIds.push(...finalOrderIds);
        finalOrderIds = [];
      }

      if (droppedOrderIds.length) {
        await query(
          `UPDATE wms.wb_orders SET status='external', fetched_at=NOW()
           WHERE tenant_id=$1 AND mp_account_id=$2 AND wb_order_id=ANY($3::bigint[])`,
          [req.user.tenantId, accountId, droppedOrderIds]
        );
      }

      if (!finalOrderIds.length) {
        // Ничего добавить не удалось вообще — поставка на стороне WB уже
        // создана (rawSupplyId) и осталась пустой. Раньше здесь бросалось
        // исключение, и поставка терялась молча (см. комментарий выше) —
        // теперь вместо этого фиксируем её в ВМС явным статусом 'error',
        // чтобы диспетчер сразу увидел зависшую поставку и разобрался
        // руками (отменить в кабинете WB либо, если причина временная,
        // добавить заказы в неё вручную позже), а не узнавал о ней
        // постфактум, когда она уже "зависла на сборке".
        await query(
          `INSERT INTO wms.shipments(tenant_id,warehouse_id,client_id,external_id,marketplace,status,created_by)
           VALUES($1,$2,$3,$4,'wb','error',$5)
           ON CONFLICT(tenant_id,external_id) DO NOTHING`,
          [req.user.tenantId, wh.id, acc.client_id, shipmentCode, req.user.id]
        );
        logger.error(
          { accountId, rawSupplyId, shipmentCode, orderIds, lastErr: lastAddError && lastAddError.message, wbBody: lastAddError && lastAddError.wbBody },
          'generate-wave: could not add any orders to WB supply — recorded as shipment status=error for visibility instead of throwing'
        );
        suppliesResult.push({
          supply_id:      rawSupplyId,
          shipment_code:  shipmentCode,
          orders_count:   0,
          tasks_inserted: 0,
          stickers_saved: 0,
          dropped_count:  droppedOrderIds.length,
          dropped_orders: droppedOrderIds,
          error: lastAddError ? lastAddError.message : 'WB отклонил все заказы группы',
        });
        continue;
      }

      const keptRows = droppedOrderIds.length
        ? group.orders.filter(o => finalOrderIds.includes(Number(o.wb_order_id)))
        : group.orders;

      // Стикеры
      const stickers = await wbClient.fetchOrderStickers(acc.api_token, finalOrderIds).catch(()=>[]);

      await transaction(async (client) => {
        // Помечаем заказы поставкой
        await client.query(
          `UPDATE wms.wb_orders SET wb_supply_id=$1, status='confirm'
           WHERE tenant_id=$2 AND mp_account_id=$3 AND wb_order_id=ANY($4::bigint[])`,
          [rawSupplyId, req.user.tenantId, accountId, finalOrderIds]
        );

        // Сохраняем стикеры
        for (const st of stickers) {
          if (!st?.orderId || !st?.file) continue;
          const code = wbClient.extractStickerCode(st.file);
          await client.query(
            `UPDATE wms.wb_orders SET wb_sticker=$1, wb_sticker_code=$2
             WHERE tenant_id=$3 AND mp_account_id=$4 AND wb_order_id=$5`,
            [st.file, code, req.user.tenantId, accountId, Number(st.orderId)]
          );
        }

        // Поставка в wb_supplies
        await client.query(
          `INSERT INTO wms.wb_supplies(tenant_id,mp_account_id,supply_code) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
          [req.user.tenantId, accountId, rawSupplyId]
        );

        // Shipment
        await client.query(
          `INSERT INTO wms.shipments(tenant_id,warehouse_id,client_id,external_id,marketplace,status,created_by)
           VALUES($1,$2,$3,$4,'wb','new',$5) ON CONFLICT(tenant_id,external_id) DO UPDATE SET client_id=EXCLUDED.client_id`,
          [req.user.tenantId, wh.id, acc.client_id, shipmentCode, req.user.id]
        );

        // Волна
        await client.query(
          `INSERT INTO wms.pick_waves(tenant_id,warehouse_id,client_id,shipment_code,status,total_tasks,created_by)
           VALUES($1,$2,$3,$4,'open',0,$5) ON CONFLICT(tenant_id,shipment_code) DO NOTHING`,
          [req.user.tenantId, wh.id, acc.client_id, shipmentCode, req.user.id]
        );

        // Задачи на сборку (1 задача = 1 заказ)
        let insertedTasks = 0;
        for (const row of keptRows) {
          const b = String(row.barcode||'').trim();
          if (!b) continue;
          const itemId = await resolveOrCreateItem({ tenantId:req.user.tenantId, clientId:acc.client_id, barcode:b, dbClient:client });

          // Волна
          const waveRes = await client.query(
            `SELECT id FROM wms.pick_waves WHERE tenant_id=$1 AND shipment_code=$2 LIMIT 1`,
            [req.user.tenantId, shipmentCode]
          );
          const waveId = waveRes.rows[0]?.id;

          const dup = await client.query(
            `SELECT id FROM wms.picking_tasks WHERE tenant_id=$1 AND wb_order_id=$2 AND shipment_code=$3 LIMIT 1`,
            [req.user.tenantId, Number(row.wb_order_id), shipmentCode]
          );
          if (dup.rowCount === 0) {
            await client.query(
              `INSERT INTO wms.picking_tasks
                 (tenant_id,warehouse_id,client_id,wave_id,item_id,barcode,qty,status,priority,
                  wb_order_id,shipment_code,created_by,updated_by)
               VALUES($1,$2,$3,$4,$5,$6,1,'new',3,$7,$8,$9,$9)`,
              [req.user.tenantId,wh.id,acc.client_id,waveId,itemId,b,
               Number(row.wb_order_id),shipmentCode,req.user.id]
            );
            insertedTasks++;
          }
        }

        // Обновляем total_tasks волны
        await client.query(
          `UPDATE wms.pick_waves SET total_tasks=(SELECT COUNT(*)::int FROM wms.picking_tasks WHERE wave_id=pick_waves.id)
           WHERE tenant_id=$1 AND shipment_code=$2`,
          [req.user.tenantId, shipmentCode]
        );

        suppliesResult.push({
          supply_id:      rawSupplyId,
          shipment_code:  shipmentCode,
          orders_count:   finalOrderIds.length,
          tasks_inserted: insertedTasks,
          stickers_saved: stickers.length,
          dropped_count:  droppedOrderIds.length,
          dropped_orders: droppedOrderIds,
        });
      });
    }

    const totalDropped = suppliesResult.reduce((s,r)=>s+(r.dropped_count||0),0);
    res.json({ ok:true, created_supplies:suppliesResult.length, supplies:suppliesResult, dropped_total:totalDropped, stock_shortage: stockShortage });
  } catch(e){ next(e); }
});

// ─────────────── Просмотр данных ───────────────

router.get('/orders', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const { account_id, status, date_from, date_to, limit=200, offset=0 } = req.query;
    const params=[req.user.tenantId]; const conds=['o.tenant_id=$1']; let idx=2;
    if (account_id) { conds.push(`o.mp_account_id=$${idx++}`); params.push(Number(account_id)); }
    if (status)     { conds.push(`o.status=$${idx++}`); params.push(status); }
    if (date_from)  { conds.push(`o.created_at>=$${idx++}::date`); params.push(date_from); }
    if (date_to)    { conds.push(`o.created_at<($${idx++}::date+INTERVAL '1 day')`); params.push(date_to); }
    // Склады WB, явно выключенные админом этого тенанта в настройках
    // аккаунта ("этот склад обслуживает другой ФФ", is_enabled_for_picking=
    // FALSE) — не показываем в списке заказов вообще, той же логикой, что
    // уже применяется в /generate-wave (см. там же) — иначе список визуально
    // мешает чужие заказы с нашими, и непонятно, что реально попадёт в волну.
    // Склад без настройки (ещё не засинкан/неизвестен) остаётся включённым.
    conds.push(`NOT EXISTS (
      SELECT 1 FROM wms.wb_seller_warehouses w
      WHERE w.mp_account_id=o.mp_account_id AND w.wb_warehouse_id=o.warehouse_id
        AND w.is_enabled_for_picking=FALSE
    )`);
    // Отдельный запрос total — count:r.rowCount раньше выдавался за "общее
    // число заказов", хотя на деле был просто числом строк в текущей
    // странице (обрезанным лимитом) — из-за этого в UI не было видно
    // реального количества и нельзя было понять, сколько страниц пролистать.
    const totalRes = await query(
      `SELECT COUNT(*)::int AS n FROM wms.wb_orders o WHERE ${conds.join(' AND ')}`,
      params
    );
    const total = totalRes.rows[0].n;

    const limitIdx = idx++; const offsetIdx = idx++;
    params.push(Math.min(Number(limit),500), Math.max(Number(offset)||0, 0));
    // ВАЖНО: не SELECT o.* — в wb_orders на каждой строке лежит wb_sticker
    // (base64 SVG стикера) и raw (полный JSON-дамп ответа WB), оба могут
    // весить десятки КБ на заказ. Список заказов их не показывает и не
    // использует — раньше это тянуло по несколько МБ на каждую загрузку
    // страницы (при лимите до 1000 заказов) и было основной причиной
    // "долго загружаются заказы". Печать стикера читает wb_sticker отдельным
    // прицельным запросом (см. packing.service.js), сюда он не нужен.
    const r = await query(
      `SELECT o.id, o.mp_account_id, o.wb_order_id, o.article, o.barcode,
              o.warehouse_name, o.status, o.wb_supply_id, o.created_at,
              ma.account_name
       FROM wms.wb_orders o
       JOIN wms.mp_accounts ma ON ma.id=o.mp_account_id
       WHERE ${conds.join(' AND ')} ORDER BY o.created_at DESC NULLS LAST LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );
    res.json({ ok:true, orders:r.rows, count:r.rowCount, total, offset: Number(offset)||0, limit: Math.min(Number(limit),500) });
  } catch(e){ next(e); }
});

router.get('/items', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const { account_id, limit=50, offset=0 } = req.query;
    if (!account_id) return res.status(400).json({ ok:false, error:{code:'VALIDATION_ERROR',message:'account_id required'} });
    const r = await query(
      `SELECT wi.*, COUNT(wb.barcode) FILTER(WHERE wb.barcode IS NOT NULL)::int AS barcode_count
       FROM wms.wb_items wi
       LEFT JOIN wms.wb_item_barcodes wb ON wb.mp_account_id=wi.mp_account_id AND wb.nm_id=wi.nm_id
       WHERE wi.tenant_id=$1 AND wi.mp_account_id=$2
       GROUP BY wi.id ORDER BY wi.nm_id LIMIT $3 OFFSET $4`,
      [req.user.tenantId, Number(account_id), Math.min(Number(limit),200), Number(offset)]
    );
    const total = (await query(`SELECT COUNT(*)::int AS n FROM wms.wb_items WHERE tenant_id=$1 AND mp_account_id=$2`,[req.user.tenantId,Number(account_id)])).rows[0].n;
    res.json({ ok:true, items:r.rows, total });
  } catch(e){ next(e); }
});

/** GET /wb/return-claims — заявки покупателей на возврат (видимость, WB Returns API) */
router.get('/return-claims', requireRole('tenant_admin','supervisor','receiver'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    if (!clientId) return res.status(400).json({ ok:false, error:{code:'VALIDATION_ERROR',message:'client_id required'} });
    const isArchive = req.query.is_archive === 'true';
    const claims = await wbService.listReturnClaimsForClient({ tenantId: req.user.tenantId, clientId, isArchive });
    res.json({ ok:true, claims });
  } catch(e){ next(e); }
});

module.exports = router;
