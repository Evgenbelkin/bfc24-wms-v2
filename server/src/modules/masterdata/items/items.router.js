'use strict';
const express = require('express');
const router = express.Router();
const svc = require('./items.service');
const { authRequired } = require('../../../middleware/auth');
const { tenantMiddleware, resolveClientScope } = require('../../../middleware/tenant');
const { requireRole } = require('../../../middleware/requireRole');
const { validatePositiveInt } = require('../../../utils/validators');
const { generateItemLabelSvg } = require('../../../utils/qrcode');
const { resolvePrinter } = require('../../printing/printerResolver');
const { query } = require('../../../config/database');
const { ValidationError } = require('../../../utils/errors');

router.use(authRequired, tenantMiddleware);

router.get('/', async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const result = await svc.listItems({
      tenantId: req.user.tenantId,
      clientId,
      search:   req.query.search   || null,
      isActive: req.query.is_active !== undefined ? req.query.is_active === 'true' : null,
      limit:    Number(req.query.limit) || 100,
      offset:   Number(req.query.offset) || 0,
    });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

router.get('/by-barcode', async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const item = await svc.getItemByBarcode({ tenantId: req.user.tenantId, clientId, barcode: req.query.barcode });
    res.json({ ok: true, item });
  } catch(e){ next(e); }
});

router.get('/:id', async (req,res,next)=>{
  try {
    const item = await svc.getItemById({ tenantId: req.user.tenantId, itemId: validatePositiveInt(req.params.id,'id') });
    res.json({ ok: true, item });
  } catch(e){ next(e); }
});

router.post('/', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.body.client_id);
    const item = await svc.createItem({ tenantId: req.user.tenantId, clientId, createdById: req.user.id, data: req.body });
    res.status(201).json({ ok: true, item });
  } catch(e){ next(e); }
});

router.patch('/:id', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const item = await svc.updateItem({ tenantId: req.user.tenantId, itemId: validatePositiveInt(req.params.id,'id'), data: req.body });
    res.json({ ok: true, item });
  } catch(e){ next(e); }
});

/** DELETE /items/:id — удалить товар, только если по нему сейчас нет
 *  остатка. Если по товару уже есть история (почти всегда так) — удалить
 *  нельзя (упрётся в внешний ключ), вместо этого его деактивируют
 *  (is_active=false), см. items.service.js:deleteItem. */
router.delete('/:id', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const result = await svc.deleteItem({ tenantId: req.user.tenantId, itemId: validatePositiveInt(req.params.id,'id') });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

/** POST /items/bulk-delete { item_ids } — то же самое пачкой (для чистки
 *  "левых" товаров, например после кривой настройки приёмки, когда она
 *  заводила товар на любой отсканированный штрихкод без разбора). Не падает
 *  на первом же товаре с остатком — просто считает его пропущенным и идёт
 *  дальше. */
router.post('/bulk-delete', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const result = await svc.bulkDeleteItems({ tenantId: req.user.tenantId, itemIds: req.body.item_ids });
    res.json({ ok: true, ...result });
  } catch(e){ next(e); }
});

/** POST /items/:id/print-label { copies } — напечатать этикетку товара
 *  (штрихкод + название) через принтер текущего сотрудника (рабочее место,
 *  если оно выбрано, иначе общий маршрут doc_type='item_barcode'). Нужно для
 *  приёмки: пришёл товар без штрихкода/этикетка потёрлась - нашёл в
 *  справочнике, указал количество, напечатал столько же этикеток.
 *  copies создаёт N ОТДЕЛЬНЫХ print_jobs, а не одно задание с полем copies -
 *  агент (printer-agent/agent.js) само поле copies никогда не читал (проверено
 *  по коду), так что это самый надёжный путь без правок уже развёрнутого
 *  агента на складских компьютерах. */
router.post('/:id/print-label', requireRole('tenant_admin','supervisor','warehouse_worker','receiver'), async (req,res,next)=>{
  try {
    const itemId = validatePositiveInt(req.params.id, 'id');
    const copies = Math.min(Math.max(Number(req.body.copies) || 1, 1), 200);

    const itemRes = await query(
      `SELECT id, barcode, item_name, vendor_code FROM wms.items WHERE id=$1 AND tenant_id=$2`,
      [itemId, req.user.tenantId]
    );
    if (itemRes.rowCount === 0) throw new ValidationError('Item not found');
    const item = itemRes.rows[0];
    if (!item.barcode) throw new ValidationError('У товара не указан штрихкод - печатать нечего');

    const resolved = await resolvePrinter(query, {
      tenantId: req.user.tenantId, docType: 'item_barcode', employeeId: req.user.id,
    });
    if (!resolved) throw new ValidationError('Не найден принтер для этикеток товара - настрой маршрут печати (doc_type=item_barcode) в панели принтеров или выбери рабочее место со своим принтером');

    const svg = generateItemLabelSvg(item.barcode, item.item_name, { vendorCode: item.vendor_code });
    const jobs = [];
    for (let i = 0; i < copies; i++) {
      const jobCode = `ITEMLBL-${item.id}-${Date.now()}-${i}`;
      const r = await query(
        `INSERT INTO wms.print_jobs
           (tenant_id,job_code,printer_id,route_id,doc_type,entity_type,entity_id,copies,payload_json,status,created_by)
         VALUES($1,$2,$3,$4,'item_barcode','item',$5,1,$6::jsonb,'new',$7)
         RETURNING id`,
        [req.user.tenantId, jobCode, resolved.printerId, resolved.routeId, item.id,
         JSON.stringify({ sticker: svg, barcode: item.barcode, item_name: item.item_name }),
         req.user.id]
      );
      jobs.push(r.rows[0].id);
    }
    res.json({ ok: true, printed: jobs.length, job_ids: jobs });
  } catch(e){ next(e); }
});

module.exports = router;
