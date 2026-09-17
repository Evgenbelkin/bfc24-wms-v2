'use strict';
const express = require('express');
const router = express.Router();
const svc = require('./locations.service');
const { authRequired } = require('../../../middleware/auth');
const { tenantMiddleware } = require('../../../middleware/tenant');
const { requireRole } = require('../../../middleware/requireRole');
const { validatePositiveInt } = require('../../../utils/validators');
const { ValidationError } = require('../../../utils/errors');
const { generateLocationLabelSvg } = require('../../../utils/qrcode');

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
      subWarehouseId: req.query.sub_warehouse_id === 'none' ? 'none' : (req.query.sub_warehouse_id ? Number(req.query.sub_warehouse_id) : null),
      limit:        Number(req.query.limit) || 200,
      offset:       Number(req.query.offset) || 0,
    });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

/** ---------- Под-склады (17.09.2026) ----------
 *  GET  /locations/sub-warehouses?warehouse_id=  — список
 *  POST /locations/sub-warehouses { warehouse_id, code, name } — создать
 *  PATCH /locations/sub-warehouses/:id { name?, is_active? } — переименовать/деактивировать
 *  PATCH /locations/bulk-sub-warehouse { ids, sub_warehouse_id } — массово назначить/снять */
router.get('/sub-warehouses', async (req,res,next)=>{
  try {
    const rows = await svc.listSubWarehouses({
      tenantId:    req.user.tenantId,
      warehouseId: req.query.warehouse_id ? Number(req.query.warehouse_id) : null,
      isActive:    req.query.is_active !== undefined ? req.query.is_active === 'true' : null,
    });
    res.json({ ok: true, sub_warehouses: rows });
  } catch(e){ next(e); }
});

router.post('/sub-warehouses', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const sw = await svc.createSubWarehouse({
      tenantId: req.user.tenantId, createdById: req.user.id,
      warehouseId: req.body.warehouse_id, code: req.body.code, name: req.body.name,
    });
    res.status(201).json({ ok: true, sub_warehouse: sw });
  } catch(e){ next(e); }
});

router.patch('/sub-warehouses/:id', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const sw = await svc.updateSubWarehouse({
      tenantId: req.user.tenantId, subWarehouseId: validatePositiveInt(req.params.id,'id'), data: req.body,
    });
    res.json({ ok: true, sub_warehouse: sw });
  } catch(e){ next(e); }
});

router.patch('/bulk-sub-warehouse', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const result = await svc.bulkAssignSubWarehouse({
      tenantId: req.user.tenantId, ids: req.body.ids, subWarehouseId: req.body.sub_warehouse_id || null,
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

/** GET /locations/fill-report — заполняемость ячеек по объёму, для сетки на
 *  экране (см. locations.service.js:getLocationFillReport). */
router.get('/fill-report', async (req,res,next)=>{
  try {
    const rows = await svc.getLocationFillReport({
      tenantId:    req.user.tenantId,
      warehouseId: req.query.warehouse_id ? Number(req.query.warehouse_id) : null,
      pickOnly:    req.query.pick_only !== 'false',
    });
    res.json({ ok: true, locations: rows });
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

/** POST /locations/bulk — сгенерировать ячейки по шаблону "<зона>-<ряд>-<позиция>"
 *  (например A-01-01..A-06-50) вместо создания по одной руками. */
router.post('/bulk', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const result = await svc.bulkCreateLocations({
      tenantId: req.user.tenantId,
      createdById: req.user.id,
      warehouseId: req.body.warehouse_id,
      zone: req.body.zone,
      rowFrom: req.body.row_from,
      rowTo: req.body.row_to,
      positionFrom: req.body.position_from,
      positionTo: req.body.position_to,
      locationType: req.body.location_type || 'rack',
      padWidth: req.body.pad_width,
      lengthCm: req.body.length_cm,
      widthCm: req.body.width_cm,
      heightCm: req.body.height_cm,
      maxVolumeL: req.body.max_volume_l,
    });
    res.status(201).json({ ok: true, ...result });
  } catch(e){ next(e); }
});

/** PATCH /locations/bulk-dimensions { ids, length_cm, width_cm, height_cm, max_volume_l }
 *  — задать размеры/вместимость сразу нескольким выбранным ячейкам. */
router.patch('/bulk-dimensions', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const result = await svc.bulkUpdateDimensions({
      tenantId: req.user.tenantId,
      ids: req.body.ids,
      lengthCm: req.body.length_cm,
      widthCm: req.body.width_cm,
      heightCm: req.body.height_cm,
      maxVolumeL: req.body.max_volume_l,
    });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

/** POST /locations/labels { location_ids } — SVG-наклейки (штрихкод ячейки)
 *  для массовой печати пачкой, вместо печати по одной. */
router.post('/labels', async (req,res,next)=>{
  try {
    const ids = Array.isArray(req.body.location_ids) ? req.body.location_ids : [];
    if (!ids.length) throw new ValidationError('location_ids is required');
    if (ids.length > 500) throw new ValidationError('Слишком много ячеек за один раз (максимум 500)');
    const locs = await svc.getLocationsByIds({ tenantId: req.user.tenantId, ids });
    const labels = locs.map(l => ({ location_id: l.id, location_code: l.location_code, svg: generateLocationLabelSvg(l.location_code) }));
    res.json({ ok: true, labels });
  } catch(e){ next(e); }
});

router.patch('/:id', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const loc = await svc.updateLocation({ tenantId: req.user.tenantId, locationId: validatePositiveInt(req.params.id,'id'), data: req.body });
    res.json({ ok: true, location: loc });
  } catch(e){ next(e); }
});

/** DELETE /locations/:id — удалить ячейку, только если в ней сейчас нет
 *  товара. Если по ячейке уже есть история движений — удалить нельзя (упрётся
 *  в внешний ключ), вместо этого её деактивируют (is_active=false), см.
 *  locations.service.js:deleteLocation. */
router.delete('/:id', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const result = await svc.deleteLocation({ tenantId: req.user.tenantId, locationId: validatePositiveInt(req.params.id,'id') });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

module.exports = router;
