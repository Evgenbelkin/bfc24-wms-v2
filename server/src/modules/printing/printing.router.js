'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { query } = require('../../config/database');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { validatePositiveInt } = require('../../utils/validators');
const { NotFoundError, ValidationError } = require('../../utils/errors');
const { slugify } = require('../../utils/slugify');
const { hashAgentKey } = require('../../utils/agentKey');

router.use(authRequired, tenantMiddleware);

// ─────────────── Printers ───────────────

router.get('/printers', async (req,res,next)=>{
  try {
    const r = await query(
      `SELECT p.id, p.tenant_id, p.warehouse_id, p.printer_code, p.printer_name, p.printer_type,
              p.connection_type, p.device_name, p.ip_address, p.port, p.zone_code,
              p.paper_size_name,
              p.is_default, p.is_active, p.notes, p.created_at, p.updated_at,
              p.agent_last_seen_at, (p.agent_key_hash IS NOT NULL OR p.agent_key_sha256 IS NOT NULL) AS has_agent_key,
              w.warehouse_name
       FROM wms.printers p
       LEFT JOIN wms.warehouses w ON w.id=p.warehouse_id
       WHERE p.tenant_id=$1 ORDER BY w.warehouse_name, p.printer_name`,
      [req.user.tenantId]
    );
    res.json({ ok:true, printers:r.rows });
  } catch(e){ next(e); }
});

// Выпустить (или перевыпустить) постоянный ключ доступа для агента печати —
// не JWT сотрудника, который истекает, а отдельный секрет вида pk_{printerId}_{...},
// привязанный к конкретному принтеру. Показывается вызывающему один раз, хранится
// в виде HMAC-SHA256 (см. utils/agentKey.js — быстрый хэш, не bcrypt: ключ это
// 192 бита случайности, а не пароль человека, замедлять перебор незачем, а CPU
// на частых опросах агента это жгло заметно). agent_key_hash (bcrypt) явно
// обнуляем — перевыпуск полностью переводит принтер на быстрый путь проверки.
// Перевыпуск делает предыдущий ключ недействительным.
router.post('/printers/:id/agent-key', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const id = validatePositiveInt(req.params.id,'id');
    const check = await query(`SELECT id FROM wms.printers WHERE id=$1 AND tenant_id=$2`, [id, req.user.tenantId]);
    if (check.rowCount===0) throw new NotFoundError('Printer', id);

    const secret = crypto.randomBytes(24).toString('hex');
    const rawKey = `pk_${id}_${secret}`;
    const hashHex = hashAgentKey(rawKey);
    await query(
      `UPDATE wms.printers SET agent_key_sha256=$1, agent_key_hash=NULL, agent_last_seen_at=NULL, updated_at=NOW() WHERE id=$2`,
      [hashHex, id]
    );
    // rawKey отдаём один-единственный раз — второй раз получить его будет неоткуда
    res.json({ ok:true, agent_key: rawKey });
  } catch(e){ next(e); }
});

router.post('/printers', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const { printer_name, printer_type='label', connection_type='agent', agent_code, device_name, ip_address, port, zone_code, warehouse_id, is_default=false, paper_size_name } = req.body;
    if (!printer_name) throw new ValidationError('printer_name is required');

    // "Код принтера" раньше вводился человеком вручную — техническое поле, в
    // котором путались ("какой код куда писать"). Теперь подбирается сам из
    // названия, с ретраем при коллизии (UNIQUE(tenant_id,printer_code)) —
    // пользователь этого не видит и не заполняет.
    const base = slugify(printer_name, 40);
    let printerCode = base;
    for (let attempt = 0; ; attempt++) {
      const exists = await query(`SELECT id FROM wms.printers WHERE tenant_id=$1 AND printer_code=$2`, [req.user.tenantId, printerCode]);
      if (exists.rowCount === 0) break;
      if (attempt >= 10) throw new ValidationError('Could not generate a unique printer code, try a different name');
      printerCode = `${base}-${crypto.randomBytes(2).toString('hex')}`;
    }

    const r = await query(
      `INSERT INTO wms.printers(tenant_id,warehouse_id,printer_code,printer_name,printer_type,connection_type,agent_code,device_name,ip_address,port,zone_code,is_default,is_active,paper_size_name)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,TRUE,$13) RETURNING *`,
      [req.user.tenantId, warehouse_id||null, printerCode, printer_name, printer_type, connection_type, agent_code||null, device_name||null, ip_address||null, port||null, zone_code||null, !!is_default, paper_size_name||null]
    );
    res.status(201).json({ ok:true, printer:r.rows[0] });
  } catch(e){ next(e); }
});

router.patch('/printers/:id', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const id = validatePositiveInt(req.params.id,'id');
    const { printer_name, device_name, ip_address, zone_code, is_active, is_default, paper_size_name } = req.body;
    const fields=[]; const params=[]; let idx=1;
    if (printer_name !== undefined) { fields.push(`printer_name=$${idx++}`); params.push(printer_name); }
    if (device_name  !== undefined) { fields.push(`device_name=$${idx++}`);  params.push(device_name||null); }
    if (ip_address   !== undefined) { fields.push(`ip_address=$${idx++}`);   params.push(ip_address||null); }
    if (zone_code    !== undefined) { fields.push(`zone_code=$${idx++}`);    params.push(zone_code||null); }
    if (is_active    !== undefined) { fields.push(`is_active=$${idx++}`);    params.push(!!is_active); }
    if (is_default   !== undefined) { fields.push(`is_default=$${idx++}`);   params.push(!!is_default); }
    if (paper_size_name !== undefined) { fields.push(`paper_size_name=$${idx++}`); params.push(paper_size_name||null); }
    if (!fields.length) throw new ValidationError('No fields');
    fields.push(`updated_at=NOW()`); params.push(id, req.user.tenantId);
    const r = await query(`UPDATE wms.printers SET ${fields.join(',')} WHERE id=$${idx++} AND tenant_id=$${idx} RETURNING *`, params);
    if (r.rowCount===0) throw new NotFoundError('Printer', id);
    res.json({ ok:true, printer:r.rows[0] });
  } catch(e){ next(e); }
});

// ─────────────── Printer Routes ───────────────

router.get('/routes', async (req,res,next)=>{
  try {
    const r = await query(
      `SELECT pr.*, p.printer_name, p.printer_code FROM wms.printer_routes pr
       JOIN wms.printers p ON p.id=pr.printer_id
       WHERE pr.tenant_id=$1 ORDER BY pr.doc_type, pr.route_code`,
      [req.user.tenantId]
    );
    res.json({ ok:true, routes:r.rows });
  } catch(e){ next(e); }
});

router.post('/routes', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const { route_code, doc_type, printer_id, warehouse_id, zone_code, client_id, is_default=false } = req.body;
    if (!route_code||!doc_type||!printer_id) throw new ValidationError('route_code, doc_type, printer_id required');
    const r = await query(
      `INSERT INTO wms.printer_routes(tenant_id,route_code,doc_type,warehouse_id,zone_code,client_id,printer_id,is_default,is_active)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,TRUE) RETURNING *`,
      [req.user.tenantId, route_code, doc_type, warehouse_id||null, zone_code||null, client_id||null, Number(printer_id), !!is_default]
    );
    res.status(201).json({ ok:true, route:r.rows[0] });
  } catch(e){ next(e); }
});

router.patch('/routes/:id', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const id = validatePositiveInt(req.params.id,'id');
    const { printer_id, doc_type, is_default, is_active } = req.body;
    const fields=[]; const params=[]; let idx=1;
    if (printer_id !== undefined) { fields.push(`printer_id=$${idx++}`); params.push(Number(printer_id)); }
    if (doc_type   !== undefined) { fields.push(`doc_type=$${idx++}`);   params.push(doc_type); }
    if (is_default !== undefined) { fields.push(`is_default=$${idx++}`); params.push(!!is_default); }
    if (is_active  !== undefined) { fields.push(`is_active=$${idx++}`);  params.push(!!is_active); }
    if (!fields.length) throw new ValidationError('No fields');
    fields.push(`updated_at=NOW()`); params.push(id, req.user.tenantId);
    const r = await query(`UPDATE wms.printer_routes SET ${fields.join(',')} WHERE id=$${idx++} AND tenant_id=$${idx} RETURNING *`, params);
    if (r.rowCount===0) throw new NotFoundError('PrinterRoute', id);
    res.json({ ok:true, route:r.rows[0] });
  } catch(e){ next(e); }
});

router.delete('/routes/:id', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const id = validatePositiveInt(req.params.id,'id');
    const r = await query(`DELETE FROM wms.printer_routes WHERE id=$1 AND tenant_id=$2 RETURNING id`, [id, req.user.tenantId]);
    if (r.rowCount===0) throw new NotFoundError('PrinterRoute', id);
    res.json({ ok:true });
  } catch(e){ next(e); }
});

// ─────────────── Print Jobs ───────────────
// Polling endpoint для printer-agent

/** GET /printing/jobs — jobs для printer-agent (по printer_id или zone_code) */
router.get('/jobs', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    // Printer-agent аутентифицируется через tenant JWT с ролью tenant_admin или системным токеном
    const { printer_id, status='new', limit=20 } = req.query;
    const params=[req.user.tenantId]; const conds=['pj.tenant_id=$1']; let idx=2;
    if (printer_id) { conds.push(`pj.printer_id=$${idx++}`); params.push(Number(printer_id)); }
    conds.push(`pj.status=$${idx++}`); params.push(status);
    params.push(Math.min(Number(limit),100));
    const r = await query(
      `SELECT pj.*, p.printer_name, p.device_name, p.agent_code, p.paper_size_name
       FROM wms.print_jobs pj JOIN wms.printers p ON p.id=pj.printer_id
       WHERE ${conds.join(' AND ')} ORDER BY pj.created_at ASC LIMIT $${idx}`,
      params
    );
    res.json({ ok:true, data:r.rows });
  } catch(e){ next(e); }
});

/** PATCH /printing/jobs/:id — обновить статус job (printer-agent) */
router.patch('/jobs/:id', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const id = validatePositiveInt(req.params.id,'id');
    const { status, error_text } = req.body;
    const allowed = ['processing','printed','error','cancelled'];
    if (!allowed.includes(status)) throw new ValidationError(`status must be one of: ${allowed.join(', ')}`);
    const r = await query(
      // См. аналогичный фикс в printingAgent.router.js — без явного ::text/
      // ::wms.print_job_status Postgres не может согласовать тип $1 между
      // "status=$1" и "$1='printed'" в CASE и падает с ошибкой 42P08.
      `UPDATE wms.print_jobs
       SET status=$1::wms.print_job_status, error_text=$2,
           printed_at=CASE WHEN $1::text='printed' THEN NOW() ELSE NULL END,
           attempt_count=attempt_count+1, last_attempt_at=NOW(), updated_at=NOW()
       WHERE id=$3 AND tenant_id=$4 RETURNING id, status, printed_at`,
      [status, error_text||null, id, req.user.tenantId]
    );
    if (r.rowCount===0) throw new NotFoundError('PrintJob', id);
    res.json({ ok:true, job:r.rows[0] });
  } catch(e){ next(e); }
});

/** POST /printing/jobs/reprint — перепечатать job */
router.post('/jobs/reprint', requireRole('tenant_admin','supervisor','packer','shipper'), async (req,res,next)=>{
  try {
    const originalId = validatePositiveInt(req.body.job_id,'job_id');
    const orig = await query(
      `SELECT * FROM wms.print_jobs WHERE id=$1 AND tenant_id=$2`, [originalId, req.user.tenantId]
    );
    if (orig.rowCount===0) throw new NotFoundError('PrintJob', originalId);
    const o = orig.rows[0];

    // Принтер для повтора ищем заново по актуальному маршруту для этого типа
    // документа, а не берём printer_id из старого задания как есть — иначе
    // повтор уйдёт на тот же принтер, который могли уже поменять/выключить
    // (реальный кейс: задание висело на отключённом складском принтере,
    // маршрут перевели на другой, а "Повторить" всё равно бил в старый).
    let printerId = o.printer_id;
    const routeRes = await query(
      `SELECT pr.printer_id FROM wms.printer_routes pr
       JOIN wms.printers p ON p.id=pr.printer_id
       WHERE pr.tenant_id=$1 AND pr.doc_type=$2 AND pr.is_active=TRUE AND p.is_active=TRUE
       ORDER BY pr.is_default DESC, pr.id LIMIT 1`,
      [req.user.tenantId, o.doc_type]
    );
    if (routeRes.rowCount > 0) printerId = routeRes.rows[0].printer_id;

    const jobCode = `REPRINT-${originalId}-${Date.now()}`;
    const r = await query(
      `INSERT INTO wms.print_jobs(tenant_id,job_code,printer_id,route_id,doc_type,entity_type,entity_id,copies,payload_json,status,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'new',$10) RETURNING id, job_code, status`,
      [req.user.tenantId, jobCode, printerId, o.route_id, o.doc_type, o.entity_type, o.entity_id, o.copies, o.payload_json, req.user.id]
    );
    res.json({ ok:true, job:r.rows[0] });
  } catch(e){ next(e); }
});

module.exports = router;
