'use strict';
const express = require('express');
const router = express.Router();
const svc = require('./returns.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware, resolveClientScope, requireModule } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { requireCheckedIn } = require('../../middleware/requireCheckedIn');
const { getDefaultWarehouse } = require('../warehouses/warehouses.service');

router.use(authRequired, tenantMiddleware, requireModule('returns'), requireCheckedIn);

/** POST /returns/register — зарегистрировать возврат (один шаг) */
router.post('/register', requireRole('tenant_admin', 'supervisor', 'receiver'), async (req, res, next) => {
  try {
    const { barcode, qty, disposition, marketplace_order_no, location_code, comment, client_id, warehouse_id } = req.body;
    const clientId = resolveClientScope(req, client_id);
    const wh = warehouse_id
      ? { id: Number(warehouse_id) }
      : await getDefaultWarehouse(req.user.tenantId);
    const result = await svc.registerReturn({
      tenantId: req.user.tenantId, warehouseId: wh.id, clientId,
      barcode, qty: Number(qty), disposition,
      marketplaceOrderNo: marketplace_order_no || null,
      locationCode: location_code || null,
      comment: comment || null,
      userId: req.user.id,
    });
    res.status(201).json({ ok: true, return: result });
  } catch (e) { next(e); }
});

/** GET /returns/history */
router.get('/history', requireRole('tenant_admin', 'supervisor', 'receiver'), async (req, res, next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const result = await svc.listReturns({
      tenantId: req.user.tenantId, clientId,
      disposition: req.query.disposition || null,
      dateFrom: req.query.date_from || null,
      dateTo:   req.query.date_to   || null,
      limit:    Number(req.query.limit)  || 200,
      offset:   Number(req.query.offset) || 0,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

/** GET /returns/summary */
router.get('/summary', requireRole('tenant_admin', 'supervisor', 'receiver'), async (req, res, next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const summary = await svc.getReturnsSummary({
      tenantId: req.user.tenantId, clientId,
      dateFrom: req.query.date_from || null,
      dateTo:   req.query.date_to   || null,
    });
    res.json({ ok: true, summary });
  } catch (e) { next(e); }
});

/** GET /returns/by-client */
router.get('/by-client', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const rows = await svc.getReturnsByClient({
      tenantId: req.user.tenantId,
      dateFrom: req.query.date_from || null,
      dateTo:   req.query.date_to   || null,
    });
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

module.exports = router;
