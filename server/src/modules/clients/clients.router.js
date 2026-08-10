'use strict';

const express = require('express');
const router = express.Router();
const svc = require('./clients.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { validatePositiveInt } = require('../../utils/validators');

router.use(authRequired, tenantMiddleware);

router.get('/',       requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const { is_active, search } = req.query;
    const clients = await svc.listClients({
      tenantId: req.user.tenantId,
      isActive: is_active !== undefined ? is_active === 'true' : null,
      search:   search || null,
    });
    res.json({ ok: true, clients });
  } catch(e){ next(e); }
});

router.get('/short',  requireRole('tenant_admin','supervisor','receiver','picker','packer','shipper'), async (req,res,next)=>{
  try {
    const clients = await svc.listClientsShort({ tenantId: req.user.tenantId });
    res.json({ ok: true, clients });
  } catch(e){ next(e); }
});

router.get('/:id',    requireRole('tenant_admin','supervisor','receiver'), async (req,res,next)=>{
  try {
    const client = await svc.getClientById({ tenantId: req.user.tenantId, clientId: validatePositiveInt(req.params.id,'id') });
    res.json({ ok: true, client });
  } catch(e){ next(e); }
});

router.post('/',      requireRole('tenant_admin'), async (req,res,next)=>{
  try {
    const client = await svc.createClient({ tenantId: req.user.tenantId, createdById: req.user.id, data: req.body });
    res.status(201).json({ ok: true, client });
  } catch(e){ next(e); }
});

router.patch('/:id',  requireRole('tenant_admin'), async (req,res,next)=>{
  try {
    const client = await svc.updateClient({ tenantId: req.user.tenantId, clientId: validatePositiveInt(req.params.id,'id'), data: req.body });
    res.json({ ok: true, client });
  } catch(e){ next(e); }
});

module.exports = router;
