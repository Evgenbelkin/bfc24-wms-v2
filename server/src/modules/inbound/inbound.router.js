'use strict';
const express = require('express');
const router = express.Router();
const svc = require('./inbound.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware, resolveClientScope } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { validatePositiveInt } = require('../../utils/validators');
const { getDefaultWarehouse } = require('../warehouses/warehouses.service');

router.use(authRequired, tenantMiddleware);

router.get('/', async (req,res,next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const result = await svc.listInboundOrders({
      tenantId:    req.user.tenantId,
      clientId,
      status:      req.query.status || null,
      warehouseId: req.query.warehouse_id ? Number(req.query.warehouse_id) : null,
      limit:       Number(req.query.limit)||100,
      offset:      Number(req.query.offset)||0,
    });
    res.json({ ok:true, ...result });
  } catch(e){ next(e); }
});

router.get('/by-barcode', async (req,res,next) => {
  try {
    const order = await svc.getInboundOrderByBarcode({ tenantId: req.user.tenantId, barcode: req.query.barcode });
    const lines = await svc.getInboundOrderLines({ orderId: order.id });
    res.json({ ok:true, order, lines });
  } catch(e){ next(e); }
});

router.get('/:id', async (req,res,next) => {
  try {
    const id = validatePositiveInt(req.params.id,'id');
    const order = await svc.getInboundOrderById({ tenantId: req.user.tenantId, orderId: id });
    const lines = await svc.getInboundOrderLines({ orderId: id });
    res.json({ ok:true, order, lines });
  } catch(e){ next(e); }
});

router.post('/', async (req,res,next) => {
  try {
    const clientId = resolveClientScope(req, req.body.client_id);
    const wh = req.body.warehouse_id
      ? { id: Number(req.body.warehouse_id) }
      : await getDefaultWarehouse(req.user.tenantId);
    const order = await svc.createInboundOrder({
      tenantId: req.user.tenantId, clientId, warehouseId: wh.id,
      createdByUserId: req.user.id, data: req.body,
    });
    res.status(201).json({ ok:true, order });
  } catch(e){ next(e); }
});

router.post('/:id/confirm', requireRole('tenant_admin','supervisor','receiver'), async (req,res,next) => {
  try {
    const order = await svc.confirmInboundOrder({ tenantId: req.user.tenantId, orderId: validatePositiveInt(req.params.id,'id'), userId: req.user.id });
    res.json({ ok:true, order });
  } catch(e){ next(e); }
});

router.post('/:id/cancel', requireRole('tenant_admin','supervisor'), async (req,res,next) => {
  try {
    const order = await svc.cancelInboundOrder({ tenantId: req.user.tenantId, orderId: validatePositiveInt(req.params.id,'id'), userId: req.user.id });
    res.json({ ok:true, order });
  } catch(e){ next(e); }
});

module.exports = router;
