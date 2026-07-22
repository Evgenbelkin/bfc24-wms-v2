'use strict';
const express = require('express');
const router = express.Router();
const svc = require('./picking.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { validatePositiveInt } = require('../../utils/validators');

router.use(authRequired, tenantMiddleware);

/** GET /picking/waves */
router.get('/waves', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const waves = await svc.listWaves({
      tenantId:    req.user.tenantId,
      warehouseId: req.query.warehouse_id ? Number(req.query.warehouse_id) : null,
      status:      req.query.status || null,
      pickerId:    req.query.picker_id ? Number(req.query.picker_id) : null,
      limit:       Number(req.query.limit) || 50,
    });
    res.json({ ok: true, waves });
  } catch(e){ next(e); }
});

/** POST /picking/wave/take — picker берёт волну */
router.post('/wave/take', requireRole('tenant_admin','supervisor','picker'), async (req,res,next)=>{
  try {
    const result = await svc.takeWave({ tenantId: req.user.tenantId, pickerId: req.user.id });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

/** GET /picking/wave/status — статус волны текущего picker'а */
router.get('/wave/status', requireRole('tenant_admin','supervisor','picker'), async (req,res,next)=>{
  try {
    const status = await svc.getWaveStatus({ tenantId: req.user.tenantId, pickerId: req.user.id });
    res.json({ ok: true, ...status });
  } catch(e){ next(e); }
});

/** POST /picking/wave/close — закрыть волну */
router.post('/wave/close', requireRole('tenant_admin','supervisor','picker'), async (req,res,next)=>{
  try {
    const { shipment_code, buffer_location_code } = req.body;
    const result = await svc.closeWave({
      tenantId:           req.user.tenantId,
      pickerId:           req.user.id,
      shipmentCode:       shipment_code,
      bufferLocationCode: buffer_location_code,
    });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

/** GET /picking/next — следующее задание */
router.get('/next', requireRole('tenant_admin','supervisor','picker'), async (req,res,next)=>{
  try {
    const task = await svc.getNextTask({
      tenantId:      req.user.tenantId,
      pickerId:      req.user.id,
      shipmentCode:  req.query.shipment_code || null,
    });
    res.json({ ok: true, task: task || null });
  } catch(e){ next(e); }
});

/** POST /picking/scan/location — скан ячейки */
router.post('/scan/location', requireRole('tenant_admin','supervisor','picker'), async (req,res,next)=>{
  try {
    const { picking_task_id, scanned_location_code } = req.body;
    const result = await svc.scanLocation({
      tenantId:            req.user.tenantId,
      pickerId:            req.user.id,
      taskId:              validatePositiveInt(picking_task_id, 'picking_task_id'),
      scannedLocationCode: scanned_location_code,
    });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

/** POST /picking/scan/item — скан товара */
router.post('/scan/item', requireRole('tenant_admin','supervisor','picker'), async (req,res,next)=>{
  try {
    const { picking_task_id, scanned_barcode, comment } = req.body;
    const result = await svc.scanItem({
      tenantId:       req.user.tenantId,
      pickerId:       req.user.id,
      taskId:         validatePositiveInt(picking_task_id, 'picking_task_id'),
      scannedBarcode: scanned_barcode,
      comment,
    });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

/** POST /picking/skip — пропустить задачу */
router.post('/skip', requireRole('tenant_admin','supervisor','picker'), async (req,res,next)=>{
  try {
    const { picking_task_id, reason, comment } = req.body;
    const result = await svc.skipTask({
      tenantId: req.user.tenantId,
      pickerId: req.user.id,
      taskId:   validatePositiveInt(picking_task_id, 'picking_task_id'),
      reason, comment,
    });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

module.exports = router;
