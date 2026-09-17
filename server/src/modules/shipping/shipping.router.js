'use strict';
const express = require('express');
const router = express.Router();
const svc = require('./shipping.service');
const packingSvc = require('../packing/packing.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware, resolveClientScope } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { requireCheckedIn } = require('../../middleware/requireCheckedIn');

router.use(authRequired, tenantMiddleware, requireCheckedIn);

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

/**
 * GET /shipping/collected-candidates — список отгрузок-кандидатов для
 * сводного файла (сборка завершена, ещё не уехали), для UI с чекбоксами
 * (обсуждение 16.09.2026: "можно сделать выбор галочкой какие отгрузки
 * добавить в эту выгрузку? так было бы точнее"). Лёгкий JSON, без файла.
 */
router.get('/collected-candidates', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const rows = await svc.listCollectedCandidates({
      tenantId: req.user.tenantId,
      clientId,
      warehouseId: req.query.warehouse_id ? Number(req.query.warehouse_id) : null,
    });
    res.json({ ok: true, rows });
  } catch(e){ next(e); }
});

/**
 * POST /shipping/collected-export — Excel с разбивкой ПО ШТРИХКОДАМ внутри
 * каждой выбранной галочками отгрузки (правка 16.09.2026: "нужна информация
 * какие и сколько конкретных баркодов в отгрузках а не строки и шт").
 * shipment_codes — обязателен, отобранные в модалке коды (см.
 * collected-candidates выше). Файл — base64 в JSON, как и другие
 * xlsx-экспорты в этом проекте. POST, т.к. список кодов может быть длинным.
 */
router.post('/collected-export', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const { buffer, count, lines } = await svc.exportCollectedXlsx({
      tenantId: req.user.tenantId,
      warehouseId: req.body.warehouse_id ? Number(req.body.warehouse_id) : null,
      shipmentCodes: Array.isArray(req.body.shipment_codes) ? req.body.shipment_codes : null,
    });
    res.json({
      ok: true,
      count,
      lines,
      filename: `sobrano-${new Date().toISOString().slice(0, 10)}.xlsx`,
      xlsxBase64: buffer.toString('base64'),
    });
  } catch(e){ next(e); }
});

// Лёгкая шапка (для мгновенного открытия карточки под скан) — см. комментарий
// у getShipmentHeader() в shipping.service.js.
router.get('/header', async (req,res,next)=>{
  try {
    const { shipment_code } = req.query;
    const result = await svc.getShipmentHeader({ tenantId: req.user.tenantId, shipmentCode: shipment_code });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

router.get('/details', async (req,res,next)=>{
  try {
    const { shipment_code } = req.query;
    const result = await svc.getShipmentDetails({ tenantId: req.user.tenantId, shipmentCode: shipment_code });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

// Состав ОДНОГО артикула внутри поставки (единицы/стикеры/кизы) — отдельным
// запросом по клику на строку, см. комментарий в shipping.service.js::
// getShipmentDetails (список строк теперь сгруппирован по артикулу).
router.get('/line-units', async (req,res,next)=>{
  try {
    const { shipment_code, barcode } = req.query;
    const result = await svc.getShipmentLineUnits({ tenantId: req.user.tenantId, shipmentCode: shipment_code, barcode });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

// Картинка конкретного стикера ВБ по клику в карточке отгрузки — отдельным
// запросом, не в общем /details (см. комментарий в shipping.service.js::
// getShipmentDetails). Переиспользует ту же ручку, что и упаковка —
// wms.wb_orders общая для обоих модулей, дублировать запрос смысла нет.
router.get('/sticker-image/:wbOrderId', async (req,res,next)=>{
  try {
    const result = await packingSvc.getStickerImage({ tenantId: req.user.tenantId, wbOrderId: req.params.wbOrderId });
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

// Отменить/снять с учёта зависшую отгрузку — только супервайзер/админ
// (необратимое действие: снимает резервы, отменяет задачи сборки/упаковки).
router.post('/cancel', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const { shipment_code, reason } = req.body;
    const result = await svc.cancelShipment({
      tenantId:     req.user.tenantId,
      shipmentCode: shipment_code,
      userId:       req.user.id,
      reason,
    });
    res.json({ ok: true, shipment: result });
  } catch(e){ next(e); }
});

// Вернуть на склад единицы, уже собранные (сняты с полки) под отменённую
// отгрузку — кладовщик физически нашёл товар и указывает актуальную ячейку.
// См. cancelShipment.already_picked — список именно того, что нужно провести
// через этот эндпоинт по одной строке (barcode) за раз.
router.post('/return-picked', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const { shipment_code, barcode, qty, location_code } = req.body;
    const result = await svc.returnPickedStock({
      tenantId:     req.user.tenantId,
      shipmentCode: shipment_code,
      barcode, qty,
      locationCode: location_code,
      userId:       req.user.id,
    });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

module.exports = router;
