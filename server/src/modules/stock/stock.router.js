'use strict';
const express = require('express');
const router = express.Router();
const svc = require('./stock.service');
const ledger = require('./stock.ledger');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware, resolveClientScope } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { validatePositiveInt, validateBarcode } = require('../../utils/validators');
const { getDefaultWarehouse } = require('../warehouses/warehouses.service');

router.use(authRequired, tenantMiddleware);

/** GET /stock — остатки с фильтрами */
router.get('/', async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const result = await svc.listStockBalances({
      tenantId:     req.user.tenantId,
      warehouseId:  req.query.warehouse_id ? Number(req.query.warehouse_id) : null,
      clientId,
      barcode:      req.query.barcode || null,
      locationCode: req.query.location_code || null,
      onlyWithStock: req.query.only_with_stock !== 'false',
      limit:   Number(req.query.limit) || 500,
      offset:  Number(req.query.offset) || 0,
    });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

/** GET /stock/by-barcode */
router.get('/by-barcode', async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const rows = await svc.getStockByBarcode({
      tenantId: req.user.tenantId, clientId,
      barcode:  req.query.barcode,
      warehouseId: req.query.warehouse_id ? Number(req.query.warehouse_id) : null,
    });
    res.json({ ok: true, locations: rows });
  } catch(e){ next(e); }
});

/** GET /stock/by-location */
router.get('/by-location', async (req,res,next)=>{
  try {
    const rows = await svc.getStockByLocation({
      tenantId: req.user.tenantId,
      locationCode: req.query.location_code,
      warehouseId: req.query.warehouse_id ? Number(req.query.warehouse_id) : null,
    });
    res.json({ ok: true, rows });
  } catch(e){ next(e); }
});

/** GET /stock/movements — история движений */
router.get('/movements', async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const rows = await svc.listMovements({
      tenantId: req.user.tenantId, clientId,
      barcode:       req.query.barcode || null,
      locationCode:  req.query.location_code || null,
      movementType:  req.query.movement_type || null,
      refType:       req.query.ref_type || null,
      refId:         req.query.ref_id || null,
      userId:        req.query.user_id || null,
      dateFrom:      req.query.date_from || null,
      dateTo:        req.query.date_to || null,
      limit:  Number(req.query.limit) || 500,
      offset: Number(req.query.offset) || 0,
    });
    res.json({ ok: true, movements: rows });
  } catch(e){ next(e); }
});

/** POST /stock/adjust — ручная корректировка (инвентаризация) */
router.post('/adjust', requireRole('tenant_admin', 'supervisor', 'inventory_manager'), async (req,res,next)=>{
  try {
    const { client_id, barcode, location_code, actual_qty, comment, warehouse_id } = req.body;
    const clientId = resolveClientScope(req, client_id);
    const wh = warehouse_id
      ? { id: Number(warehouse_id) }
      : await getDefaultWarehouse(req.user.tenantId);

    const result = await ledger.adjustStock({
      tenantId:    req.user.tenantId,
      warehouseId: wh.id,
      clientId,
      barcode, locationCode: location_code,
      actualQty: Number(actual_qty),
      refType: 'adjust', userId: req.user.id, comment,
    });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

/** POST /stock/move — перемещение между ячейками */
router.post('/move', requireRole('tenant_admin','supervisor','inventory_manager'), async (req,res,next)=>{
  try {
    const { client_id, barcode, from_location_code, to_location_code, qty, comment, warehouse_id } = req.body;
    const clientId = resolveClientScope(req, client_id);
    const wh = warehouse_id
      ? { id: Number(warehouse_id) }
      : await getDefaultWarehouse(req.user.tenantId);

    const result = await ledger.moveStock({
      tenantId: req.user.tenantId, warehouseId: wh.id, clientId,
      barcode, fromLocationCode: from_location_code, toLocationCode: to_location_code,
      qty: Number(qty), movementType: 'move', userId: req.user.id, comment,
    });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

module.exports = router;
