'use strict';
const express = require('express');
const router = express.Router();
const svc = require('./acts.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware, resolveClientScope } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { validatePositiveInt } = require('../../utils/validators');
const { getDefaultWarehouse } = require('../warehouses/warehouses.service');
const { ValidationError } = require('../../utils/errors');

router.use(authRequired, tenantMiddleware);

// =============================================================================
// Acceptance Acts Router — Акт приёмки товара (по заявке или без неё)
// =============================================================================

/** GET /acts/free-lines — черновик строк для акта без заявки, собранный из
 *  того, что реально приняли свободной приёмкой за период (см.
 *  acts.service.js getFreeReceivingLinesForAct). */
router.get('/free-lines', requireRole('tenant_admin','supervisor','receiver'), async (req,res,next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    if (!clientId) throw new ValidationError('client_id is required');
    const lines = await svc.getFreeReceivingLinesForAct({
      tenantId: req.user.tenantId,
      clientId,
      warehouseId: req.query.warehouse_id ? Number(req.query.warehouse_id) : null,
      dateFrom: req.query.date_from,
      dateTo: req.query.date_to,
    });
    res.json({ ok:true, lines });
  } catch(e){ next(e); }
});

/** GET /acts/uncovered — есть ли по клиенту непокрытая актом приёмка (гейт
 *  "нельзя выйти из модуля/сменить клиента/закрыть заявку без акта", см.
 *  public/app/receiving.html и inbound-orders.html). */
router.get('/uncovered', requireRole('tenant_admin','supervisor','receiver'), async (req,res,next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    if (!clientId) throw new ValidationError('client_id is required');
    const uncovered = await svc.hasUncoveredReceiving({
      tenantId: req.user.tenantId,
      clientId,
      inboundOrderId: req.query.inbound_order_id ? Number(req.query.inbound_order_id) : null,
      anySource: req.query.any === '1',
    });
    res.json({ ok:true, uncovered });
  } catch(e){ next(e); }
});

router.get('/', requireRole('tenant_admin','supervisor','receiver'), async (req,res,next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const acts = await svc.listActs({
      tenantId: req.user.tenantId,
      clientId,
      inboundOrderId: req.query.inbound_order_id ? Number(req.query.inbound_order_id) : null,
      dateFrom: req.query.date_from || null,
      dateTo: req.query.date_to || null,
      limit: Number(req.query.limit) || 100,
      offset: Number(req.query.offset) || 0,
    });
    res.json({ ok:true, acts });
  } catch(e){ next(e); }
});

router.post('/', requireRole('tenant_admin','supervisor','receiver'), async (req,res,next) => {
  try {
    const clientId = resolveClientScope(req, req.body.client_id);
    if (!clientId) throw new ValidationError('client_id is required');
    const wh = req.body.warehouse_id
      ? { id: Number(req.body.warehouse_id) }
      : await getDefaultWarehouse(req.user.tenantId);
    const result = await svc.createAct({
      tenantId: req.user.tenantId,
      warehouseId: wh.id,
      clientId,
      userId: req.user.id,
      inboundOrderId: req.body.inbound_order_id ? validatePositiveInt(req.body.inbound_order_id, 'inbound_order_id') : null,
      act: req.body.act || {},
      lines: Array.isArray(req.body.lines) ? req.body.lines : [],
      dateFrom: req.body.date_from || null,
      dateTo: req.body.date_to || null,
    });
    res.status(201).json({ ok:true, ...result });
  } catch(e){ next(e); }
});

router.get('/:id', requireRole('tenant_admin','supervisor','receiver'), async (req,res,next) => {
  try {
    const result = await svc.getAct({ tenantId: req.user.tenantId, actId: validatePositiveInt(req.params.id,'id') });
    res.json({ ok:true, ...result });
  } catch(e){ next(e); }
});

/** POST /acts/:id/share — передать акт в кабинет клиента ({shared:true}) или
 *  отозвать ({shared:false}). По умолчанию акты клиенту не видны - см.
 *  миграцию 040. */
router.post('/:id/share', requireRole('tenant_admin','supervisor','receiver'), async (req,res,next) => {
  try {
    const actId = validatePositiveInt(req.params.id, 'id');
    const act = await svc.setActShared({
      tenantId: req.user.tenantId, actId, userId: req.user.id,
      shared: req.body.shared !== false,
    });
    res.json({ ok:true, act });
  } catch(e){ next(e); }
});

router.patch('/:id', requireRole('tenant_admin','supervisor','receiver'), async (req,res,next) => {
  try {
    const result = await svc.updateAct({
      tenantId: req.user.tenantId,
      actId: validatePositiveInt(req.params.id,'id'),
      act: req.body.act || {},
      lines: Array.isArray(req.body.lines) ? req.body.lines : null,
    });
    res.json({ ok:true, ...result });
  } catch(e){ next(e); }
});

module.exports = router;
