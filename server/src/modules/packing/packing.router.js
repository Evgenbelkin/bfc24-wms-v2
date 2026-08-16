'use strict';
const express = require('express');
const router = express.Router();
const svc = require('./packing.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { requireCheckedIn } = require('../../middleware/requireCheckedIn');
const { validatePositiveInt } = require('../../utils/validators');

router.use(authRequired, tenantMiddleware, requireCheckedIn);

/** POST /packing/next — взять/получить задачу */
router.post('/next', requireRole('tenant_admin','supervisor','packer'), async (req,res,next)=>{
  try {
    const task = await svc.getOrTakePackingTask({ tenantId: req.user.tenantId, packerId: req.user.id });
    if (!task) return res.json({ ok: true, task: null });
    const { shipment, lines } = await svc.getPackingTaskDetails({
      tenantId: req.user.tenantId,
      shipmentCode: task.shipment_code,
    });
    res.json({ ok: true, task, shipment, lines });
  } catch(e){ next(e); }
});

/** GET /packing/current — текущее задание без смены статуса */
router.get('/current', requireRole('tenant_admin','supervisor','packer'), async (req,res,next)=>{
  try {
    const r = await require('../../config/database').query(
      `SELECT * FROM wms.packing_tasks
       WHERE tenant_id=$1 AND packer_id=$2 AND status='in_progress'
       ORDER BY id LIMIT 1`,
      [req.user.tenantId, req.user.id]
    );
    if (r.rowCount === 0) return res.json({ ok: true, task: null });
    const task = r.rows[0];
    const { shipment, lines } = await svc.getPackingTaskDetails({
      tenantId: req.user.tenantId,
      shipmentCode: task.shipment_code,
    });
    res.json({ ok: true, task, shipment, lines });
  } catch(e){ next(e); }
});

/** POST /packing/scan-item */
router.post('/scan-item', requireRole('tenant_admin','supervisor','packer'), async (req,res,next)=>{
  try {
    const { shipment_code, scan_code, data_matrix_code, marking_override } = req.body;
    const result = await svc.scanItem({
      tenantId:     req.user.tenantId,
      packerId:     req.user.id,
      shipmentCode: shipment_code,
      barcode:      scan_code,
      dataMatrixCode: data_matrix_code || null,
      markingOverride: marking_override && marking_override.reason ? {
        reason: marking_override.reason,
        supervisorUsername: marking_override.supervisor_username,
        supervisorPassword: marking_override.supervisor_password,
      } : null,
    });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

/** GET /packing/sticker-image/:wbOrderId — картинка одного стикера ВБ по
 *  клику на чип (см. комментарий в packing.service.js:getPackingTaskDetails
 *  про то, почему это не отдаётся сразу в общем списке строк). */
router.get('/sticker-image/:wbOrderId', requireRole('tenant_admin','supervisor','packer'), async (req,res,next)=>{
  try {
    const wbOrderId = validatePositiveInt(req.params.wbOrderId, 'wbOrderId');
    const result = await svc.getStickerImage({ tenantId: req.user.tenantId, wbOrderId });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

/** POST /packing/confirm */
router.post('/confirm', requireRole('tenant_admin','supervisor','packer'), async (req,res,next)=>{
  try {
    const { shipment_id, boxes_count, location_code, comment } = req.body;
    const result = await svc.confirmPacking({
      tenantId:     req.user.tenantId,
      packerId:     req.user.id,
      shipmentId:   validatePositiveInt(shipment_id, 'shipment_id'),
      boxesCount:   boxes_count ? Number(boxes_count) : 1,
      locationCode: location_code || null,
      comment:      comment || null,
    });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

module.exports = router;
