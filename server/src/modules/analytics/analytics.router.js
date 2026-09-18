'use strict';

const express = require('express');
const router = express.Router();
const svc = require('./analytics.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware, resolveClientScope } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { requireModule } = require('../../middleware/tenant');

router.use(authRequired, tenantMiddleware, requireModule('analytics'));

// =============================================================================
// Analytics Router
//
// GET /analytics/stock/snapshot     — текущие остатки сводно
// GET /analytics/stock/turnover     — оборачиваемость за период
// GET /analytics/stock/timeline     — шкала движений по barcode
// GET /analytics/ops/receiving      — статистика приёмки по дням
// GET /analytics/ops/picking        — статистика сборки по дням
// GET /analytics/ops/shipping       — статистика отгрузки по дням
// GET /analytics/ops/operators      — KPI операторов
// GET /analytics/client/report      — сводный отчёт по клиенту
// =============================================================================

router.get('/stock/snapshot', requireRole('tenant_admin','supervisor','analyst'), async (req, res, next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const result = await svc.getStockSnapshot({
      tenantId:    req.user.tenantId,
      clientId,
      warehouseId: req.query.warehouse_id ? Number(req.query.warehouse_id) : null,
      onlyNonZero: req.query.all !== 'true',
      limit:  Number(req.query.limit)  || 1000,
      offset: Number(req.query.offset) || 0,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.get('/stock/turnover', requireRole('tenant_admin','supervisor','analyst'), async (req, res, next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const rows = await svc.getTurnoverReport({
      tenantId:    req.user.tenantId,
      clientId,
      warehouseId: req.query.warehouse_id ? Number(req.query.warehouse_id) : null,
      dateFrom:    req.query.date_from || null,
      dateTo:      req.query.date_to   || null,
      limit:  Number(req.query.limit)  || 500,
      offset: Number(req.query.offset) || 0,
    });
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

router.get('/stock/timeline', async (req, res, next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const rows = await svc.getMovementTimeline({
      tenantId: req.user.tenantId,
      barcode:  req.query.barcode,
      clientId,
      limit: Number(req.query.limit) || 100,
    });
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

router.get('/ops/receiving', requireRole('tenant_admin','supervisor','analyst'), async (req, res, next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const rows = await svc.getReceivingStats({
      tenantId:    req.user.tenantId,
      clientId,
      warehouseId: req.query.warehouse_id ? Number(req.query.warehouse_id) : null,
      dateFrom:    req.query.date_from || null,
      dateTo:      req.query.date_to   || null,
    });
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

router.get('/ops/picking', requireRole('tenant_admin','supervisor','analyst'), async (req, res, next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const rows = await svc.getPickingStats({
      tenantId:    req.user.tenantId,
      clientId,
      warehouseId: req.query.warehouse_id ? Number(req.query.warehouse_id) : null,
      dateFrom:    req.query.date_from || null,
      dateTo:      req.query.date_to   || null,
    });
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

router.get('/ops/shipping', requireRole('tenant_admin','supervisor','analyst'), async (req, res, next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const rows = await svc.getShippingStats({
      tenantId:    req.user.tenantId,
      clientId,
      warehouseId: req.query.warehouse_id ? Number(req.query.warehouse_id) : null,
      dateFrom:    req.query.date_from || null,
      dateTo:      req.query.date_to   || null,
    });
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

router.get('/ops/operators', requireRole('tenant_admin','supervisor'), async (req, res, next) => {
  try {
    const rows = await svc.getOperatorStats({
      tenantId: req.user.tenantId,
      dateFrom: req.query.date_from || null,
      dateTo:   req.query.date_to   || null,
    });
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

router.get('/client/report', requireRole('tenant_admin','supervisor','analyst'), async (req, res, next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    if (!clientId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'client_id is required' } });
    }
    const result = await svc.getClientReport({
      tenantId: req.user.tenantId,
      clientId,
      dateFrom: req.query.date_from || null,
      dateTo:   req.query.date_to   || null,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

module.exports = router;
