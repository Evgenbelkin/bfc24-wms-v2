'use strict';

const express = require('express');
const router = express.Router();
const svc = require('./billing.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware, resolveClientScope } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { requireModule } = require('../../middleware/tenant');
const { validatePositiveInt } = require('../../utils/validators');

router.use(authRequired, tenantMiddleware, requireModule('billing'));

// =============================================================================
// Billing Router
//
// --- Price List ---
// GET    /billing/price-list          — прайс-лист
// POST   /billing/price-list          — создать/обновить позицию
// DELETE /billing/price-list/:id      — удалить позицию
//
// --- Charges ---
// GET  /billing/charges               — начисления
// POST /billing/charges               — ручное начисление
// GET  /billing/clients/:id/balance   — баланс клиента
//
// --- Invoices ---
// GET  /billing/invoices              — список инвойсов
// GET  /billing/invoices/:id          — детальный инвойс
// POST /billing/invoices              — создать инвойс за период
// PATCH /billing/invoices/:id/status  — обновить статус
//
// --- Analytics ---
// GET /billing/analytics/revenue      — динамика выручки
// GET /billing/analytics/invoices     — динамика по счетам (выставлено/оплачено) + разбивка по клиентам
// =============================================================================

// ─────────────── Price List ───────────────

router.get('/price-list', requireRole('tenant_admin','supervisor'), async (req, res, next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const rows = await svc.listPriceList({ tenantId: req.user.tenantId, clientId });
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

router.post('/price-list', requireRole('tenant_admin'), async (req, res, next) => {
  try {
    const {
      client_id, service_type, description, unit_price, min_charge, currency, valid_from, valid_to,
      storage_mode, extra_unit_price,
    } = req.body;
    const clientId = resolveClientScope(req, client_id);
    const row = await svc.upsertPrice({
      tenantId: req.user.tenantId,
      clientId,
      serviceType: service_type,
      description,
      unitPrice:  unit_price,
      minCharge:  min_charge  || null,
      currency:   currency    || 'RUB',
      validFrom:  valid_from  || null,
      validTo:    valid_to    || null,
      storageMode: storage_mode || null,
      extraUnitPrice: extra_unit_price != null ? extra_unit_price : null,
    });
    res.status(201).json({ ok: true, row });
  } catch (e) { next(e); }
});

router.delete('/price-list/:id', requireRole('tenant_admin'), async (req, res, next) => {
  try {
    const result = await svc.deletePrice({
      tenantId: req.user.tenantId,
      priceId:  validatePositiveInt(req.params.id, 'id'),
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

// ─────────────── Charges ───────────────

router.get('/charges', requireRole('tenant_admin','supervisor','analyst'), async (req, res, next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const result = await svc.listCharges({
      tenantId:    req.user.tenantId,
      clientId,
      serviceType: req.query.service_type || null,
      isInvoiced:  req.query.is_invoiced !== undefined ? req.query.is_invoiced === 'true' : null,
      dateFrom:    req.query.date_from    || null,
      dateTo:      req.query.date_to      || null,
      limit:  Number(req.query.limit)  || 500,
      offset: Number(req.query.offset) || 0,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.post('/charges', requireRole('tenant_admin','supervisor'), async (req, res, next) => {
  try {
    const { client_id, service_type, description, quantity, unit_price, currency, period_date, ref_type, ref_id } = req.body;
    const clientId = resolveClientScope(req, client_id);
    const charge = await svc.addCharge({
      tenantId:    req.user.tenantId,
      clientId,
      serviceType: service_type,
      description,
      quantity:    quantity   || 1,
      unitPrice:   unit_price || 0,
      currency:    currency   || 'RUB',
      periodDate:  period_date || null,
      refType:     ref_type   || null,
      refId:       ref_id     || null,
    });
    res.status(201).json({ ok: true, charge });
  } catch (e) { next(e); }
});

/** POST /billing/charges/bulk-delete { charge_ids } — удалить ещё не
 *  выставленные начисления (исправление ошибочного тарифа задним числом).
 *  Только tenant_admin — это правка финансовых записей. */
router.post('/charges/bulk-delete', requireRole('tenant_admin'), async (req, res, next) => {
  try {
    const result = await svc.bulkDeleteCharges({
      tenantId:  req.user.tenantId,
      chargeIds: req.body.charge_ids,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.get('/clients/:clientId/balance', requireRole('tenant_admin','supervisor'), async (req, res, next) => {
  try {
    const clientId = validatePositiveInt(req.params.clientId, 'clientId');
    const balance = await svc.getClientBalance({ tenantId: req.user.tenantId, clientId });
    res.json({ ok: true, clientId, balance });
  } catch (e) { next(e); }
});

// ─────────────── Analytics ───────────────

router.get('/analytics/revenue', requireRole('tenant_admin', 'supervisor', 'analyst'), async (req, res, next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const result = await svc.getRevenueAnalytics({
      tenantId:    req.user.tenantId,
      clientId:    clientId || null,
      dateFrom:    req.query.date_from,
      dateTo:      req.query.date_to,
      granularity: req.query.granularity || 'day',
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.get('/analytics/invoices', requireRole('tenant_admin', 'supervisor', 'analyst'), async (req, res, next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const result = await svc.getInvoiceAnalytics({
      tenantId:    req.user.tenantId,
      clientId:    clientId || null,
      dateFrom:    req.query.date_from,
      dateTo:      req.query.date_to,
      granularity: req.query.granularity || 'day',
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

// ─────────────── Invoices ───────────────

router.get('/invoices', requireRole('tenant_admin','supervisor','analyst'), async (req, res, next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const result = await svc.listInvoices({
      tenantId: req.user.tenantId,
      clientId,
      status: req.query.status || null,
      limit:  Number(req.query.limit)  || 100,
      offset: Number(req.query.offset) || 0,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.get('/invoices/:id', requireRole('tenant_admin','supervisor','analyst'), async (req, res, next) => {
  try {
    const result = await svc.getInvoice({
      tenantId:  req.user.tenantId,
      invoiceId: validatePositiveInt(req.params.id, 'id'),
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.post('/invoices', requireRole('tenant_admin','supervisor'), async (req, res, next) => {
  try {
    const { client_id, period_from, period_to, notes, currency } = req.body;
    const clientId = resolveClientScope(req, client_id);
    if (!clientId) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'client_id is required' } });
    }
    const result = await svc.createInvoice({
      tenantId:   req.user.tenantId,
      clientId,
      periodFrom: period_from,
      periodTo:   period_to,
      notes:      notes    || null,
      currency:   currency || 'RUB',
    });
    res.status(201).json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.patch('/invoices/:id/status', requireRole('tenant_admin'), async (req, res, next) => {
  try {
    const result = await svc.updateInvoiceStatus({
      tenantId:  req.user.tenantId,
      invoiceId: validatePositiveInt(req.params.id, 'id'),
      status:    req.body.status,
      notes:     req.body.notes || null,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

module.exports = router;
