'use strict';

const express = require('express');
const router = express.Router();
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware, requireModule, resolveClientScope } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const deficitService = require('./deficit.service');

// Данные приходят из wms.wb_orders — тот же модуль, что и у FBS-аналитики.
router.use(authRequired, tenantMiddleware, requireModule('wb_integration'), requireRole('tenant_admin', 'supervisor'));

/** GET /deficit/report — товары, по которым открытых заказов больше, чем
 *  доступно в ячейках отбора прямо сейчас. Без client_id — сразу по всем
 *  клиентам тенанта (колонка "Клиент" в каждой строке). */
router.get('/report', async (req, res, next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const result = await deficitService.computeDeficitReport({ tenantId: req.user.tenantId, clientId });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

module.exports = router;
