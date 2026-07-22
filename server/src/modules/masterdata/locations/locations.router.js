'use strict';
const express = require('express');
const router = express.Router();
const svc = require('./locations.service');
const { authRequired } = require('../../../middleware/auth');
const { tenantMiddleware } = require('../../../middleware/tenant');
const { requireRole } = require('../../../middleware/requireRole');
const { validatePositiveInt } = require('../../../utils/validators');

router.use(authRequired, tenantMiddleware);

router.get('/', async (req,res,next)=>{
  try {
    const result = await svc.listLocations({
      tenantId:     req.user.tenantId,
      warehouseId:  req.query.warehouse_id ? Number(req.query.warehouse_id) : null,
      zoneCode:     req.query.zone_code || null,
      locationType: req.query.location_type || null,
      isActive:     req.query.is_active !== undefined ? req.query.is_active === 'true' : null,
      search:       req.query.search || null,
      limit:        Number(req.query.limit) || 200,
      offset:       Number(req.query.offset) || 0,
    });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

router.get('/by-code', async (req,res,next)=>{
  try {
    const loc = await svc.getLocationByCode({
      tenantId:    req.user.tenantId,
      warehouseId: req.query.warehouse_id ? Number(req.query.warehouse_id) : null,
      locationCode: req.query.code,
    });
    res.json({ ok: true, location: loc });
  } catch(e){ next(e); }
});

router.get('/:id', async (req,res,next)=>{
  try {
    const loc = await svc.getLocationById({ tenantId: req.user.tenantId, locationId: validatePositiveInt(req.params.id,'id') });
    res.json({ ok: true, location: loc });
  } catch(e){ next(e); }
});

router.post('/', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const loc = await svc.createLocation({ tenantId: req.user.tenantId, warehouseId: null, createdById: req.user.id, data: req.body });
    res.status(201).json({ ok: true, location: loc });
  } catch(e){ next(e); }
});

router.patch('/:id', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const loc = await svc.updateLocation({ tenantId: req.user.tenantId, locationId: validatePositiveInt(req.params.id,'id'), data: req.body });
    res.json({ ok: true, location: loc });
  } catch(e){ next(e); }
});

module.exports = router;
