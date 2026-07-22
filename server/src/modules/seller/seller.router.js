'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../../config/database');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware, resolveClientScope } = require('../../middleware/tenant');
const { requireSellerRole, requireRole } = require('../../middleware/requireRole');
const { requireModule } = require('../../middleware/tenant');
const { ValidationError } = require('../../utils/errors');
const inboundSvc = require('../inbound/inbound.service');
const stockSvc = require('../stock/stock.service');
const { getDefaultWarehouse } = require('../warehouses/warehouses.service');

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
    const params = [req.user.tenantId, clientId]; const conds=['o.tenant_id=$1']; let idx=3;
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
         i.brand, i.unit, i.volume_liters, i.is_active, i.preview_url,
         COALESCE(SUM(sb.qty_on_hand),0)::int AS total_on_hand,
         COALESCE(SUM(sb.qty_available),0)::int AS total_available
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
