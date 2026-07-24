'use strict';
const express = require('express');
const router = express.Router();
const svc = require('./overview.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');

router.use(authRequired, tenantMiddleware);

/** GET /overview/funnel — сводка по всей воронке склада ("Табло") */
router.get('/funnel', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const data = await svc.getFunnelOverview({ tenantId: req.user.tenantId });
    res.json({ ok: true, ...data });
  } catch(e){ next(e); }
});

module.exports = router;
