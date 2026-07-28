'use strict';
const express = require('express');
const router = express.Router();
const svc = require('./receiving.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware, resolveClientScope } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { requireCheckedIn } = require('../../middleware/requireCheckedIn');
const { getDefaultWarehouse } = require('../warehouses/warehouses.service');

router.use(authRequired, tenantMiddleware, requireCheckedIn);

/** POST /receiving/accept — свободная приёмка */
router.post('/accept', requireRole('tenant_admin','supervisor','receiver'), async (req,res,next) => {
  try {
    const { barcode, location_code, qty, unit_cost, comment, client_id, warehouse_id } = req.body;
    const clientId = resolveClientScope(req, client_id);
    const wh = warehouse_id
      ? { id: Number(warehouse_id) }
      : await getDefaultWarehouse(req.user.tenantId);
    const result = await svc.acceptFree({
      tenantId: req.user.tenantId, warehouseId: wh.id, clientId,
      barcode, locationCode: location_code,
      qty: Number(qty), unitCost: unit_cost ? Number(unit_cost) : null,
      userId: req.user.id, comment,
    });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

/** POST /receiving/accept-by-inbound — приёмка по заявке */
router.post('/accept-by-inbound', requireRole('tenant_admin','supervisor','receiver'), async (req,res,next) => {
  try {
    const { inbound_order_barcode, barcode, location_code, qty, client_id, warehouse_id } = req.body;
    const clientId = resolveClientScope(req, client_id);
    const wh = warehouse_id
      ? { id: Number(warehouse_id) }
      : await getDefaultWarehouse(req.user.tenantId);
    const result = await svc.acceptByInbound({
      tenantId: req.user.tenantId, warehouseId: wh.id, clientId,
      inboundOrderBarcode: inbound_order_barcode,
      scannedBarcode: barcode,
      locationCode: location_code,
      qty: Number(qty),
      userId: req.user.id,
    });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

/** GET /receiving/history */
router.get('/history', requireRole('tenant_admin','supervisor','receiver'), async (req,res,next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const rows = await svc.listReceivingHistory({
      tenantId: req.user.tenantId, clientId,
      dateFrom: req.query.date_from || null,
      dateTo:   req.query.date_to   || null,
      limit:    Number(req.query.limit)  || 200,
      offset:   Number(req.query.offset) || 0,
    });
    res.json({ ok: true, rows });
  } catch(e){ next(e); }
});

module.exports = router;
