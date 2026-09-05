'use strict';
const express = require('express');
const router = express.Router();
const multer = require('multer');
const svc = require('./marking.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware, requireModule } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { validatePositiveInt } = require('../../utils/validators');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const { query } = require('../../config/database');
const logger = require('../../utils/logger');

router.use(authRequired, tenantMiddleware, requireModule('marking'));

/**
 * POST /marking/diagnostics/rejected-code — best-effort лог кода, отклонённого
 * ПРОВЕРКОЙ НА ФРОНТЕНДЕ (UI.hasValidKizStructure в receiving.html) ещё ДО
 * похода на сервер. Реальный инцидент показал: фронтовая проверка — зеркало
 * серверной (validators.js) и отклоняет код мгновенно в браузере, но раз
 * запрос до сервера не долетает вовсе, обычный серверный logger.warn (см.
 * registerScannedCodes) никогда не срабатывает — расследовать нечем, кроме
 * слов оператора "код был правильный, но не прошёл". Этот роут явно шлёт
 * "плохой" код на сервер ЦЕЛЕНАПРАВЛЕННО только для лога (не для валидации/
 * сохранения) — чтобы при повторении инцидента можно было поднять байты кода
 * из pm2-логов, а не гадать. Никогда не бросает ошибку и не требует роли
 * выше обычного оператора приёмки — это диагностика, а не бизнес-операция.
 */
router.post('/diagnostics/rejected-code', async (req, res) => {
  try {
    const itemId = req.body.item_id ? Number(req.body.item_id) : null;
    const code = String(req.body.code || '');
    const reason = String(req.body.reason || 'unknown').slice(0, 100);
    logger.warn(
      {
        tenantId: req.user.tenantId, itemId, reason, source: req.body.source || 'unknown',
        len: code.length, hex: Buffer.from(code, 'binary').toString('hex'),
      },
      'marking: код отклонён проверкой НА ФРОНТЕНДЕ (diagnostics/rejected-code)'
    );
  } catch (e) { /* диагностика best-effort - не должна ломать сканирование */ }
  res.json({ ok: true });
});

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

/** POST /marking/items/:itemId/codes/import-file { file } — импорт кодов из
 *  .xlsx, альтернатива вставке текстом/сканированию для клиентов, у которых
 *  уже есть выгрузка кодов файлом. Файл целиком читается в память (лимит
 *  5 МБ — список кодов даже на тысячи строк весит существенно меньше). */
const uploadCodesFile = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }).single('file');

router.post('/items/:itemId/codes/import-file', requireRole('tenant_admin', 'supervisor'), (req, res, next) => {
  uploadCodesFile(req, res, async (uploadErr) => {
    try {
      if (uploadErr) {
        if (uploadErr.code === 'LIMIT_FILE_SIZE') throw new ValidationError('Файл слишком большой (максимум 5 МБ)');
        throw new ValidationError(`Не удалось загрузить файл: ${uploadErr.message}`);
      }
      const itemId = validatePositiveInt(req.params.itemId, 'itemId');
      if (!req.file) throw new ValidationError('Файл не передан');
      if (!/\.xlsx$/i.test(req.file.originalname || '')) throw new ValidationError('Поддерживаются только файлы .xlsx');
      const result = await svc.importCodesFromExcel({
        tenantId: req.user.tenantId, itemId, createdBy: req.user.id,
        fileBuffer: req.file.buffer,
      });
      res.json({ ok: true, ...result });
    } catch (e) { next(e); }
  });
});

/** PATCH /marking/items/:itemId/settings { requires_marking, marking_trigger, marking_mode } */
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
    if (req.body.marking_mode !== undefined) {
      if (!['print', 'scan', 'scan_packing'].includes(req.body.marking_mode)) {
        throw new ValidationError(`marking_mode must be 'print', 'scan' or 'scan_packing'`);
      }
      fields.push(`marking_mode=$${idx++}`); params.push(req.body.marking_mode);
    }
    if (fields.length === 0) throw new ValidationError('No fields to update');
    fields.push('updated_at=NOW()');
    params.push(itemId, req.user.tenantId);
    const r = await query(
      `UPDATE wms.items SET ${fields.join(', ')} WHERE id=$${idx++} AND tenant_id=$${idx}
       RETURNING id, requires_marking, marking_trigger, marking_mode`,
      params
    );
    if (r.rowCount === 0) throw new ValidationError('Item not found');
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) { next(e); }
});

/** PATCH /marking/items/bulk-settings { item_ids, requires_marking, marking_trigger, marking_mode } —
 *  та же настройка, что и одиночный PATCH выше, но сразу на пачку товаров —
 *  чтобы не открывать карточку каждого из сотен SKU по одному при подключении
 *  нового клиента на маркировку. */
router.patch('/items/bulk-settings', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const itemIds = Array.isArray(req.body.item_ids)
      ? req.body.item_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : [];
    if (!itemIds.length) throw new ValidationError('item_ids is required');
    if (itemIds.length > 1000) throw new ValidationError('Слишком много товаров за один раз (максимум 1000)');

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
    if (req.body.marking_mode !== undefined) {
      if (!['print', 'scan', 'scan_packing'].includes(req.body.marking_mode)) {
        throw new ValidationError(`marking_mode must be 'print', 'scan' or 'scan_packing'`);
      }
      fields.push(`marking_mode=$${idx++}`); params.push(req.body.marking_mode);
    }
    if (fields.length === 0) throw new ValidationError('No fields to update');
    fields.push('updated_at=NOW()');
    params.push(itemIds, req.user.tenantId);
    const r = await query(
      `UPDATE wms.items SET ${fields.join(', ')} WHERE id = ANY($${idx++}::int[]) AND tenant_id=$${idx}
       RETURNING id`,
      params
    );
    res.json({ ok: true, updated: r.rowCount });
  } catch (e) { next(e); }
});

/** DELETE /marking/items/:itemId/codes/:codeId — убрать "левый" код из пула
 *  (только свободный/не использованный код, только tenant_admin/supervisor —
 *  необратимо, коды нельзя восстановить, только заново отсканировать/вставить). */
router.delete('/items/:itemId/codes/:codeId', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const itemId = validatePositiveInt(req.params.itemId, 'itemId');
    const codeId = validatePositiveInt(req.params.codeId, 'codeId');
    const deleted = await svc.deleteCode({ tenantId: req.user.tenantId, itemId, codeId });
    res.json({ ok: true, deleted });
  } catch (e) { next(e); }
});

/** GET /marking/export?shipment_code=WB-GI-... — коды "Честный знак", ушедшие
 *  в конкретную поставку (для клиентов с рубильником marking_wb_submit_disabled,
 *  см. clients.service.js/миграцию 044) — выгрузка штрихкод+код для передачи
 *  в Тотал Марк/Честный знак. Роль как у остальных операций упаковки/отгрузки,
 *  не только у tenant_admin/supervisor — экспорт может понадобиться прямо на
 *  месте у сотрудника отгрузки. */
router.get('/export', requireRole('tenant_admin', 'supervisor', 'shipper', 'packer'), async (req, res, next) => {
  try {
    const shipmentCode = String(req.query.shipment_code || '').trim();
    if (!shipmentCode) throw new ValidationError('shipment_code is required');
    const result = await svc.listCodesForShipment({ tenantId: req.user.tenantId, shipmentExternalId: shipmentCode });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

/** GET /marking/shipped-report?client_id&date_from&date_to — общая выгрузка
 *  "что отгружено в WB и в какой поставке" сразу по всем поставкам тенанта
 *  (в отличие от /export выше, который смотрит только ОДНУ поставку по её
 *  коду) — для сверки/архива, дата+штрихкод+киз+поставка+статус отправки. */
router.get('/shipped-report', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await svc.getShippedReport({
      tenantId: req.user.tenantId,
      clientId: req.query.client_id ? Number(req.query.client_id) : null,
      dateFrom: req.query.date_from || null,
      dateTo: req.query.date_to || null,
      sticker: req.query.sticker || null,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

/** GET /marking/codes-journal?client_id&barcode&status&sticker&date_from&date_to —
 *  общий журнал приход/расход по КАЖДОМУ коду тенанта (не только отгруженным,
 *  как /shipped-report) - когда пришёл (импорт/скан) и когда/куда ушёл
 *  (поставка), включая коды, которые ещё лежат в пуле неиспользованными. */
router.get('/codes-journal', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await svc.getCodesJournal({
      tenantId: req.user.tenantId,
      clientId: req.query.client_id ? Number(req.query.client_id) : null,
      barcode: req.query.barcode || null,
      status: req.query.status || null,
      sticker: req.query.sticker || null,
      dateFrom: req.query.date_from || null,
      dateTo: req.query.date_to || null,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

/** POST /marking/reprint-code — перепечатать этикетку уже выданного кода
 *  (двойная маркировка: пакет + коробка). Ничего не меняет в marking_codes,
 *  только ставит новое печатное задание. Доступно упаковщику. */
router.post('/reprint-code', requireRole('tenant_admin', 'supervisor', 'packer'), async (req, res, next) => {
  try {
    const result = await svc.reprintCode({
      tenantId: req.user.tenantId,
      code: req.body.code,
      userId: req.user.id,
      employeeId: req.body.employee_id || req.user.id,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

/** GET /marking/code-timeline?code=... — хронология движения одного кода
 *  (клик на код в отчётах). Собирается из уже существующих таблиц. */
router.get('/code-timeline', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await svc.getCodeTimeline({ tenantId: req.user.tenantId, code: req.query.code });
    if (!result) throw new NotFoundError('MarkingCode', req.query.code);
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

// ─────────────── Вывод из оборота (проданные товары) ───────────────
// См. миграцию 055 и marking.service.js — только реально ВЫКУПЛЕННЫЕ коды
// (не просто отгруженные), для передачи в Total Mark/ЦРПТ. Явный журнал
// выгрузок без возможности редактирования задним числом (см. обсуждение с
// пользователем 04.09.2026).

/** GET /marking/withdrawal/pending — предпросмотр того, что попадёт в
 *  следующую выгрузку (ничего не помечает, просто показывает). */
router.get('/withdrawal/pending', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const rows = await svc.getPendingWithdrawal({
      tenantId: req.user.tenantId,
      clientId: req.query.client_id ? Number(req.query.client_id) : null,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    // Счётчики просрочки — считаются здесь (не в сервисе), т.к. это чисто
    // презентационная сводка по уже посчитанному deadline_at, "сейчас" имеет
    // смысл только на момент ответа конкретному запросу.
    const now = Date.now();
    const dueSoonMs = now + 24 * 60 * 60 * 1000;
    let overdueCount = 0, dueSoonCount = 0;
    for (const r of rows) {
      if (!r.deadline_at) continue;
      const t = new Date(r.deadline_at).getTime();
      if (t < now) overdueCount++;
      else if (t <= dueSoonMs) dueSoonCount++;
    }
    res.json({ ok: true, rows, count: rows.length, overdue_count: overdueCount, due_soon_count: dueSoonCount });
  } catch (e) { next(e); }
});

/** POST /marking/withdrawal/export — сформировать выгрузку прямо сейчас
 *  (ручная кнопка) — атомарно снимает текущий "хвост" и помечает как
 *  exported, тот же путь, что и у ночного крона (source различается). */
router.post('/withdrawal/export', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await svc.createWithdrawalExport({
      tenantId: req.user.tenantId,
      clientId: req.body.client_id ? Number(req.body.client_id) : null,
      userId: req.user.id,
      source: 'manual',
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

/** GET /marking/withdrawal/exports — история выгрузок (шапки, без строк). */
router.get('/withdrawal/exports', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const rows = await svc.listWithdrawalExports({
      tenantId: req.user.tenantId,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

/** GET /marking/withdrawal/exports/:id — неизменяемый снимок конкретной
 *  выгрузки, для повторного скачивания в любой момент. */
router.get('/withdrawal/exports/:id', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await svc.getWithdrawalExportItems({ tenantId: req.user.tenantId, exportId: req.params.id });
    if (!result) throw new NotFoundError('Export', req.params.id);
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

/** GET /marking/pending-manual-overrides — коды, проведённые без отправки в WB (требуют ручной привязки) */
router.get('/pending-manual-overrides', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const rows = await svc.listPendingManualOverrides({
      tenantId: req.user.tenantId,
      limit: Number(req.query.limit) || 200,
    });
    res.json({ ok: true, rows });
  } catch (e) { next(e); }
});

module.exports = router;
