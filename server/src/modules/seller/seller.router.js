'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../../config/database');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware, resolveClientScope } = require('../../middleware/tenant');
const { requireSellerRole, requireRole } = require('../../middleware/requireRole');
const { requireModule } = require('../../middleware/tenant');
const { ValidationError, ForbiddenError } = require('../../utils/errors');
const inboundSvc = require('../inbound/inbound.service');
const stockSvc = require('../stock/stock.service');
const receivingSvc = require('../receiving/receiving.service');
const actsSvc = require('../acts/acts.service');
const tenantSvc = require('../tenant/tenant.service');
const { validatePositiveInt } = require('../../utils/validators');
const { getDefaultWarehouse } = require('../warehouses/warehouses.service');
const billingSvc = require('../billing/billing.service');
const markingSvc = require('../marking/marking.service');
const returnsSvc = require('../returns/returns.service');

// =============================================================================
// Seller Cabinet Router
// Всё что видит селлер — только СВОИ данные (clientId из JWT)
// =============================================================================

router.use(authRequired, tenantMiddleware, requireModule('seller_cabinet'));

// ─────────────── Inbound Orders ───────────────

/** GET /seller/inbound — список заявок на поставку */
router.get('/inbound', async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const result = await inboundSvc.listInboundOrders({
      tenantId: req.user.tenantId,
      clientId,
      status:   req.query.status || null,
      limit:    Number(req.query.limit) || 50,
      offset:   Number(req.query.offset) || 0,
    });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

/** POST /seller/inbound — создать заявку */
router.post('/inbound', async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const wh = await getDefaultWarehouse(req.user.tenantId);
    const order = await inboundSvc.createInboundOrder({
      tenantId: req.user.tenantId,
      clientId,
      warehouseId:     wh.id,
      createdByUserId: req.user.id,
      data: req.body,
    });
    res.status(201).json({ ok: true, order });
  } catch(e){ next(e); }
});

/** GET /seller/inbound/:id */
router.get('/inbound/:id', async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const order = await inboundSvc.getInboundOrderById({ tenantId: req.user.tenantId, orderId: Number(req.params.id) });
    if (order.client_id !== clientId) return res.status(403).json({ ok:false, error:{code:'FORBIDDEN',message:'Access denied'} });
    const lines = await inboundSvc.getInboundOrderLines({ orderId: order.id });
    res.json({ ok: true, order, lines });
  } catch(e){ next(e); }
});

/** POST /seller/inbound/:id/confirm */
router.post('/inbound/:id/confirm', async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const order = await inboundSvc.getInboundOrderById({ tenantId: req.user.tenantId, orderId: Number(req.params.id) });
    if (order.client_id !== clientId) return res.status(403).json({ ok:false, error:{code:'FORBIDDEN',message:'Access denied'} });
    const updated = await inboundSvc.confirmInboundOrder({ tenantId: req.user.tenantId, orderId: order.id, userId: req.user.id });
    res.json({ ok: true, order: updated });
  } catch(e){ next(e); }
});

// ─────────────── Stock ───────────────

/** GET /seller/stock — остатки клиента */
router.get('/stock', async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const rows = await stockSvc.getClientStockSummary({ tenantId: req.user.tenantId, clientId });
    res.json({ ok: true, stock: rows });
  } catch(e){ next(e); }
});

/** GET /seller/stock/by-barcode */
router.get('/stock/by-barcode', async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const rows = await stockSvc.getStockByBarcode({
      tenantId: req.user.tenantId, clientId,
      barcode: req.query.barcode,
    });
    res.json({ ok: true, locations: rows });
  } catch(e){ next(e); }
});

// ─────────────── Orders (WB) ───────────────

/** GET /seller/orders — заказы клиента */
router.get('/orders', requireModule('wb_integration'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const params = [req.user.tenantId]; const conds=['o.tenant_id=$1']; let idx=2;
    // Ищем account_id через client
    const accRes = await query(`SELECT id FROM wms.mp_accounts WHERE tenant_id=$1 AND client_id=$2 AND is_active=TRUE`, [req.user.tenantId, clientId]);
    if (accRes.rowCount === 0) return res.json({ ok:true, orders:[], count:0 });
    const accIds = accRes.rows.map(r=>r.id);
    conds.push(`o.mp_account_id=ANY($${idx++}::int[])`); params.push(accIds);
    if (req.query.status) { conds.push(`o.status=$${idx++}`); params.push(req.query.status); }
    if (req.query.date_from) { conds.push(`o.created_at>=$${idx++}::date`); params.push(req.query.date_from); }
    if (req.query.date_to)   { conds.push(`o.created_at<($${idx++}::date+INTERVAL '1 day')`); params.push(req.query.date_to); }
    params.push(Math.min(Number(req.query.limit)||200, 1000));
    const r = await query(
      `SELECT o.wb_order_id, o.barcode, o.article, o.status, o.wb_supply_id,
         o.price, o.warehouse_name, o.created_at, o.fetched_at
       FROM wms.wb_orders o WHERE ${conds.join(' AND ')} ORDER BY o.created_at DESC LIMIT $${idx}`,
      params
    );
    res.json({ ok:true, orders:r.rows, count:r.rowCount });
  } catch(e){ next(e); }
});

// ─────────────── Shipments ───────────────

/** GET /seller/shipments — отгрузки клиента */
router.get('/shipments', async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const r = await query(
      `SELECT s.id, s.external_id, s.marketplace, s.status,
         s.total_planned_qty, s.total_packed_qty, s.total_shipped_qty,
         s.created_at, s.shipped_at
       FROM wms.shipments s
       WHERE s.tenant_id=$1 AND s.client_id=$2
       ORDER BY s.created_at DESC LIMIT $3`,
      [req.user.tenantId, clientId, Math.min(Number(req.query.limit)||100, 500)]
    );
    res.json({ ok:true, shipments:r.rows });
  } catch(e){ next(e); }
});

// ─────────────── Items (справочник) ───────────────

/** GET /seller/items */
router.get('/items', async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const r = await query(
      `SELECT i.id, i.barcode, i.item_name, i.vendor_code, i.wb_vendor_code,
         i.brand, i.unit, i.volume_liters, i.is_active, i.preview_url, i.cost_price,
         i.requires_marking, i.marking_trigger, i.marking_mode,
         COALESCE(SUM(sb.qty_on_hand),0)::int AS total_on_hand,
         COALESCE(SUM(sb.qty_available),0)::int AS total_available,
         (COALESCE(SUM(sb.qty_on_hand),0) * COALESCE(i.cost_price,0))::numeric AS total_cost_value
       FROM wms.items i
       LEFT JOIN wms.stock_balances sb ON sb.item_id=i.id AND sb.tenant_id=i.tenant_id
       WHERE i.tenant_id=$1 AND i.client_id=$2 AND i.is_active=TRUE
       GROUP BY i.id ORDER BY i.item_name
       LIMIT $3 OFFSET $4`,
      [req.user.tenantId, clientId, Math.min(Number(req.query.limit)||200, 500), Number(req.query.offset)||0]
    );
    res.json({ ok:true, items:r.rows });
  } catch(e){ next(e); }
});

/** PATCH /seller/items/:id/cost-price — клиент указывает себестоимость СВОЕГО
 *  товара (нужна складу для понимания материальной ответственности при утере).
 *  Намеренно узкий эндпоинт — правит только cost_price, не даёт клиенту менять
 *  штрихкод/название и прочие поля, которыми управляет склад. */
router.patch('/items/:id/cost-price', async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const itemId = Number(req.params.id);
    const costPrice = req.body.cost_price;
    if (costPrice === undefined || costPrice === null || isNaN(Number(costPrice)) || Number(costPrice) < 0) {
      throw new ValidationError('cost_price must be a non-negative number');
    }
    const r = await query(
      `UPDATE wms.items SET cost_price=$1, updated_at=NOW()
       WHERE id=$2 AND tenant_id=$3 AND client_id=$4
       RETURNING id, cost_price`,
      [Number(costPrice), itemId, req.user.tenantId, clientId]
    );
    if (r.rowCount === 0) return res.status(404).json({ ok:false, error:{code:'NOT_FOUND', message:'Item not found'} });
    res.json({ ok:true, item:r.rows[0] });
  } catch(e){ next(e); }
});

/** PATCH /seller/items/:id/reorder-threshold — порог подсорта для товара:
 *  мин. остаток (шт) и/или мин. запас (дней при текущей скорости продаж).
 *  Единый порог на товар — применяется одинаково на каждом его складе FBS
 *  (см. GET /seller/stock-by-warehouse). Оба поля опциональны, null снимает
 *  порог. */
router.patch('/items/:id/reorder-threshold', requireModule('wb_integration'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const itemId = Number(req.params.id);
    const { reorder_min_qty, reorder_min_days } = req.body;
    const fields = []; const params = []; let idx = 1;
    if (reorder_min_qty !== undefined) {
      if (reorder_min_qty === null || reorder_min_qty === '') { fields.push(`reorder_min_qty=$${idx++}`); params.push(null); }
      else {
        const q = Number(reorder_min_qty);
        if (!Number.isFinite(q) || q < 0) throw new ValidationError('reorder_min_qty must be a non-negative number');
        fields.push(`reorder_min_qty=$${idx++}`); params.push(Math.round(q));
      }
    }
    if (reorder_min_days !== undefined) {
      if (reorder_min_days === null || reorder_min_days === '') { fields.push(`reorder_min_days=$${idx++}`); params.push(null); }
      else {
        const d = Number(reorder_min_days);
        if (!Number.isFinite(d) || d < 0) throw new ValidationError('reorder_min_days must be a non-negative number');
        fields.push(`reorder_min_days=$${idx++}`); params.push(d);
      }
    }
    if (!fields.length) throw new ValidationError('Nothing to update');
    fields.push(`updated_at=NOW()`);
    params.push(itemId, req.user.tenantId, clientId);
    const r = await query(
      `UPDATE wms.items SET ${fields.join(', ')}
       WHERE id=$${idx++} AND tenant_id=$${idx++} AND client_id=$${idx++}
       RETURNING id, reorder_min_qty, reorder_min_days`,
      params
    );
    if (r.rowCount === 0) return res.status(404).json({ ok:false, error:{code:'NOT_FOUND', message:'Item not found'} });
    res.json({ ok:true, item:r.rows[0] });
  } catch(e){ next(e); }
});

/** Проверить, что item принадлежит текущему клиенту — общий guard для двух
 *  эндпоинтов ниже, чтобы клиент не мог загрузить/посмотреть коды чужого товара. */
async function assertOwnItem({ tenantId, clientId, itemId }) {
  const r = await query(`SELECT id FROM wms.items WHERE id=$1 AND tenant_id=$2 AND client_id=$3`, [itemId, tenantId, clientId]);
  if (r.rowCount === 0) throw new ForbiddenError('Item not found or belongs to a different client');
}

/** GET /seller/items/:id/marking/summary — клиент сам заказывает коды в ЦРПТ и
 *  знает, сколько уже загрузил / израсходовал склад. */
router.get('/items/:id/marking/summary', requireModule('marking'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const itemId = Number(req.params.id);
    await assertOwnItem({ tenantId: req.user.tenantId, clientId, itemId });
    const summary = await markingSvc.getCodesSummary({ tenantId: req.user.tenantId, itemId });
    res.json({ ok:true, summary });
  } catch(e){ next(e); }
});

/** GET /seller/items/:id/marking/codes — список кодов пула (какие ещё свободны,
 *  какие уже использованы/отправлены в WB) — чтобы клиент мог сам проверить остаток. */
router.get('/items/:id/marking/codes', requireModule('marking'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const itemId = Number(req.params.id);
    await assertOwnItem({ tenantId: req.user.tenantId, clientId, itemId });
    const codes = await markingSvc.listCodes({
      tenantId: req.user.tenantId, itemId,
      status: req.query.status || null,
      limit: Number(req.query.limit) || 500,
      offset: Number(req.query.offset) || 0,
    });
    res.json({ ok:true, codes });
  } catch(e){ next(e); }
});

/** POST /seller/items/:id/marking/codes/import { codes_text } — клиент сам
 *  запрашивает коды "Честный знак" на свой товар в ЦРПТ и подгружает их сюда
 *  (по одному на строку) — склад дальше просто печатает их по одному при
 *  приёмке/упаковке, не разбираясь, откуда какой код взялся. */
router.post('/items/:id/marking/codes/import', requireModule('marking'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const itemId = Number(req.params.id);
    await assertOwnItem({ tenantId: req.user.tenantId, clientId, itemId });
    if (!req.body.codes_text) throw new ValidationError('codes_text required');
    const result = await markingSvc.importCodes({
      tenantId: req.user.tenantId, itemId, createdBy: req.user.id,
      codesText: req.body.codes_text,
    });
    res.json({ ok:true, ...result });
  } catch(e){ next(e); }
});

/** PATCH /seller/items/:id/marking/settings { requires_marking, marking_trigger, marking_mode } —
 *  клиент сам решает, какие его товары требуют маркировки "Честный знак" и на
 *  каком этапе печатать код (приёмка/упаковка) — складу не нужно об этом
 *  думать за клиента. Ранее это мог настраивать только склад в своей админке
 *  (public/app/items.html) — та возможность осталась как запасной вариант.
 *  marking_mode: 'print' — ФФ печатает код из своего пула (как раньше);
 *  'scan' — клиент клеит DataMatrix сам на производстве, ФФ только сканирует
 *  и отправляет в WB на сборке FBS-заказа (для клиентов, перешедших на FBS). */
router.patch('/items/:id/marking/settings', requireModule('marking'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const itemId = Number(req.params.id);
    await assertOwnItem({ tenantId: req.user.tenantId, clientId, itemId });

    const fields = []; const params = []; let idx = 1;
    if (req.body.requires_marking !== undefined) {
      fields.push(`requires_marking=$${idx++}`); params.push(!!req.body.requires_marking);
    }
    if (req.body.marking_trigger !== undefined) {
      if (!['receiving','packing'].includes(req.body.marking_trigger)) {
        throw new ValidationError(`marking_trigger must be 'receiving' or 'packing'`);
      }
      fields.push(`marking_trigger=$${idx++}`); params.push(req.body.marking_trigger);
    }
    if (req.body.marking_mode !== undefined) {
      if (!['print','scan'].includes(req.body.marking_mode)) {
        throw new ValidationError(`marking_mode must be 'print' or 'scan'`);
      }
      fields.push(`marking_mode=$${idx++}`); params.push(req.body.marking_mode);
    }
    if (fields.length === 0) throw new ValidationError('No fields to update');
    fields.push('updated_at=NOW()');
    params.push(itemId, req.user.tenantId, clientId);
    const r = await query(
      `UPDATE wms.items SET ${fields.join(', ')} WHERE id=$${idx++} AND tenant_id=$${idx++} AND client_id=$${idx}
       RETURNING id, requires_marking, marking_trigger, marking_mode`,
      params
    );
    if (r.rowCount === 0) throw new ValidationError('Item not found');
    res.json({ ok:true, item:r.rows[0] });
  } catch(e){ next(e); }
});

/** PATCH /seller/items/marking/bulk-settings { item_ids, requires_marking, marking_trigger, marking_mode } —
 *  та же настройка, что и одиночный PATCH выше, но сразу на пачку своих
 *  товаров — при подключении к маркировке клиент обычно решает не по одному
 *  SKU, а сразу "вот эти 200 товаров с ЧЗ, эти - без". Склад потом видит и
 *  при необходимости поправит в своей админке (см. public/app/items.html). */
router.patch('/items/marking/bulk-settings', requireModule('marking'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const itemIds = Array.isArray(req.body.item_ids)
      ? req.body.item_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : [];
    if (!itemIds.length) throw new ValidationError('item_ids is required');
    if (itemIds.length > 1000) throw new ValidationError('Слишком много товаров за один раз (максимум 1000)');

    const fields = []; const params = []; let idx = 1;
    if (req.body.requires_marking !== undefined) {
      fields.push(`requires_marking=$${idx++}`); params.push(!!req.body.requires_marking);
    }
    if (req.body.marking_trigger !== undefined) {
      if (!['receiving','packing'].includes(req.body.marking_trigger)) {
        throw new ValidationError(`marking_trigger must be 'receiving' or 'packing'`);
      }
      fields.push(`marking_trigger=$${idx++}`); params.push(req.body.marking_trigger);
    }
    if (req.body.marking_mode !== undefined) {
      if (!['print','scan'].includes(req.body.marking_mode)) {
        throw new ValidationError(`marking_mode must be 'print' or 'scan'`);
      }
      fields.push(`marking_mode=$${idx++}`); params.push(req.body.marking_mode);
    }
    if (fields.length === 0) throw new ValidationError('No fields to update');
    fields.push('updated_at=NOW()');
    params.push(itemIds, req.user.tenantId, clientId);
    // client_id=$ в условии — гарантия, что клиент правит ТОЛЬКО свои товары,
    // даже если в item_ids случайно/специально подсунут чужой id.
    const r = await query(
      `UPDATE wms.items SET ${fields.join(', ')} WHERE id = ANY($${idx++}::int[]) AND tenant_id=$${idx++} AND client_id=$${idx}
       RETURNING id`,
      params
    );
    res.json({ ok:true, updated: r.rowCount });
  } catch(e){ next(e); }
});

// ─────────────── Returns (возвраты) ───────────────

/** GET /seller/returns — история возвратов клиента */
router.get('/returns', requireModule('returns'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const result = await returnsSvc.listReturns({
      tenantId: req.user.tenantId, clientId,
      disposition: req.query.disposition || null,
      dateFrom: req.query.date_from || null,
      dateTo:   req.query.date_to   || null,
      limit:    Number(req.query.limit)  || 200,
      offset:   Number(req.query.offset) || 0,
    });
    res.json({ ok:true, ...result });
  } catch(e){ next(e); }
});

/** GET /seller/returns/summary — счётчики (всего/в продажу/в утиль) для клиента */
router.get('/returns/summary', requireModule('returns'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const summary = await returnsSvc.getReturnsSummary({
      tenantId: req.user.tenantId, clientId,
      dateFrom: req.query.date_from || null,
      dateTo:   req.query.date_to   || null,
    });
    res.json({ ok:true, summary });
  } catch(e){ next(e); }
});

/** GET /seller/wb-return-claims — заявки на возврат из WB Returns API (видимость,
 *  ещё не пришли физически на склад) */
router.get('/wb-return-claims', requireModule('wb_integration'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const isArchive = req.query.is_archive === 'true';
    const claims = await wbSvc.listReturnClaimsForClient({ tenantId: req.user.tenantId, clientId, isArchive });
    res.json({ ok:true, claims });
  } catch(e){ next(e); }
});

// ─────────────── Analytics ───────────────

/** GET /seller/analytics/sales */
router.get('/analytics/sales', requireModule('analytics'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const accRes = await query(`SELECT id FROM wms.mp_accounts WHERE tenant_id=$1 AND client_id=$2`, [req.user.tenantId, clientId]);
    if (accRes.rowCount===0) return res.json({ ok:true, rows:[] });
    const accIds = accRes.rows.map(r=>r.id);
    const { date_from, date_to } = req.query;
    const params=[accIds]; const conds=['s.mp_account_id=ANY($1::int[])']; let idx=2;
    if (date_from) { conds.push(`s.sale_datetime>=$${idx++}::date`); params.push(date_from); }
    if (date_to)   { conds.push(`s.sale_datetime<($${idx++}::date+INTERVAL '1 day')`); params.push(date_to); }
    const r = await query(
      `SELECT DATE(s.sale_datetime)::text AS sale_date,
         s.barcode, s.subject, s.brand,
         COUNT(*)::int AS qty_sold,
         SUM(s.for_pay_raw)::numeric AS revenue
       FROM analytics.wb_sales_raw s
       WHERE ${conds.join(' AND ')}
       GROUP BY DATE(s.sale_datetime), s.barcode, s.subject, s.brand
       ORDER BY sale_date DESC, qty_sold DESC LIMIT 500`,
      params
    );
    res.json({ ok:true, rows:r.rows });
  } catch(e){ next(e); }
});

// ─────────────── История операций ───────────────

/** GET /seller/history */
router.get('/history', async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const { date_from, date_to, movement_type } = req.query;
    const rows = await stockSvc.listMovements({
      tenantId: req.user.tenantId, clientId,
      movementType: movement_type || null,
      dateFrom: date_from || null,
      dateTo:   date_to   || null,
      limit:    Number(req.query.limit) || 200,
    });
    res.json({ ok:true, movements:rows });
  } catch(e){ next(e); }
});

/** GET /seller/receiving-history — что и сколько реально приехало и было принято
 *  на складе, для витрины "мы приняли ваш товар в таком-то количестве".
 *  Переиспользует тот же сервис, что и внутренний экран приёмки
 *  (receiving.service.js:listReceivingHistory) - там уже есть client_id,
 *  qty_received/qty_expected/qty_damaged, товар и дата, ничего добавлять не
 *  пришлось. clientId скоупится через resolveClientScope как везде в этом
 *  роутере - продавец не может подсмотреть чужую приёмку. */
router.get('/receiving-history', async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const rows = await receivingSvc.listReceivingHistory({
      tenantId: req.user.tenantId, clientId,
      dateFrom: req.query.date_from || null,
      dateTo:   req.query.date_to   || null,
      limit:    Number(req.query.limit)  || 200,
      offset:   Number(req.query.offset) || 0,
    });
    res.json({ ok:true, rows });
  } catch(e){ next(e); }
});

/** GET /seller/acts — список актов приёмки клиента (read-only витрина того же
 *  wms.acceptance_acts, что формирует склад). */
router.get('/acts', async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const acts = await actsSvc.listActs({
      tenantId: req.user.tenantId, clientId,
      dateFrom: req.query.date_from || null,
      dateTo:   req.query.date_to   || null,
      limit:    Number(req.query.limit)  || 100,
      offset:   Number(req.query.offset) || 0,
    });
    res.json({ ok:true, acts });
  } catch(e){ next(e); }
});

/** GET /seller/acts/:id — сам акт + строки, для печати в браузере (тот же
 *  ActPrint, что и на складе). acts.service.getAct не фильтрует по клиенту
 *  сама (staff-роут доверяет tenant-скоупу) - здесь ПРОВЕРЯЕМ владельца явно,
 *  иначе продавец по чужому id мог бы подсмотреть акт другого клиента.
 *  Реквизиты тенанта ("исполнитель" в акте) отдаём тут же одним ответом -
 *  GET /tenant/profile продавцу недоступен (там requireRole tenant_admin/
 *  supervisor), а дублировать отдельный публичный роут ради этого не нужно. */
router.get('/acts/:id', async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const actId = validatePositiveInt(req.params.id, 'id');
    const result = await actsSvc.getAct({ tenantId: req.user.tenantId, actId });
    if (result.act.client_id !== clientId) throw new ForbiddenError('Act belongs to a different client');
    const tenantProfile = await tenantSvc.getMyTenantProfile({ tenantId: req.user.tenantId });
    res.json({ ok:true, act: result.act, lines: result.lines, tenant: tenantProfile });
  } catch(e){ next(e); }
});

// ─────────────── Склады WB (автораспределение остатков) ───────────────
// Клиент сам решает, в какой пропорции раскидывать остаток по своим складам
// WB (FBS) - раньше делал это руками в личном кабинете WB, теперь программа
// делает это сама после приёмки/инвентаризации. См. wb.service.js -
// distributeStockForAccount()/triggerRedistributionForClient() - вся логика
// расчёта и отправки в WB там, здесь только CRUD настроек.

const wbSvc = require('../wb/wb.service');

/** GET /seller/wb-warehouses — список складов клиента у WB с текущими весами */
router.get('/wb-warehouses', requireModule('wb_integration'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const accRes = await query(
      `SELECT id, account_name, settings FROM wms.mp_accounts
       WHERE tenant_id=$1 AND client_id=$2 AND marketplace='wb' AND is_active=TRUE
       ORDER BY id LIMIT 1`,
      [req.user.tenantId, clientId]
    );
    if (accRes.rowCount === 0) return res.json({ ok:true, account:null, warehouses:[] });
    const account = accRes.rows[0];
    const whRes = await query(
      `SELECT id, wb_warehouse_id, warehouse_code, warehouse_name, is_active, is_enabled_for_dist, weight, last_synced_at
       FROM wms.wb_seller_warehouses
       WHERE mp_account_id=$1 AND is_active=TRUE
       ORDER BY warehouse_name`,
      [account.id]
    );
    res.json({
      ok: true,
      account: { id: account.id, name: account.account_name, reserve_pct: Number(account.settings?.stock_reserve_pct ?? 5) },
      warehouses: whRes.rows,
    });
  } catch(e){ next(e); }
});

/** POST /seller/wb-warehouses/sync — подтянуть актуальный список складов из WB */
router.post('/wb-warehouses/sync', requireModule('wb_integration'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const accRes = await query(
      `SELECT id FROM wms.mp_accounts WHERE tenant_id=$1 AND client_id=$2 AND marketplace='wb' AND is_active=TRUE LIMIT 1`,
      [req.user.tenantId, clientId]
    );
    if (accRes.rowCount === 0) throw new ValidationError('Нет подключённого аккаунта WB');
    const result = await wbSvc.syncSellerWarehouses({ tenantId: req.user.tenantId, mpAccountId: accRes.rows[0].id });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

/** PATCH /seller/wb-warehouses/:id — изменить долю склада / включить-выключить участие */
router.patch('/wb-warehouses/:id', requireModule('wb_integration'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const { weight, is_enabled_for_dist } = req.body;
    const fields = []; const params = []; let idx = 1;
    if (weight !== undefined) {
      const w = Number(weight);
      if (!Number.isFinite(w) || w < 0) throw new ValidationError('weight must be a non-negative number');
      fields.push(`weight=$${idx++}`); params.push(w);
    }
    if (is_enabled_for_dist !== undefined) { fields.push(`is_enabled_for_dist=$${idx++}`); params.push(!!is_enabled_for_dist); }
    if (!fields.length) throw new ValidationError('Nothing to update');
    fields.push(`updated_at=NOW()`);
    params.push(Number(req.params.id), req.user.tenantId, clientId);
    const r = await query(
      `UPDATE wms.wb_seller_warehouses w SET ${fields.join(', ')}
       FROM wms.mp_accounts ma
       WHERE w.mp_account_id = ma.id AND w.id=$${idx++} AND w.tenant_id=$${idx++} AND ma.client_id=$${idx++}
       RETURNING w.id, w.weight, w.is_enabled_for_dist`,
      params
    );
    if (r.rowCount === 0) return res.status(404).json({ ok:false, error:{code:'NOT_FOUND', message:'Warehouse not found'} });
    wbSvc.triggerRedistributionForClient({ tenantId: req.user.tenantId, clientId });
    res.json({ ok:true, warehouse: r.rows[0] });
  } catch(e){ next(e); }
});

/** PATCH /seller/wb-warehouses/reserve — изменить % резерва (не раздаётся по складам) */
router.patch('/wb-warehouses/settings/reserve', requireModule('wb_integration'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const pct = Number(req.body.reserve_pct);
    if (!Number.isFinite(pct) || pct < 0 || pct > 90) throw new ValidationError('reserve_pct must be between 0 and 90');
    const r = await query(
      `UPDATE wms.mp_accounts SET settings = settings || jsonb_build_object('stock_reserve_pct', $1::numeric), updated_at=NOW()
       WHERE tenant_id=$2 AND client_id=$3 AND marketplace='wb' AND is_active=TRUE
       RETURNING id`,
      [pct, req.user.tenantId, clientId]
    );
    if (r.rowCount === 0) throw new ValidationError('Нет подключённого аккаунта WB');
    wbSvc.triggerRedistributionForClient({ tenantId: req.user.tenantId, clientId });
    res.json({ ok:true, reserve_pct: pct });
  } catch(e){ next(e); }
});

/** GET /seller/stock-by-warehouse — остатки по всем складам FBS в одном окне
 *  (наш расчёт распределения, wms.wb_stock_distribution) + оценка "хватит на
 *  N дней" по скорости продаж и подсветка порога подсорта. */
router.get('/stock-by-warehouse', requireModule('wb_integration'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const result = await wbSvc.getStockDistributionReport({ tenantId: req.user.tenantId, clientId });
    res.json({ ok:true, ...result });
  } catch(e){ next(e); }
});

// ─────────────── Billing (просмотр) ───────────────

/** GET /seller/billing */
router.get('/billing', requireModule('billing'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const { period_from, period_to } = req.query;
    const params=[req.user.tenantId, clientId]; let idx=3;
    const conds=['sc.tenant_id=$1','sc.client_id=$2'];
    if (period_from) { conds.push(`sc.period_date>=$${idx++}::date`); params.push(period_from); }
    if (period_to)   { conds.push(`sc.period_date<=$${idx++}::date`); params.push(period_to); }
    const r = await query(
      `SELECT sc.service_type, sc.description, sc.quantity, sc.unit_price,
         sc.total_amount, sc.period_date, sc.is_invoiced
       FROM billing.service_charges sc
       WHERE ${conds.join(' AND ')} ORDER BY sc.period_date DESC, sc.id DESC LIMIT 500`,
      params
    );
    const total = r.rows.reduce((s,row)=>s+Number(row.total_amount||0), 0);
    res.json({ ok:true, charges:r.rows, total_amount:total });
  } catch(e){ next(e); }
});

/** GET /seller/billing/balance — сколько должен клиент (неоплаченное/выставленное/оплаченное) */
router.get('/billing/balance', requireModule('billing'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const balance = await billingSvc.getClientBalance({ tenantId: req.user.tenantId, clientId });
    res.json({ ok:true, balance });
  } catch(e){ next(e); }
});

/** GET /seller/billing/invoices — счета клиента (только просмотр — статус меняет только фулфилмент) */
router.get('/billing/invoices', requireModule('billing'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const result = await billingSvc.listInvoices({
      tenantId: req.user.tenantId, clientId,
      status: req.query.status || null,
      limit: Number(req.query.limit) || 100,
      offset: Number(req.query.offset) || 0,
    });
    res.json({ ok:true, ...result });
  } catch(e){ next(e); }
});

/** GET /seller/billing/invoices/:id — детали счёта (позиции начислений) */
router.get('/billing/invoices/:id', requireModule('billing'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const result = await billingSvc.getInvoice({ tenantId: req.user.tenantId, invoiceId: Number(req.params.id) });
    if (Number(result.invoice.client_id) !== Number(clientId)) throw new ForbiddenError('Invoice does not belong to this client');
    res.json({ ok:true, ...result });
  } catch(e){ next(e); }
});

// ─────────────── Профиль ───────────────

router.get('/profile', async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.user.clientId);
    const r = await query(
      `SELECT c.id, c.client_code, c.client_name, c.contact_name,
         c.contact_email, c.contact_phone, c.telegram_chat_id
       FROM wms.clients c WHERE c.id=$1 AND c.tenant_id=$2`,
      [clientId, req.user.tenantId]
    );
    res.json({ ok:true, client: r.rows[0]||null });
  } catch(e){ next(e); }
});

module.exports = router;
