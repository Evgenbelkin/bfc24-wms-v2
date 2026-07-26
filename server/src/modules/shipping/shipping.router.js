'use strict';
const express = require('express');
const router = express.Router();
const svc = require('./shipping.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware, resolveClientScope } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');

router.use(authRequired, tenantMiddleware);

router.get('/board', requireRole('tenant_admin','supervisor','picker','packer','shipper'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const shipments = await svc.listShipments({
      tenantId:    req.user.tenantId,
      clientId,
      status:      req.query.status      || null,
      marketplace: req.query.marketplace || null,
      dateFrom:    req.query.date_from   || null,
      dateTo:      req.query.date_to     || null,
      shippedFrom: req.query.shipped_from || null,
      shippedTo:   req.query.shipped_to   || null,
      limit:       Number(req.query.limit) || 100,
    });
    res.json({ ok: true, shipments });
  } catch(e){ next(e); }
});

router.get('/details', async (req,res,next)=>{
  try {
    const { shipment_code } = req.query;
    const result = await svc.getShipmentDetails({ tenantId: req.user.tenantId, shipmentCode: shipment_code });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

router.post('/confirm', requireRole('tenant_admin','supervisor','shipper','packer'), async (req,res,next)=>{
  try {
    const { shipment_code, scanned_code } = req.body;
    const result = await svc.confirmShipment({
      tenantId:     req.user.tenantId,
      shipmentCode: shipment_code,
      scannedCode:  scanned_code,
      userId:       req.user.id,
    });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

// Ручное подтверждение доставки — только супервайзер/админ (закрывает
// отгрузку окончательно, минуя автопроверку через WB API).
router.post('/mark-delivered', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const { shipment_code } = req.body;
    const result = await svc.markDelivered({
      tenantId:     req.user.tenantId,
      shipmentCode: shipment_code,
      userId:       req.user.id,
    });
    res.json({ ok: true, shipment: result });
  } catch(e){ next(e); }
});

module.exports = router;
