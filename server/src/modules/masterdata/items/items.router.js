'use strict';
const express = require('express');
const router = express.Router();
const svc = require('./items.service');
const { authRequired } = require('../../../middleware/auth');
const { tenantMiddleware, resolveClientScope } = require('../../../middleware/tenant');
const { requireRole } = require('../../../middleware/requireRole');
const { validatePositiveInt } = require('../../../utils/validators');

router.use(authRequired, tenantMiddleware);

router.get('/', async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const result = await svc.listItems({
      tenantId: req.user.tenantId,
      clientId,
      search:   req.query.search   || null,
      isActive: req.query.is_active !== undefined ? req.query.is_active === 'true' : null,
      limit:    Number(req.query.limit) || 100,
      offset:   Number(req.query.offset) || 0,
    });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

router.get('/by-barcode', async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const item = await svc.getItemByBarcode({ tenantId: req.user.tenantId, clientId, barcode: req.query.barcode });
    res.json({ ok: true, item });
  } catch(e){ next(e); }
});

router.get('/:id', async (req,res,next)=>{
  try {
    const item = await svc.getItemById({ tenantId: req.user.tenantId, itemId: validatePositiveInt(req.params.id,'id') });
    res.json({ ok: true, item });
  } catch(e){ next(e); }
});

router.post('/', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.body.client_id);
    const item = await svc.createItem({ tenantId: req.user.tenantId, clientId, createdById: req.user.id, data: req.body });
    res.status(201).json({ ok: true, item });
  } catch(e){ next(e); }
});

router.patch('/:id', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const item = await svc.updateItem({ tenantId: req.user.tenantId, itemId: validatePositiveInt(req.params.id,'id'), data: req.body });
    res.json({ ok: true, item });
  } catch(e){ next(e); }
});

module.exports = router;
