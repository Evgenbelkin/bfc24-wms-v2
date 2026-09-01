'use strict';

const express = require('express');
const router = express.Router();
const svc = require('./placement.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware, resolveClientScope } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { requireCheckedIn } = require('../../middleware/requireCheckedIn');
const { validateBarcode, validateQty, validatePositiveInt } = require('../../utils/validators');
const { getDefaultWarehouse } = require('../warehouses/warehouses.service');

router.use(authRequired, tenantMiddleware, requireCheckedIn);

// =============================================================================
// Placement Router
//
// GET  /placement/pending          — товары к размещению
// GET  /placement/pending/barcode  — позиции к размещению по barcode
// POST /placement/place            — разместить единицу товара
// POST /placement/batch            — пакетное размещение
// GET  /placement/history          — история размещений
// GET  /placement/suggest          — предложить целевую ячейку
// =============================================================================

/**
 * GET /placement/pending
 * Список позиций, ожидающих размещения (в ячейках receiving/buffer)
 */
router.get('/pending', requireRole('tenant_admin','supervisor','receiver'), async (req, res, next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const wh = req.query.warehouse_id
      ? { id: Number(req.query.warehouse_id) }
      : await getDefaultWarehouse(req.user.tenantId);

    const result = await svc.listPendingPlacement({
      tenantId:    req.user.tenantId,
      warehouseId: wh.id,
      clientId,
      limit:  Number(req.query.limit)  || 200,
      offset: Number(req.query.offset) || 0,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

/**
 * GET /placement/pending/barcode?barcode=XXX
 * Позиции к размещению для конкретного штрихкода
 */
router.get('/pending/barcode', requireRole('tenant_admin','supervisor','receiver'), async (req, res, next) => {
  try {
    const wh = req.query.warehouse_id
      ? { id: Number(req.query.warehouse_id) }
      : await getDefaultWarehouse(req.user.tenantId);

    const rows = await svc.getPendingByBarcode({
      tenantId:    req.user.tenantId,
      barcode:     req.query.barcode,
      warehouseId: wh.id,
    });
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

/**
 * POST /placement/place
 * Разместить товар: из ячейки receiving/buffer → rack/floor
 *
 * Body: { barcode, from_location_code, to_location_code, qty, client_id?, warehouse_id?, comment? }
 */
router.post('/place', requireRole('tenant_admin','supervisor','receiver'), async (req, res, next) => {
  try {
    const { barcode, from_location_code, to_location_code, qty, comment, client_id, warehouse_id } = req.body;
    const clientId = resolveClientScope(req, client_id);
    const wh = warehouse_id
      ? { id: Number(warehouse_id) }
      : await getDefaultWarehouse(req.user.tenantId);

    const result = await svc.placeStock({
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
 * POST /placement/batch
 * Пакетное размещение
 *
 * Body: {
 *   client_id?,
 *   warehouse_id?,
 *   lines: [{ barcode, from_location_code, to_location_code, qty }]
 * }
 */
router.post('/batch', requireRole('tenant_admin','supervisor','receiver'), async (req, res, next) => {
  try {
    const { lines, client_id, warehouse_id } = req.body;
    const clientId = resolveClientScope(req, client_id);
    const wh = warehouse_id
      ? { id: Number(warehouse_id) }
      : await getDefaultWarehouse(req.user.tenantId);

    const result = await svc.placeBatch({
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
 * GET /placement/history
 * История операций размещения
 */
router.get('/history', requireRole('tenant_admin','supervisor','receiver'), async (req, res, next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const wh = req.query.warehouse_id
      ? { id: Number(req.query.warehouse_id) }
      : null;

    const rows = await svc.listPlacementHistory({
      tenantId:    req.user.tenantId,
      warehouseId: wh ? wh.id : null,
      clientId,
      barcode:     req.query.barcode   || null,
      dateFrom:    req.query.date_from || null,
      dateTo:      req.query.date_to   || null,
      limit:       Number(req.query.limit)  || 200,
      offset:      Number(req.query.offset) || 0,
    });
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

/**
 * GET /placement/suggest?item_id=N&client_id=N
 * Предложить целевую ячейку для размещения
 */
router.get('/suggest', requireRole('tenant_admin','supervisor','receiver'), async (req, res, next) => {
  try {
    const itemId   = validatePositiveInt(req.query.item_id, 'item_id');
    const clientId = resolveClientScope(req, req.query.client_id);
    const wh = req.query.warehouse_id
      ? { id: Number(req.query.warehouse_id) }
      : await getDefaultWarehouse(req.user.tenantId);

    const suggestion = await svc.suggestTargetLocation({
      tenantId:    req.user.tenantId,
      warehouseId: wh.id,
      itemId,
      clientId,
      qty:         req.query.qty ? Number(req.query.qty) : 1,
    });
    res.json({ ok: true, suggestion });
  } catch (e) { next(e); }
});

module.exports = router;
