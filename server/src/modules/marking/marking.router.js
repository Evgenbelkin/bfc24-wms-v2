'use strict';
const express = require('express');
const router = express.Router();
const svc = require('./marking.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware, requireModule } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { validatePositiveInt } = require('../../utils/validators');
const { ValidationError } = require('../../utils/errors');
const { query } = require('../../config/database');

router.use(authRequired, tenantMiddleware, requireModule('marking'));

/** GET /marking/items/:itemId/codes/summary — сколько кодов свободно/использовано */
router.get('/items/:itemId/codes/summary', async (req, res, next) => {
  try {
    const itemId = validatePositiveInt(req.params.itemId, 'itemId');
    const summary = await svc.getCodesSummary({ tenantId: req.user.tenantId, itemId });
    res.json({ ok: true, summary });
  } catch (e) { next(e); }
});

/** GET /marking/items/:itemId/codes — список кодов (для просмотра/отладки) */
router.get('/items/:itemId/codes', async (req, res, next) => {
  try {
    const itemId = validatePositiveInt(req.params.itemId, 'itemId');
    const codes = await svc.listCodes({
      tenantId: req.user.tenantId, itemId,
      status: req.query.status || null,
      limit: Number(req.query.limit) || 200,
      offset: Number(req.query.offset) || 0,
    });
    res.json({ ok: true, codes });
  } catch (e) { next(e); }
});

/** POST /marking/items/:itemId/codes/import { codes_text } — импорт кодов построчно */
router.post('/items/:itemId/codes/import', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const itemId = validatePositiveInt(req.params.itemId, 'itemId');
    if (!req.body.codes_text) throw new ValidationError('codes_text required');
    const result = await svc.importCodes({
      tenantId: req.user.tenantId, itemId, createdBy: req.user.id,
      codesText: req.body.codes_text,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

/** PATCH /marking/items/:itemId/settings { requires_marking, marking_trigger } */
router.patch('/items/:itemId/settings', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const itemId = validatePositiveInt(req.params.itemId, 'itemId');
    const fields = [];
    const params = [];
    let idx = 1;
    if (req.body.requires_marking !== undefined) {
      fields.push(`requires_marking=$${idx++}`); params.push(!!req.body.requires_marking);
    }
    if (req.body.marking_trigger !== undefined) {
      if (!['receiving', 'packing'].includes(req.body.marking_trigger)) {
        throw new ValidationError(`marking_trigger must be 'receiving' or 'packing'`);
      }
      fields.push(`marking_trigger=$${idx++}`); params.push(req.body.marking_trigger);
    }
    if (fields.length === 0) throw new ValidationError('No fields to update');
    fields.push('updated_at=NOW()');
    params.push(itemId, req.user.tenantId);
    const r = await query(
      `UPDATE wms.items SET ${fields.join(', ')} WHERE id=$${idx++} AND tenant_id=$${idx} RETURNING id, requires_marking, marking_trigger`,
      params
    );
    if (r.rowCount === 0) throw new ValidationError('Item not found');
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) { next(e); }
});

module.exports = router;
