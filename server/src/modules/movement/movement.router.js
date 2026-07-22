'use strict';

const express = require('express');
const router = express.Router();
const svc = require('./movement.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware, resolveClientScope } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { getDefaultWarehouse } = require('../warehouses/warehouses.service');

router.use(authRequired, tenantMiddleware);

// =============================================================================
// Movement Router
//
// POST /movement/move       — переместить товар между ячейками
// POST /movement/batch      — пакетное перемещение
// GET  /movement/history    — история перемещений
// GET  /movement/location   — остаток по ячейке (для предпроверки)
// =============================================================================

/**
 * POST /movement/move
 * Body: { barcode, from_location_code, to_location_code, qty, client_id?, warehouse_id?, comment? }
 */
router.post('/move', requireRole('tenant_admin','supervisor','inventory_manager'), async (req, res, next) => {
  try {
    const { barcode, from_location_code, to_location_code, qty, comment, client_id, warehouse_id } = req.body;
    const clientId = resolveClientScope(req, client_id);
    const wh = warehouse_id
      ? { id: Number(warehouse_id) }
      : await getDefaultWarehouse(req.user.tenantId);

    const result = await svc.moveItem({
      tenantId:         req.user.tenantId,
      warehouseId:      wh.id,
      clientId,
      barcode,
      fromLocationCode: from_location_code,
      toLocationCode:   to_location_code,
      qty:              Number(qty) || 1,
      userId:           req.user.id,
      comment:          comment || null,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

/**
 * POST /movement/batch
 * Body: { client_id?, warehouse_id?, lines: [{ barcode, from_location_code, to_location_code, qty }] }
 */
router.post('/batch', requireRole('tenant_admin','supervisor','inventory_manager'), async (req, res, next) => {
  try {
    const { lines, client_id, warehouse_id } = req.body;
    const clientId = resolveClientScope(req, client_id);
    const wh = warehouse_id
      ? { id: Number(warehouse_id) }
      : await getDefaultWarehouse(req.user.tenantId);

    const result = await svc.moveBatch({
      tenantId:    req.user.tenantId,
      warehouseId: wh.id,
      clientId,
      lines:       lines || [],
      userId:      req.user.id,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

/**
 * GET /movement/history
 */
router.get('/history', requireRole('tenant_admin','supervisor','inventory_manager'), async (req, res, next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const rows = await svc.listMovements({
      tenantId:     req.user.tenantId,
      warehouseId:  req.query.warehouse_id ? Number(req.query.warehouse_id) : null,
      clientId,
      barcode:      req.query.barcode       || null,
      locationCode: req.query.location_code || null,
      dateFrom:     req.query.date_from     || null,
      dateTo:       req.query.date_to       || null,
      limit:  Number(req.query.limit)  || 200,
      offset: Number(req.query.offset) || 0,
    });
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

/**
 * GET /movement/location?location_code=A-01-01&warehouse_id=N
 * Актуальный состав ячейки
 */
router.get('/location', async (req, res, next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const rows = await svc.getLocationStock({
      tenantId:     req.user.tenantId,
      warehouseId:  req.query.warehouse_id ? Number(req.query.warehouse_id) : null,
      locationCode: req.query.location_code,
      clientId,
    });
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

module.exports = router;
