'use strict';

const express = require('express');
const router = express.Router();
const svc = require('./inventory.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware, resolveClientScope } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { requireCheckedIn } = require('../../middleware/requireCheckedIn');
const { validatePositiveInt } = require('../../utils/validators');
const { getDefaultWarehouse } = require('../warehouses/warehouses.service');
const { ValidationError } = require('../../utils/errors');

router.use(authRequired, tenantMiddleware, requireCheckedIn);

// =============================================================================
// Inventory Router
//
// GET  /inventory/tasks              — список задач инвентаризации
// GET  /inventory/tasks/:id          — детальная задача
// POST /inventory/tasks              — создать задачу
// POST /inventory/tasks/batch        — создать задачи по ячейке (bulk)
// POST /inventory/tasks/:id/assign   — назначить исполнителя
// POST /inventory/tasks/:id/count    — внести фактический счёт
// POST /inventory/tasks/:id/close    — закрыть задачу
// GET  /inventory/discrepancies      — отчёт по расхождениям
// =============================================================================

router.get('/tasks', requireRole('tenant_admin','supervisor','inventory_manager'), async (req, res, next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const result = await svc.listTasks({
      tenantId:     req.user.tenantId,
      warehouseId:  req.query.warehouse_id   ? Number(req.query.warehouse_id) : null,
      clientId,
      status:       req.query.status         || null,
      locationCode: req.query.location_code  || null,
      barcode:      req.query.barcode        || null,
      assigneeId:   req.query.assignee_id    ? Number(req.query.assignee_id) : null,
      dateFrom:     req.query.date_from      || null,
      dateTo:       req.query.date_to        || null,
      limit:  Number(req.query.limit)  || 200,
      offset: Number(req.query.offset) || 0,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.get('/tasks/:id', requireRole('tenant_admin','supervisor','inventory_manager'), async (req, res, next) => {
  try {
    const task = await svc.getTask({
      tenantId: req.user.tenantId,
      taskId:   validatePositiveInt(req.params.id, 'id'),
    });
    res.json({ ok: true, task });
  } catch (e) { next(e); }
});

router.post('/tasks', requireRole('tenant_admin','supervisor','inventory_manager'), async (req, res, next) => {
  try {
    const { barcode, location_code, reason, comment, priority, client_id, warehouse_id } = req.body;
    const clientId = resolveClientScope(req, client_id);
    const wh = warehouse_id
      ? { id: Number(warehouse_id) }
      : await getDefaultWarehouse(req.user.tenantId);

    const task = await svc.createTask({
      tenantId:     req.user.tenantId,
      warehouseId:  wh.id,
      clientId,
      barcode:      barcode || null,
      locationCode: location_code,
      reason:       reason   || null,
      comment:      comment  || null,
      priority:     priority ? Number(priority) : 3,
      userId:       req.user.id,
    });
    res.status(201).json({ ok: true, task });
  } catch (e) { next(e); }
});

router.post('/tasks/batch', requireRole('tenant_admin','supervisor','inventory_manager'), async (req, res, next) => {
  try {
    const { location_code, reason, client_id, warehouse_id } = req.body;
    const clientId = resolveClientScope(req, client_id);
    const wh = warehouse_id
      ? { id: Number(warehouse_id) }
      : await getDefaultWarehouse(req.user.tenantId);

    const result = await svc.createBatchTasks({
      tenantId:     req.user.tenantId,
      warehouseId:  wh.id,
      clientId,
      locationCode: location_code,
      reason:       reason || null,
      userId:       req.user.id,
    });
    res.status(201).json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.post('/tasks/:id/assign', requireRole('tenant_admin','supervisor','inventory_manager'), async (req, res, next) => {
  try {
    const task = await svc.assignTask({
      tenantId:   req.user.tenantId,
      taskId:     validatePositiveInt(req.params.id, 'id'),
      assigneeId: Number(req.body.assignee_id),
    });
    res.json({ ok: true, task });
  } catch (e) { next(e); }
});

router.post('/tasks/:id/count', requireRole('tenant_admin','supervisor','inventory_manager'), async (req, res, next) => {
  try {
    const { qty_actual, comment } = req.body;
    const task = await svc.submitCount({
      tenantId:  req.user.tenantId,
      taskId:    validatePositiveInt(req.params.id, 'id'),
      qtyActual: Number(qty_actual),
      userId:    req.user.id,
      comment:   comment || null,
    });
    res.json({ ok: true, task });
  } catch (e) { next(e); }
});

router.post('/tasks/:id/close', requireRole('tenant_admin','supervisor','inventory_manager'), async (req, res, next) => {
  try {
    const { status, comment } = req.body;
    const result = await svc.closeTask({
      tenantId: req.user.tenantId,
      taskId:   validatePositiveInt(req.params.id, 'id'),
      userId:   req.user.id,
      status:   status || 'cancelled',
      comment:  comment || null,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.get('/discrepancies', requireRole('tenant_admin','supervisor','analyst'), async (req, res, next) => {
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const rows = await svc.getDiscrepancyReport({
      tenantId:    req.user.tenantId,
      warehouseId: req.query.warehouse_id ? Number(req.query.warehouse_id) : null,
      clientId,
      dateFrom:    req.query.date_from || null,
      dateTo:      req.query.date_to   || null,
      limit:  Number(req.query.limit)  || 500,
      offset: Number(req.query.offset) || 0,
    });
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

/** POST /inventory/assemble-kit — собрать комплект из базового товара
 *  (см. inventory.service.js assembleKit) - списывает qty*kit_multiplier
 *  базового товара с ячейки, зачисляет qty комплекта на ту же ячейку. */
router.post('/assemble-kit', requireRole('tenant_admin','supervisor','inventory_manager','receiver'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.body.client_id);
    if (!clientId) throw new ValidationError('client_id is required');
    const wh = req.body.warehouse_id ? Number(req.body.warehouse_id) : (await getDefaultWarehouse(req.user.tenantId)).id;
    const result = await svc.assembleKit({
      tenantId: req.user.tenantId,
      warehouseId: wh,
      clientId,
      kitItemId: validatePositiveInt(req.body.kit_item_id, 'kit_item_id'),
      qty: req.body.qty,
      locationCode: req.body.location_code,
      userId: req.user.id,
      comment: req.body.comment || null,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

module.exports = router;
