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
const { generateQrSvg } = require('../../utils/qrcode');

router.use(authRequired, tenantMiddleware);

// ─────────────── Workstations: admin CRUD ───────────────

router.get('/', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const r = await query(
      `SELECT ws.id, ws.tenant_id, ws.warehouse_id, ws.station_code, ws.station_name, ws.zone_type,
              ws.default_printer_id, ws.marking_printer_id, ws.is_active, ws.notes, ws.created_at, ws.updated_at,
              w.warehouse_name, p.printer_name, p.printer_code, mp.printer_name AS marking_printer_name, mp.printer_code AS marking_printer_code
       FROM wms.workstations ws
       LEFT JOIN wms.warehouses w ON w.id=ws.warehouse_id
       LEFT JOIN wms.printers p ON p.id=ws.default_printer_id
       LEFT JOIN wms.printers mp ON mp.id=ws.marking_printer_id
       WHERE ws.tenant_id=$1 ORDER BY w.warehouse_name, ws.zone_type, ws.station_name`,
      [req.user.tenantId]
    );
    res.json({ ok:true, workstations:r.rows });
  } catch(e){ next(e); }
});

// Как и с printer_code — код рабочего места подбирается сам из названия,
// человек его не придумывает и не заполняет вручную. Вынесено в функцию —
// используется и одиночным POST, и массовым импортом ниже.
async function createWorkstationRow(tenantId, data) {
  const { station_name, zone_type='packing', warehouse_id, default_printer_id, marking_printer_id, notes } = data;
  if (!station_name) throw new ValidationError('station_name is required');

  const base = slugify(station_name, 40);
  let stationCode = base;
  for (let attempt = 0; ; attempt++) {
    const exists = await query(`SELECT id FROM wms.workstations WHERE tenant_id=$1 AND station_code=$2`, [tenantId, stationCode]);
    if (exists.rowCount === 0) break;
    if (attempt >= 10) throw new ValidationError('Could not generate a unique station code, try a different name');
    stationCode = `${base}-${crypto.randomBytes(2).toString('hex')}`;
  }

  const r = await query(
    `INSERT INTO wms.workstations(tenant_id,warehouse_id,station_code,station_name,zone_type,default_printer_id,marking_printer_id,is_active,notes)
     VALUES($1,$2,$3,$4,$5,$6,$7,TRUE,$8) RETURNING *`,
    [tenantId, warehouse_id||null, stationCode, station_name, zone_type, default_printer_id||null, marking_printer_id||null, notes||null]
  );
  return r.rows[0];
}

router.post('/', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const workstation = await createWorkstationRow(req.user.tenantId, req.body);
    res.status(201).json({ ok:true, workstation });
  } catch(e){ next(e); }
});

// Массовое создание рабочих мест списком — тот же принцип, что и
// POST /printing/printers/bulk-import: при 30-40 столах создавать их по
// одному через форму нереально. Строки можно ссылаться на printer_id по
// principle "уже созданные принтеры" (обычно сначала импортируют принтеры,
// потом рабочие места с привязкой к ним). Каждая строка независима, одна
// ошибка не рвёт весь импорт.
router.post('/bulk-import', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const { workstations } = req.body;
    if (!Array.isArray(workstations) || workstations.length===0) throw new ValidationError('workstations must be a non-empty array');
    if (workstations.length > 500) throw new ValidationError('Too many rows in one import (max 500) — split into batches');

    const created = [];
    const errors = [];
    for (let i=0; i<workstations.length; i++) {
      const row = workstations[i];
      try {
        const ws = await createWorkstationRow(req.user.tenantId, row);
        created.push({ id: ws.id, station_name: ws.station_name, station_code: ws.station_code });
      } catch (rowErr) {
        errors.push({ row: i+1, station_name: row && row.station_name, error: rowErr.message });
      }
    }
    res.status(201).json({ ok:true, created, errors, created_count: created.length, error_count: errors.length });
  } catch(e){ next(e); }
});

router.patch('/:id', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const id = validatePositiveInt(req.params.id,'id');
    const { station_name, zone_type, default_printer_id, marking_printer_id, is_active, notes } = req.body;
    const fields=[]; const params=[]; let idx=1;
    if (station_name       !== undefined) { fields.push(`station_name=$${idx++}`);       params.push(station_name); }
    if (zone_type          !== undefined) { fields.push(`zone_type=$${idx++}`);          params.push(zone_type); }
    if (default_printer_id !== undefined) { fields.push(`default_printer_id=$${idx++}`); params.push(default_printer_id||null); }
    if (marking_printer_id !== undefined) { fields.push(`marking_printer_id=$${idx++}`); params.push(marking_printer_id||null); }
    if (is_active          !== undefined) { fields.push(`is_active=$${idx++}`);          params.push(!!is_active); }
    if (notes              !== undefined) { fields.push(`notes=$${idx++}`);              params.push(notes||null); }
    if (!fields.length) throw new ValidationError('No fields');
    fields.push(`updated_at=NOW()`); params.push(id, req.user.tenantId);
    const r = await query(`UPDATE wms.workstations SET ${fields.join(',')} WHERE id=$${idx++} AND tenant_id=$${idx} RETURNING *`, params);
    if (r.rowCount===0) throw new NotFoundError('Workstation', id);
    res.json({ ok:true, workstation:r.rows[0] });
  } catch(e){ next(e); }
});

// QR-код рабочего места для печати физического стикера на стол (обычная
// офисная печать администратором, НЕ через printer-agent — этот стикер
// клеится один раз и живёт долго, ему не нужна очередь печати).
router.get('/:id/sticker', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const id = validatePositiveInt(req.params.id,'id');
    const r = await query(`SELECT station_code, station_name FROM wms.workstations WHERE id=$1 AND tenant_id=$2`, [id, req.user.tenantId]);
    if (r.rowCount===0) throw new NotFoundError('Workstation', id);
    const { station_code, station_name } = r.rows[0];
    const svg = await generateQrSvg(station_code, { width: 260 });
    res.json({ ok:true, station_code, station_name, svg });
  } catch(e){ next(e); }
});

router.delete('/:id', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const id = validatePositiveInt(req.params.id,'id');
    const r = await query(`DELETE FROM wms.workstations WHERE id=$1 AND tenant_id=$2 RETURNING id`, [id, req.user.tenantId]);
    if (r.rowCount===0) throw new NotFoundError('Workstation', id);
    res.json({ ok:true });
  } catch(e){ next(e); }
});

// ─────────────── Workstations: employee-facing (любой авторизованный сотрудник) ───────────────

/** GET /workstations/my — текущее рабочее место сотрудника (если выбрано) */
router.get('/my', async (req,res,next)=>{
  try {
    const r = await query(
      `SELECT eas.station_id, eas.set_at, ws.station_code, ws.station_name, ws.zone_type,
              ws.default_printer_id, ws.marking_printer_id, ws.is_active AS station_is_active,
              p.printer_name, mp.printer_name AS marking_printer_name
       FROM wms.employee_active_station eas
       JOIN wms.workstations ws ON ws.id=eas.station_id
       LEFT JOIN wms.printers p ON p.id=ws.default_printer_id
       LEFT JOIN wms.printers mp ON mp.id=ws.marking_printer_id
       WHERE eas.employee_id=$1 AND eas.tenant_id=$2`,
      [req.user.id, req.user.tenantId]
    );
    res.json({ ok:true, station: r.rows[0] || null });
  } catch(e){ next(e); }
});

/** POST /workstations/select — сотрудник сканирует код рабочего места на столе */
router.post('/select', async (req,res,next)=>{
  try {
    const { station_code } = req.body;
    if (!station_code) throw new ValidationError('station_code is required');

    const wsRes = await query(
      `SELECT * FROM wms.workstations WHERE tenant_id=$1 AND station_code=$2 AND is_active=TRUE`,
      [req.user.tenantId, station_code]
    );
    if (wsRes.rowCount === 0) throw new NotFoundError('Workstation', station_code);
    const station = wsRes.rows[0];

    await query(
      `INSERT INTO wms.employee_active_station(employee_id,tenant_id,station_id,set_at)
       VALUES($1,$2,$3,NOW())
       ON CONFLICT (employee_id) DO UPDATE SET station_id=$3, tenant_id=$2, set_at=NOW()`,
      [req.user.id, req.user.tenantId, station.id]
    );

    res.json({ ok:true, station: { id: station.id, station_code: station.station_code, station_name: station.station_name, zone_type: station.zone_type } });
  } catch(e){ next(e); }
});

module.exports = router;
