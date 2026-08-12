'use strict';

const express = require('express');
const router = express.Router();
const svc = require('./payroll.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware, requireModule } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { validatePositiveInt } = require('../../utils/validators');

router.use(authRequired, tenantMiddleware, requireModule('payroll'));

// =============================================================================
// Payroll Router (сдельная ЗП)
//
// GET    /payroll/rates    — ставки за операцию (по роли или по сотруднику)
// POST   /payroll/rates    — создать/обновить ставку
// DELETE /payroll/rates/:id
// GET    /payroll/report   — отчёт за период: выработка × ставка по сотрудникам
// =============================================================================

router.get('/rates', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const rows = await svc.listRates({ tenantId: req.user.tenantId });
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

router.post('/rates', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const { role, employee_id, movement_type, rate, currency } = req.body;
    const row = await svc.upsertRate({
      tenantId: req.user.tenantId,
      role: role || null,
      employeeId: employee_id ? validatePositiveInt(employee_id, 'employee_id') : null,
      movementType: movement_type,
      rate,
      currency,
    });
    res.status(201).json({ ok: true, row });
  } catch (e) { next(e); }
});

router.delete('/rates/:id', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await svc.deleteRate({
      tenantId: req.user.tenantId,
      id: validatePositiveInt(req.params.id, 'id'),
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.get('/report', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await svc.getPayrollReport({
      tenantId: req.user.tenantId,
      dateFrom: req.query.date_from,
      dateTo: req.query.date_to,
      clientId: req.query.client_id ? Number(req.query.client_id) : null,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.get('/analytics', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await svc.getPayrollAnalytics({
      tenantId:    req.user.tenantId,
      dateFrom:    req.query.date_from,
      dateTo:      req.query.date_to,
      granularity: req.query.granularity || 'day',
      clientId:    req.query.client_id ? Number(req.query.client_id) : null,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

module.exports = router;
