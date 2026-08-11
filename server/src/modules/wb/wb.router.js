'use strict';

const express = require('express');
const router = express.Router();
const { query, transaction } = require('../../config/database');
const wbClient = require('./wb.client');
const wbService = require('./wb.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware, resolveClientScope } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { requireModule } = require('../../middleware/tenant');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const { resolveOrCreateItem } = require('../masterdata/items/items.service');
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
         (ma.api_token IS NOT NULL AND length(trim(ma.api_token))>0) AS has_token,
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
    const { client_id, marketplace='wb', account_name, account_code, supplier_id, api_token } = req.body;
    const clientId = resolveClientScope(req, client_id);
    const r = await query(
      `INSERT INTO wms.mp_accounts(tenant_id,client_id,marketplace,account_name,account_code,supplier_id,api_token,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,client_id,marketplace,account_name,is_active`,
      [req.user.tenantId, clientId, marketplace, account_name, account_code||null, supplier_id||null, api_token||null, req.user.id]
    );
    res.status(201).json({ ok: true, account: r.rows[0] });
  } catch(e){ next(e); }
});

router.patch('/accounts/:id', requireRole('tenant_admin'), async (req,res,next)=>{
  try {
    const id = Number(req.params.id);
    const { account_name, account_code, supplier_id, api_token, is_active } = req.body;
    const fields=[]; const params=[]; let idx=1;
    if (account_name !== undefined) { fields.push(`account_name=$${idx++}`); params.push(account_name); }
    if (account_code !== undefined) { fields.push(`account_code=$${idx++}`); params.push(account_code||null); }
    if (supplier_id  !== undefined) { fields.push(`supplier_id=$${idx++}`);  params.push(supplier_id||null); }
    if (api_token    !== undefined) {
      fields.push(`api_token=CASE WHEN $${idx}::text='' THEN NULL ELSE $${idx}::text END`);
      params.push(api_token||''); idx++;
    }
    if (is_active !== undefined) { fields.push(`is_active=$${idx++}`); params.push(!!is_active); }
    if (!fields.length) return res.status(400).json({ ok:false, error:{code:'VALIDATION_ERROR',message:'No fields'} });
    fields.push(`updated_at=NOW()`); params.push(id, req.user.tenantId);
    const r = await query(
      `UPDATE wms.mp_accounts SET ${fields.join(',')} WHERE id=$${idx++} AND tenant_id=$${idx}
       RETURNING id,account_name,is_active,(api_token IS NOT NULL) AS has_token`,
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

router.patch('/accounts/:id/warehouses/:whId', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const accountId = Number(req.params.id);
    const whId = Number(req.params.whId);
    const { is_enabled_for_picking } = req.body;
    if (is_enabled_for_picking === undefined) throw new ValidationError('is_enabled_for_picking is required');
    const r = await query(
      `UPDATE wms.wb_seller_warehouses w SET is_enabled_for_picking=$1, updated_at=NOW()
       FROM wms.mp_accounts ma
       WHERE w.mp_account_id = ma.id AND w.id=$2 AND w.mp_account_id=$3 AND ma.tenant_id=$4
       RETURNING w.id, w.is_enabled_for_picking`,
      [!!is_enabled_for_picking, whId, accountId, req.user.tenantId]
    );
    if (r.rowCount === 0) throw new NotFoundError('Warehouse', whId);
    res.json({ ok: true, warehouse: r.rows[0] });
  } catch(e){ next(e); }
});

// ─────────────── Импорт карточек WB ───────────────

router.post('/import-items', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const accountId = Number(req.body.account_id);
    const acc = await getMpAccount(req.user.tenantId, accountId);
    const cards = await wbClient.fetchItems(acc.api_token, { limit: 100, maxPages: 50 });

    let savedItems = 0; let savedBarcodes = 0; let filledVolume = 0;
    await transaction(async (client) => {
      for (const card of cards) {
        const previewUrl = card.mediaFiles?.[0] || card.photos?.[0]?.big || null;

        // Габариты и объём приходят из карточки WB (это те же данные, по которым
        // сам ВБ считает платное хранение) — берём length/width/height (см) и
        // weightBrutto (кг), считаем литраж как Д×Ш×В/1000. Заполняются одним
        // блоком на всю карточку (у ВБ это габариты упаковки товара, они общие
        // для всех размеров карточки), поэтому распространяются на каждый barcode
        // этой карточки ниже.
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
          [req.user.tenantId, accountId, card.nmID, card.imtID||null,
           card.vendorCode||null, card.brand||null, card.title||null, previewUrl]
        );
        savedItems++;

        const barcodes = wbClient.extractCardBarcodes(card);
        for (const b of barcodes) {
          await client.query(
            `INSERT INTO wms.wb_item_barcodes(tenant_id,mp_account_id,nm_id,chrt_id,barcode)
             VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [req.user.tenantId, accountId, b.nm_id, b.chrt_id, b.barcode]
          );
          savedBarcodes++;

          // Синхронизируем в masterdata.items
          const item = await client.query(
            `SELECT id, volume_liters, size FROM wms.items WHERE tenant_id=$1 AND client_id=$2 AND barcode=$3 LIMIT 1`,
            [req.user.tenantId, acc.client_id, b.barcode]
          );
          if (item.rowCount === 0 && card.title) {
            await client.query(
              `INSERT INTO wms.items(tenant_id,client_id,barcode,item_name,vendor_code,brand,unit,source,wb_nm_id,preview_url,
                                      length_cm,width_cm,height_cm,volume_liters,weight_grams,size)
               VALUES($1,$2,$3,$4,$5,$6,'шт','wb',$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`,
              [req.user.tenantId, acc.client_id, b.barcode,
               card.title, card.vendorCode||null, card.brand||null, card.nmID, previewUrl,
               lengthCm, widthCm, heightCm, volumeLiters, weightGrams, b.tech_size||null]
            );
            if (volumeLiters) filledVolume++;
          } else if (item.rowCount > 0 && ((item.rows[0].volume_liters == null && volumeLiters) || (item.rows[0].size == null && b.tech_size))) {
            // Товар уже был в справочнике, но объём/размер никто не заполнил (ни
            // вручную, ни при более раннем импорте) — подтягиваем из ВБ. Если
            // поле УЖЕ стоит (в т.ч. вписанное вручную клиентом/складом) — не
            // трогаем его, чтобы не затереть уточнённое значение данными из
            // карточки ВБ (COALESCE в обе стороны).
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

    res.json({ ok: true, fetched_cards: cards.length, saved_items: savedItems, saved_barcodes: savedBarcodes, filled_volume: filledVolume });
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
    const result = await wbService.syncOrdersForAccount({ tenantId: req.user.tenantId, accountId, apiToken: acc.api_token });
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
    await wbService.syncOrdersForAccount({ tenantId: req.user.tenantId, accountId, apiToken: acc.api_token });

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

    // Группируем по складу WB
    const groups = new Map();
    for (const row of ordersRes.rows) {
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
      // забрать заказ вручную в ЛК WB). Если WB отклонит пачку целиком — не
      // теряем всю группу: перепроверяем актуальный список "новых" заказов и
      // повторяем без тех, что уже отвалились, помечая их как 'external'.
      let finalOrderIds = orderIds;
      let droppedOrderIds = [];
      try {
        await wbClient.addOrdersToSupply(acc.api_token, rawSupplyId, orderIds);
      } catch (e) {
        logger.warn({ err: e, accountId, rawSupplyId, orderIds }, 'WB addOrdersToSupply failed, re-checking against fresh WB state');
        const freshOrders = await wbClient.fetchNewOrders(acc.api_token).catch(()=>null);
        if (!freshOrders) throw e; // не смогли даже перепроверить — пробрасываем исходную ошибку
        const freshIdSet = new Set(freshOrders.map(o => Number(o.id||o.odid||o.orderId)).filter(Boolean));
        finalOrderIds = orderIds.filter(id => freshIdSet.has(id));
        droppedOrderIds = orderIds.filter(id => !freshIdSet.has(id));
        if (!finalOrderIds.length) throw e; // ни один заказ группы не актуален — исходная ошибка честнее
        await wbClient.addOrdersToSupply(acc.api_token, rawSupplyId, finalOrderIds);
        await query(
          `UPDATE wms.wb_orders SET status='external', fetched_at=NOW()
           WHERE tenant_id=$1 AND mp_account_id=$2 AND wb_order_id=ANY($3::bigint[])`,
          [req.user.tenantId, accountId, droppedOrderIds]
        );
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
    res.json({ ok:true, created_supplies:suppliesResult.length, supplies:suppliesResult, dropped_total:totalDropped });
  } catch(e){ next(e); }
});

// ─────────────── Просмотр данных ───────────────

router.get('/orders', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const { account_id, status, date_from, date_to, limit=200 } = req.query;
    const params=[req.user.tenantId]; const conds=['o.tenant_id=$1']; let idx=2;
    if (account_id) { conds.push(`o.mp_account_id=$${idx++}`); params.push(Number(account_id)); }
    if (status)     { conds.push(`o.status=$${idx++}`); params.push(status); }
    if (date_from)  { conds.push(`o.created_at>=$${idx++}::date`); params.push(date_from); }
    if (date_to)    { conds.push(`o.created_at<($${idx++}::date+INTERVAL '1 day')`); params.push(date_to); }
    params.push(Math.min(Number(limit),1000));
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
       WHERE ${conds.join(' AND ')} ORDER BY o.created_at DESC NULLS LAST LIMIT $${idx}`,
      params
    );
    res.json({ ok:true, orders:r.rows, count:r.rowCount });
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
