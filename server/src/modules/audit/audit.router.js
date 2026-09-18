'use strict';

const express = require('express');
const router = express.Router();
const svc = require('./audit.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { validatePositiveInt } = require('../../utils/validators');

router.use(authRequired, tenantMiddleware);

// =============================================================================
// Audit Router
//
// GET  /audit/actions            — список записей аудита
// GET  /audit/actions/:id        — детальная запись
// GET  /audit/user/:userId       — активность пользователя
// GET  /audit/entity             — история сущности (?type=&id=)
// GET  /audit/stats              — сводка активности
// =============================================================================

router.get('/actions', requireRole('tenant_admin','supervisor','analyst'), async (req, res, next) => {
  try {
    const result = await svc.listActions({
      tenantId:   req.user.tenantId,
      userId:     req.query.user_id    ? Number(req.query.user_id) : null,
      userRole:   req.query.user_role  || null,
      action:     req.query.action     || null,
      entityType: req.query.entity_type || null,
      entityId:   req.query.entity_id   || null,
      dateFrom:   req.query.date_from   || null,
      dateTo:     req.query.date_to     || null,
      search:     req.query.search      || null,
      limit:  Number(req.query.limit)  || 200,
      offset: Number(req.query.offset) || 0,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.get('/actions/:id', requireRole('tenant_admin','supervisor','analyst'), async (req, res, next) => {
  try {
    const action = await svc.getAction({
      tenantId: req.user.tenantId,
      actionId: validatePositiveInt(req.params.id, 'id'),
    });
    res.json({ ok: true, action });
  } catch (e) { next(e); }
});

router.get('/user/:userId', requireRole('tenant_admin','supervisor'), async (req, res, next) => {
  try {
    const rows = await svc.getUserActivity({
      tenantId: req.user.tenantId,
      userId:   validatePositiveInt(req.params.userId, 'userId'),
      limit:    Number(req.query.limit) || 100,
    });
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

router.get('/entity', requireRole('tenant_admin','supervisor','analyst'), async (req, res, next) => {
  try {
    const { entity_type, entity_id } = req.query;
    if (!entity_type || !entity_id) {
      return res.status(400).json({ ok: false, error: { code: 'VALIDATION_ERROR', message: 'entity_type and entity_id are required' } });
    }
    const rows = await svc.getEntityHistory({
      tenantId:   req.user.tenantId,
      entityType: entity_type,
      entityId:   entity_id,
    });
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

router.get('/stats', requireRole('tenant_admin','supervisor','analyst'), async (req, res, next) => {
  try {
    const result = await svc.getStats({
      tenantId: req.user.tenantId,
      dateFrom: req.query.date_from || null,
      dateTo:   req.query.date_to   || null,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

module.exports = router;
