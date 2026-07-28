'use strict';

const express = require('express');
const router = express.Router();
const svc = require('./consumables.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware, resolveClientScope, requireModule } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { validatePositiveInt } = require('../../utils/validators');

router.use(authRequired, tenantMiddleware, requireModule('consumables'));

// =============================================================================
// Consumables Router
//
// GET    /consumables              — справочник расходников с остатками
// POST   /consumables              — создать/обновить расходник
// DELETE /consumables/:id          — деактивировать
// POST   /consumables/:id/adjust   — корректировка остатка (приход/инвентаризация)
// POST   /consumables/:id/usage    — списание (опционально клиенту + автоначисление)
// GET    /consumables/usage        — история списаний
// =============================================================================

router.get('/', requireRole('tenant_admin', 'supervisor', 'packer', 'shipper'), async (req, res, next) => {
  try {
    const rows = await svc.listConsumables({ tenantId: req.user.tenantId, activeOnly: req.query.all !== 'true' });
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

router.post('/', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const { id, name, unit, low_stock_threshold, cost_price, client_unit_price, currency } = req.body;
    const row = await svc.upsertConsumable({
      tenantId: req.user.tenantId,
      id: id ? validatePositiveInt(id, 'id') : null,
      name, unit,
      lowStockThreshold: low_stock_threshold,
      costPrice: cost_price,
      clientUnitPrice: client_unit_price,
      currency,
    });
    res.status(201).json({ ok: true, row });
  } catch (e) { next(e); }
});

router.delete('/:id', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await svc.deactivateConsumable({
      tenantId: req.user.tenantId,
      id: validatePositiveInt(req.params.id, 'id'),
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.post('/:id/adjust', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await svc.adjustStock({
      tenantId: req.user.tenantId,
      consumableId: validatePositiveInt(req.params.id, 'id'),
      delta: Number(req.body.delta),
      userId: req.user.id,
      comment: req.body.comment || null,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.post('/:id/usage', requireRole('tenant_admin', 'supervisor', 'packer', 'shipper'), async (req, res, next) => {
  try {
    const { client_id, warehouse_id, qty, ref_type, ref_id, comment } = req.body;
    const clientId = resolveClientScope(req, client_id);
    const result = await svc.recordUsage({
      tenantId: req.user.tenantId,
      consumableId: validatePositiveInt(req.params.id, 'id'),
      clientId: clientId || null,
      warehouseId: warehouse_id || null,
      qty,
      refType: ref_type || 'manual',
      refId: ref_id || null,
      userId: req.user.id,
      comment: comment || null,
    });
    res.status(201).json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.get('/usage', requireRole('tenant_admin', 'supervisor', 'packer', 'shipper'), async (req, res, next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const rows = await svc.listUsageHistory({
      tenantId: req.user.tenantId,
      clientId,
      consumableId: req.query.consumable_id ? Number(req.query.consumable_id) : null,
      dateFrom: req.query.date_from || null,
      dateTo: req.query.date_to || null,
      limit: Number(req.query.limit) || 200,
      offset: Number(req.query.offset) || 0,
    });
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

module.exports = router;
