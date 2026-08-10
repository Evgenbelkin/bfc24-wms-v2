'use strict';

const express = require('express');
const router = express.Router();
const svc = require('./tenant.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');

router.use(authRequired, tenantMiddleware);

// =============================================================================
// Tenant Profile Router
// GET   /tenant/profile — реквизиты своей компании ("Исполнитель" в актах)
// PATCH /tenant/profile — редактировать (только tenant_admin)
// =============================================================================

router.get('/profile', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const profile = await svc.getMyTenantProfile({ tenantId: req.user.tenantId });
    res.json({ ok: true, profile });
  } catch (e) { next(e); }
});

router.patch('/profile', requireRole('tenant_admin'), async (req, res, next) => {
  try {
    const profile = await svc.updateMyTenantProfile({ tenantId: req.user.tenantId, data: req.body });
    res.json({ ok: true, profile });
  } catch (e) { next(e); }
});

module.exports = router;
