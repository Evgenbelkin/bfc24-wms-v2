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
const { validatePositiveInt } = require('../../utils/validators');
const { resolveOrCreateItem, findItemIdByBarcode, resolveStockKey } = require('../masterdata/items/items.service');
const { getDefaultWarehouse } = require('../warehouses/warehouses.service');
const logger = require('../../utils/logger');

router.use(authRequired, tenantMiddleware, requireModule('wb_integration'));

// ─────────────── Helpers ───────────────

const getMpAccount = wbService.getMpAccount;

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
         ma.settings->'stats_sync'->>'last_success_at' AS stats_last_success_at,
         ma.settings->'stats_sync'->>'last_error' AS stats_last_error,
         ma.settings->'stats_sync'->>'last_error_at' AS stats_last_error_at,
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
    // reconcile:false — та же причина, что и в /generate-wave (см. комментарий
    // там же): это ручной клик под давлением "хочу увидеть заказы прямо
    // сейчас", а не терпеливый фоновый опрос — не тот контекст, где стоит
    // рисковать ошибочно отправить заказ в 'external' по одному шаткому ответу WB.
    const result = await wbService.syncOrdersForAccount({ tenantId: req.user.tenantId, accountId, apiToken: acc.api_token, clientId: acc.client_id, reconcile: false });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

// Синхронизировать заказы по ВСЕМ активным WB-аккаунтам клиентов этого тенанта за один клик
router.post('/sync-orders-all', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    // reconcile:false — см. комментарий в syncAllAccountsForTenant/wb.service.js:
    // это ручной клик, не терпеливый фоновый опрос.
    const results = await wbService.syncAllAccountsForTenant(req.user.tenantId, { reconcile: false });
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
    // Потолок поднят 500 -> 1000 (обсуждение с пользователем 16.09.2026).
    // Раньше реальным ограничителем всё равно был лимит WB на addOrdersToSupply
    // (100 заказов за один запрос) — теперь wb.client.js сам бьёт на пачки
    // по 100 и шлёт их последовательно на одну поставку, так что здесь можно
    // спокойно пускать значительно больше за один клик "Сформировать волну".
    const limitOrders = Math.min(Number(req.body.limit)||50, 1000);
    const acc = await getMpAccount(req.user.tenantId, accountId);
    const wh = await getDefaultWarehouse(req.user.tenantId);

    // Сначала — свежая синхронизация с реконсиляцией прямо перед выборкой кандидатов.
    // Это сужает окно гонки "клиент вручную забрал заказ в своём ЛК WB, пока мы не
    // успели сформировать волну" до секунд: любой заказ, который WB уже не считает
    // новым, будет помечен status='external' и не попадёт в выборку ниже.
    //
    // ВАЖНО (инцидент 17.09.2026, ИП Макарова С.И.): раньше этот вызов не был
    // обёрнут в try/catch - когда WB API токен аккаунта становится невалидным
    // (клиент перевыпустил токен в своём ЛК WB, старый умер), WB отвечает 401
    // "token is malformed" - это рушило ВЕСЬ запрос /generate-wave необработанным
    // исключением, и диспетчер видел только общее "An unexpected error occurred"
    // без единой подсказки, что вообще случилось. Явную ошибку токена (401 /
    // "unauthorized" / "token") показываем сразу понятным сообщением - дальше
    // всё равно ничего не сделать, все остальные вызовы WB API в этом же
    // запросе (addOrdersToSupply и т.д.) упадут той же причиной. Любую ДРУГУЮ
    // (сетевую/временную) ошибку синка - не рушим запрос, работаем с уже
    // известными в БД заказами (заказы и так подтягиваются в фоне отдельной
    // джобой, см. подсказку в wb.html).
    try {
      // ФИКС 23.09.2026 (ИП Китай: "41 заказ(ов) исключено - Забрано в ЛК
      // WB", хотя в кабинете WB все 41 висели как Новые - воспроизвелось
      // повторно даже после защиты "два пропуска подряд" в
      // fetchAndUpsertOrders, см. комментарий там же): presync перед волной
      // происходит ИМЕННО в момент давления пользователя на кнопку - если
      // именно сейчас WB отдал неполный ответ (а у этого аккаунта, похоже,
      // бывает нестабильно), нельзя тут же наказывать заказ статусом
      // 'external' - слишком высокая цена одной неудачной попытки. Решение
      // "заказ реально забрали в обход нас" теперь принимает ТОЛЬКО фоновая
      // синхронизация (wbAutoSync.js, опрашивает многократно) - reconcile:false
      // здесь всё равно подтягивает новые заказы и самоисцеляет уже ошибочно
      // помеченные 'external' (это безусловно, см. CASE в UPSERT), просто
      // сам никого новым в 'external' не отправляет.
      await wbService.syncOrdersForAccount({ tenantId: req.user.tenantId, accountId, apiToken: acc.api_token, clientId: acc.client_id, reconcile: false });
    } catch (e) {
      const looksLikeAuthError = e.wbStatus === 401 || /unauthorized|token/i.test(e.message || '');
      if (looksLikeAuthError) {
        throw new ValidationError(
          `Не удалось обновить заказы из WB: токен API аккаунта "${acc.account_name}" недействителен (WB: ${e.message}). Обновите токен в разделе "МР Аккаунты".`
        );
      }
      logger.warn({ err: e, accountId }, 'syncOrdersForAccount failed before generate-wave, using cached orders');
    }

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
    //
    // ВАЖНО (обсуждение с пользователем 16.09.2026): лимит из запроса
    // (limitOrders, «сколько заказов в волну») здесь НЕ применяем - раньше
    // LIMIT стоял прямо в этом SQL, то есть отбирались limitOrders САМЫХ
    // СТАРЫХ заказов-кандидатов ДО проверки остатка, и только потом их
    // фильтровали по наличию (см. ниже). Если среди этих первых N по дате
    // заказов преобладал дефицитный товар - волна не формировалась вообще
    // (0 заказов проходило фильтр), хотя дальше по очереди могли быть сотни
    // нормальных заказов с реальным остатком. Правильно: тянуть кандидатов с
    // большим запасом (CANDIDATE_POOL_LIMIT), фильтровать по остатку в
    // порядке created_at ASC и ТОЛЬКО тогда останавливаться на limitOrders
    // УЖЕ ГОТОВЫХ к сборке заказов (см. stockFilteredRows ниже).
    const CANDIDATE_POOL_LIMIT = 5000;
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
      [req.user.tenantId, accountId, CANDIDATE_POOL_LIMIT]
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
      // ВАЖНО (найдено 21.09.2026, репорт ЭсЭнДи): раньше здесь суммировался
      // qty_available по ВСЕМ ячейкам склада без исключения, включая
      // "Карантин" (location_type='quarantine', is_pick_location=FALSE) - ту
      // самую виртуальную ячейку, куда skipTask() физически переносит
      // "фантомный" остаток при пропуске сборщиком (см. getOrCreateQuarantineLocation
      // и комментарий там же). Из-за этого пропущенный товар продолжал
      // считаться "в наличии" для /generate-wave и попадал в КАЖДУЮ следующую
      // волну заново - ровно до тех пор, пока кто-то вручную не разбирал
      // карантинную ячейку. findBestPickLocation (сборка) и стоковый пуш в WB
      // (wb.service.js, чуть выше по файлу) уже фильтруют is_pick_location=TRUE
      // именно по этой причине - тут этот фильтр отсутствовал, теперь тоже
      // джойним на wms.locations и считаем только реальные pick-ячейки.
      const availRes = await query(
        `SELECT sb.item_id, COALESCE(SUM(sb.qty_available),0)::int AS qty
         FROM wms.stock_balances sb
         JOIN wms.locations l ON l.id = sb.location_id
         WHERE sb.tenant_id=$1 AND sb.warehouse_id=$2 AND sb.client_id=$3 AND sb.item_id=ANY($4::int[])
           AND l.is_pick_location = TRUE
         GROUP BY sb.item_id`,
        [req.user.tenantId, wh.id, stockClientId, [...new Set(stockItemIds)]]
      );
      for (const row of availRes.rows) availByStockKey.set(`${stockClientId}:${row.item_id}`, row.qty);
    }

    // Уже "занято" другими волнами/сборками, которые ещё физически не
    // выполнены (picking_tasks не в 'done'/'cancelled'), но остаток на
    // складе ЕЩЁ не списан — списание происходит только в момент реального
    // скана на сборке (см. picking.service.js consumeStock), а не в момент
    // создания задачи. Раньше проверка видела только заказы ВНУТРИ ТЕКУЩЕГО
    // запроса (decrement availByStockKey был чисто in-memory и терялся между
    // HTTP-вызовами) — если "Сформировать волну" вызывали несколько раз
    // подряд (например, из-за лимита в 100 заказов за раз, или два разных
    // магазина одного пула кликали примерно одновременно), каждый вызов
    // видел один и тот же ещё не уменьшенный stock_balances и независимо
    // решал, что товара хватает на ЕГО заказы — на деле хватало только на
    // один из вызовов (инцидент 16.09.2026: WB-GI-278867012/057/120 у ООО
    // Эсэндди, три волны созданы за 18 секунд, часть задач осталась без
    // остатка и ушла в 'skipped').
    //
    // Полноценное резервирование (wms.stock_reservations/qty_reserved) здесь
    // сознательно не заводим — это бы потребовало согласованных правок и в
    // picking.service.js (учёт и снятие резерва при реальном скане), а трогать
    // боевой флоу сборки без тестирования на отдельной ветке рискованно (см.
    // недавний случай с фокусом на ТСД в этом же чате). Вместо этого просто
    // вычитаем из остатка то, что уже "числится" в НЕзавершённых задачах
    // сборки по ЛЮБЫМ item_id, резолвящимся в тот же пуловый stock-ключ (не
    // только по original item_id текущего аккаунта) — это не защищает от
    // двух truly-одновременных запросов день-в-день до миллисекунды, но
    // полностью закрывает наблюдаемый сценарий (повторные вызовы с разницей
    // в секунды), и не меняет ничего в самой сборке/списании.
    const allStockItemIds = [...new Set([...itemIdsByStockClient.values()].flat())];
    if (allStockItemIds.length) {
      const poolSourcesRes = await query(
        `SELECT item_id, pool_item_id FROM wms.item_pool_links
         WHERE tenant_id=$1 AND pool_item_id = ANY($2::int[])`,
        [req.user.tenantId, allStockItemIds]
      );
      // stockItemId -> список item_id, чьи незавершённые задачи сборки
      // расходуют именно этот физический остаток: сам stockItemId (напрямую,
      // без пула) + все original item_id, связанные с ним через пул.
      const sourceItemIdsByStockItemId = new Map();
      for (const id of allStockItemIds) sourceItemIdsByStockItemId.set(id, [id]);
      for (const row of poolSourcesRes.rows) {
        sourceItemIdsByStockItemId.get(row.pool_item_id)?.push(row.item_id);
      }
      const allSourceItemIds = [...new Set([...sourceItemIdsByStockItemId.values()].flat())];

      const pendingRes = await query(
        `SELECT item_id, COALESCE(SUM(qty - qty_picked),0)::int AS pending
         FROM wms.picking_tasks
         WHERE tenant_id=$1 AND item_id=ANY($2::int[]) AND status NOT IN ('done','cancelled')
         GROUP BY item_id`,
        [req.user.tenantId, allSourceItemIds]
      );
      const pendingByItemId = new Map(pendingRes.rows.map(r => [r.item_id, r.pending]));

      for (const [stockClientId, stockItemIds] of itemIdsByStockClient) {
        for (const stockItemId of new Set(stockItemIds)) {
          const sources = sourceItemIdsByStockItemId.get(stockItemId) || [stockItemId];
          const pending = sources.reduce((s, id) => s + (pendingByItemId.get(id) || 0), 0);
          if (pending <= 0) continue;
          const mapKey = `${stockClientId}:${stockItemId}`;
          const cur = availByStockKey.get(mapKey) ?? 0;
          availByStockKey.set(mapKey, Math.max(0, cur - pending));
        }
      }
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
      // Набрали запрошенное лимитом кол-во ГОТОВЫХ к сборке заказов - дальше
      // по списку кандидатов не идём (они либо тоже в наличии и уйдут в
      // следующий запуск волны, либо дефицитные - тоже неважно сейчас).
      if (stockFilteredRows.length >= limitOrders) break;
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
      let supplyBody;
      try {
        supplyBody = await wbClient.createSupply(acc.api_token, supplyName);
      } catch (e) {
        // 17.09.2026 (ИП Макарова С.И., инцидент): createSupply() раньше не
        // был обёрнут в try/catch - системная ошибка на ЭТОМ вызове (сеть,
        // временный 5xx/рейт-лимит WB) рушила ВЕСЬ запрос /generate-wave
        // целиком ("An unexpected error occurred" в UI), и даже группы
        // заказов, которые шли бы дальше по циклу без проблем, вообще не
        // обрабатывались. Как и у addOrdersToSupply ниже - одна неудачная
        // группа (обычно это последняя пара "хвостовых" заказов) не должна
        // рушить остальные и не должна ронять весь клик "Сформировать
        // волну": фиксируем ошибку по этой группе и идём дальше по циклу.
        logger.error(
          { err: e, accountId, warehouseId: group.warehouse_id, warehouseName: group.warehouse_name, orderIds },
          'generate-wave: WB createSupply failed for group - skipping this group, others continue'
        );
        suppliesResult.push({
          supply_id: null, shipment_code: null, warehouse_name: group.warehouse_name,
          orders_count: 0, tasks_inserted: 0, stickers_saved: 0,
          dropped_count: orderIds.length, dropped_orders: orderIds,
          error: `Не удалось создать поставку в WB: ${e.message}`,
        });
        continue;
      }
      const rawSupplyId = String(supplyBody.id||supplyBody.supplyId||'').trim();
      if (!rawSupplyId) {
        logger.error(
          { accountId, warehouseId: group.warehouse_id, warehouseName: group.warehouse_name, orderIds, supplyBody },
          'generate-wave: WB createSupply returned no id - skipping this group, others continue'
        );
        suppliesResult.push({
          supply_id: null, shipment_code: null, warehouse_name: group.warehouse_name,
          orders_count: 0, tasks_inserted: 0, stickers_saved: 0,
          dropped_count: orderIds.length, dropped_orders: orderIds,
          error: 'WB не вернул ID поставки',
        });
        continue;
      }
      const shipmentCode = wbClient.normalizeShipmentCode(rawSupplyId);

      // addOrdersToSupply сама бьёт список на пачки по WB-лимиту (100 за
      // запрос — см. wb.client.js) и сама разбирается с отклонёнными WB
      // заказами по пачке (extractRejectedOrderIds) — одна плохая пачка не
      // рушит все остальные. Она НЕ бросает исключение при частичном отказе
      // (только при системной ошибке — нет токена, сеть, 5xx), поэтому здесь
      // просто читаем результат, без собственного retry-цикла.
      let addedCount = 0;
      let droppedOrderIds = [];
      let unconfirmedDroppedOrderIds = [];
      let hardError = null;
      try {
        const addResult = await wbClient.addOrdersToSupply(acc.api_token, rawSupplyId, orderIds);
        addedCount = addResult.addedCount;
        droppedOrderIds = addResult.droppedOrderIds;
        unconfirmedDroppedOrderIds = addResult.unconfirmedDroppedOrderIds;
      } catch (e) {
        // Системная ошибка (не заказ-специфичная) — раньше пробрасывалась
        // наверх необработанной уже ПОСЛЕ того, как WB.createSupply() выше
        // успел создать поставку на своей стороне, оставляя её невидимой в
        // ВМС (реальный инцидент 15-16.09.2026, WB-GI-278465437). Вместо
        // этого считаем группу полностью неудавшейся и записываем её ниже
        // явным статусом 'error' (миграция 062), а не теряем молча.
        hardError = e;
        logger.warn({ err: e, accountId, rawSupplyId, orderIds, wbBody: e.wbBody }, 'WB addOrdersToSupply hard-failed');
        // ФИКС 23.09.2026: системная ошибка здесь тоже НЕ заказ-специфичная -
        // это сбой самого вызова (токен/сеть/5xx), а не то, что WB назвал
        // именно ЭТИ заказы проблемными. Раньше это тоже уходило в
        // droppedOrderIds и все заказы группы помечались 'external' - см.
        // тот же баг, что и с wholesale-отказом ниже.
        unconfirmedDroppedOrderIds = orderIds.slice();
      }
      const finalOrderIds = orderIds.filter(id => !droppedOrderIds.includes(id) && !unconfirmedDroppedOrderIds.includes(id));

      // ФИКС 23.09.2026 (ИП Китай, "Создано поставок: 5 — заказов: 0" по
      // всем подряд, хотя в кабинете WB заказы висели живыми "Новыми"):
      // status='external' ставим ТОЛЬКО для droppedOrderIds - заказов,
      // которых WB явно и точечно назвал проблемными (см. комментарий в
      // wb.client.js::addOrdersToSupply). unconfirmedDroppedOrderIds - когда
      // WB отклонил всю/почти всю пачку разом и точечного виновника выделить
      // не удалось - НЕ трогаем статус вообще: заказ остаётся 'new' и
      // естественным образом попадёт в следующую попытку формирования волны.
      // Раньше оба случая считались одним и тем же, и один "оптовый" отказ
      // WB по целой поставке мгновенно и массово хоронил десятки реально
      // живых заказов в 'external'.
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
          { accountId, rawSupplyId, shipmentCode, orderIds, hardErr: hardError && hardError.message },
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
          unconfirmed_dropped_count: unconfirmedDroppedOrderIds.length,
          unconfirmed_dropped_orders: unconfirmedDroppedOrderIds,
          error: hardError ? hardError.message : 'WB отклонил все заказы группы',
        });
        continue;
      }

      const keptRows = (droppedOrderIds.length || unconfirmedDroppedOrderIds.length)
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
          unconfirmed_dropped_count: unconfirmedDroppedOrderIds.length,
          unconfirmed_dropped_orders: unconfirmedDroppedOrderIds,
        });
      });
    }

    // ФИКС 23.09.2026: разделяем в ответе два РАЗНЫХ по смыслу счётчика -
    // dropped_total (WB точечно назвал этот заказ проблемным, мы пометили
    // 'external' - действительно "забрано в ЛК WB" или похожая причина) и
    // unconfirmed_dropped_total (WB отклонил пачку целиком, виновника не
    // нашли, статус заказа НЕ трогали - он остался 'new' и попадёт в
    // следующую попытку). Раньше это было одно и то же число с одной и той
    // же надписью "Забрано в ЛК WB" - вводило в заблуждение, когда реальная
    // причина была не в заказах, а в самой поставке/токене.
    const totalDropped = suppliesResult.reduce((s,r)=>s+(r.dropped_count||0),0);
    const totalUnconfirmedDropped = suppliesResult.reduce((s,r)=>s+(r.unconfirmed_dropped_count||0),0);
    res.json({
      ok:true, created_supplies:suppliesResult.length, supplies:suppliesResult,
      dropped_total:totalDropped, unconfirmed_dropped_total:totalUnconfirmedDropped,
      stock_shortage: stockShortage,
    });
  } catch(e){ next(e); }
});

// ─────────────── Поставки "Дефициты" (см. миграцию 071) ───────────────

/** GET /wb/deficit-supplies — список "копящихся" поставок Дефициты тенанта,
 *  для отдельной вкладки в диспетчерской. */
router.get('/deficit-supplies', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const rows = await wbService.listAccumulatingDeficitSupplies(req.user.tenantId);
    res.json({ ok:true, rows });
  } catch(e){ next(e); }
});

/** GET /wb/deficit-supplies/:id — состав "копящейся" поставки Дефициты
 *  (какие заказы/товары в неё уже попали) — детализация по клику на карточку
 *  в диспетчерской (21.09.2026). */
router.get('/deficit-supplies/:id', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const result = await wbService.getDeficitSupplyDetail({
      tenantId: req.user.tenantId,
      deficitSupplyId: validatePositiveInt(req.params.id, 'id'),
    });
    res.json({ ok:true, ...result });
  } catch(e){ next(e); }
});

/** POST /wb/deficit-supplies/:id/launch — "Запустить дефициты": оборачивает
 *  уже существующую в ВБ поставку Дефициты в обычную волну сборки (без
 *  повторных createSupply/addOrdersToSupply — заказы там уже есть) и сразу
 *  заводит новую "копящуюся" поставку под тот же склад. */
router.post('/deficit-supplies/:id/launch', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const wh = await getDefaultWarehouse(req.user.tenantId);
    const result = await wbService.launchDeficitSupply({
      tenantId: req.user.tenantId,
      deficitSupplyId: validatePositiveInt(req.params.id, 'id'),
      warehouseId: wh.id,
      actorUserId: req.user.id,
    });
    res.json({ ok:true, ...result });
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
