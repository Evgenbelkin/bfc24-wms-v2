'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../../config/database');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { validatePositiveInt } = require('../../utils/validators');
const { NotFoundError, ValidationError } = require('../../utils/errors');

router.use(authRequired, tenantMiddleware);

// ─────────────── Printers ───────────────

router.get('/printers', async (req,res,next)=>{
  try {
    const r = await query(
      `SELECT p.*, w.warehouse_name FROM wms.printers p
       LEFT JOIN wms.warehouses w ON w.id=p.warehouse_id
       WHERE p.tenant_id=$1 ORDER BY w.warehouse_name, p.printer_name`,
      [req.user.tenantId]
    );
    res.json({ ok:true, printers:r.rows });
  } catch(e){ next(e); }
});

router.post('/printers', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const { printer_code, printer_name, printer_type='label', connection_type='agent', agent_code, device_name, ip_address, port, zone_code, warehouse_id, is_default=false } = req.body;
    if (!printer_code||!printer_name) throw new ValidationError('printer_code and printer_name are required');
    const r = await query(
      `INSERT INTO wms.printers(tenant_id,warehouse_id,printer_code,printer_name,printer_type,connection_type,agent_code,device_name,ip_address,port,zone_code,is_default,is_active)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,TRUE) RETURNING *`,
      [req.user.tenantId, warehouse_id||null, printer_code, printer_name, printer_type, connection_type, agent_code||null, device_name||null, ip_address||null, port||null, zone_code||null, !!is_default]
    );
    res.status(201).json({ ok:true, printer:r.rows[0] });
  } catch(e){ next(e); }
});

router.patch('/printers/:id', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const id = validatePositiveInt(req.params.id,'id');
    const { printer_name, device_name, ip_address, zone_code, is_active, is_default } = req.body;
    const fields=[]; const params=[]; let idx=1;
    if (printer_name !== undefined) { fields.push(`printer_name=$${idx++}`); params.push(printer_name); }
    if (device_name  !== undefined) { fields.push(`device_name=$${idx++}`);  params.push(device_name||null); }
    if (ip_address   !== undefined) { fields.push(`ip_address=$${idx++}`);   params.push(ip_address||null); }
    if (zone_code    !== undefined) { fields.push(`zone_code=$${idx++}`);    params.push(zone_code||null); }
    if (is_active    !== undefined) { fields.push(`is_active=$${idx++}`);    params.push(!!is_active); }
    if (is_default   !== undefined) { fields.push(`is_default=$${idx++}`);   params.push(!!is_default); }
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

// ─────────────── Print Jobs ───────────────
// Polling endpoint для printer-agent

/** GET /printing/jobs — jobs для printer-agent (по printer_id или zone_code) */
router.get('/jobs', async (req,res,next)=>{
  try {
    // Printer-agent аутентифицируется через tenant JWT с ролью tenant_admin или системным токеном
    const { printer_id, status='new', limit=20 } = req.query;
    const params=[req.user.tenantId]; const conds=['pj.tenant_id=$1']; let idx=2;
    if (printer_id) { conds.push(`pj.printer_id=$${idx++}`); params.push(Number(printer_id)); }
    conds.push(`pj.status=$${idx++}`); params.push(status);
    params.push(Math.min(Number(limit),100));
    const r = await query(
      `SELECT pj.*, p.printer_name, p.device_name, p.agent_code
       FROM wms.print_jobs pj JOIN wms.printers p ON p.id=pj.printer_id
       WHERE ${conds.join(' AND ')} ORDER BY pj.created_at ASC LIMIT $${idx}`,
      params
    );
    res.json({ ok:true, data:r.rows });
  } catch(e){ next(e); }
});

/** PATCH /printing/jobs/:id — обновить статус job (printer-agent) */
router.patch('/jobs/:id', async (req,res,next)=>{
  try {
    const id = validatePositiveInt(req.params.id,'id');
    const { status, error_text } = req.body;
    const allowed = ['processing','printed','error','cancelled'];
    if (!allowed.includes(status)) throw new ValidationError(`status must be one of: ${allowed.join(', ')}`);
    const r = await query(
      `UPDATE wms.print_jobs
       SET status=$1, error_text=$2,
           printed_at=CASE WHEN $1='printed' THEN NOW() ELSE NULL END,
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
    const jobCode = `REPRINT-${originalId}-${Date.now()}`;
    const r = await query(
      `INSERT INTO wms.print_jobs(tenant_id,job_code,printer_id,route_id,doc_type,entity_type,entity_id,copies,payload_json,status,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'new',$10) RETURNING id, job_code, status`,
      [req.user.tenantId, jobCode, o.printer_id, o.route_id, o.doc_type, o.entity_type, o.entity_id, o.copies, o.payload_json, req.user.id]
    );
    res.json({ ok:true, job:r.rows[0] });
  } catch(e){ next(e); }
});

module.exports = router;
