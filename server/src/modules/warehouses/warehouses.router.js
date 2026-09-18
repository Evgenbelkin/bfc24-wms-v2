'use strict';
const express = require('express');
const router = express.Router();
const svc = require('./warehouses.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { validatePositiveInt } = require('../../utils/validators');

router.use(authRequired, tenantMiddleware);

router.get('/',    async (req,res,next)=>{ try { res.json({ ok:true, warehouses: await svc.listWarehouses({ tenantId: req.user.tenantId }) }); } catch(e){ next(e); } });
router.get('/:id', async (req,res,next)=>{ try { res.json({ ok:true, warehouse: await svc.getWarehouseById({ tenantId: req.user.tenantId, warehouseId: validatePositiveInt(req.params.id,'id') }) }); } catch(e){ next(e); } });
router.post('/',   requireRole('tenant_admin'), async (req,res,next)=>{ try { res.status(201).json({ ok:true, warehouse: await svc.createWarehouse({ tenantId: req.user.tenantId, createdById: req.user.id, data: req.body }) }); } catch(e){ next(e); } });
router.patch('/:id', requireRole('tenant_admin'), async (req,res,next)=>{ try { res.json({ ok:true, warehouse: await svc.updateWarehouse({ tenantId: req.user.tenantId, warehouseId: validatePositiveInt(req.params.id,'id'), data: req.body }) }); } catch(e){ next(e); } });

module.exports = router;
