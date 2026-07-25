'use strict';

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { query } = require('../../config/database');
const { validatePositiveInt } = require('../../utils/validators');
const { AuthError, ValidationError, NotFoundError } = require('../../utils/errors');

// =============================================================================
// Отдельный роутер для printer-agent (программа-агент печати, работающая на
// компьютере, физически подключённом к принтеру).
//
// Раньше агент авторизовался обычным JWT сотрудника — тот истекает по времени
// (несколько часов), и когда это происходило, агент тихо переставал забирать
// задания: печать останавливалась без явной ошибки, задания просто копились
// в очереди. Здесь — отдельная, НЕ истекающая по времени авторизация: постоянный
// ключ вида pk_{printerId}_{secret}, который админ/супервайзер выпускает один
// раз в панели принтеров (POST /printing/printers/:id/agent-key) и вписывает
// в настройки агента.
//
// printerId в самом ключе не секретен (это просто ID из общей таблицы принтеров) —
// он нужен только для мгновенного поиска по первичному ключу без полного скана
// таблицы принтеров по всем тенантам на каждый опрос (агент дёргает эндпоинт раз
// в 1.5 секунды, а тенантов и принтеров may be тысячи). Секретность обеспечивает
// сам secret, который проверяется через bcrypt.
// =============================================================================

async function agentKeyAuth(req, res, next) {
  try {
    const raw = req.headers['x-agent-key'];
    if (!raw || typeof raw !== 'string') throw new AuthError('X-Agent-Key header required');
    const m = /^pk_(\d+)_/.exec(raw);
    if (!m) throw new AuthError('Malformed agent key');
    const printerId = Number(m[1]);

    const r = await query(
      `SELECT id, tenant_id, agent_key_hash, is_active FROM wms.printers WHERE id=$1`,
      [printerId]
    );
    if (r.rowCount === 0 || !r.rows[0].agent_key_hash) throw new AuthError('Unknown agent key');
    const printer = r.rows[0];

    const match = await bcrypt.compare(raw, printer.agent_key_hash);
    if (!match) throw new AuthError('Invalid agent key');
    if (!printer.is_active) throw new AuthError('Printer is disabled');

    req.agentPrinter = { id: printer.id, tenantId: printer.tenant_id };

    // Heartbeat — фиксируем факт выхода на связь независимо от того, были ли
    // новые задания. Панель принтеров показывает по этому полю "на связи" /
    // "не выходил на связь Xч" вместо тихого молчания при падении агента.
    query(`UPDATE wms.printers SET agent_last_seen_at=NOW() WHERE id=$1`, [printer.id]).catch(()=>{});

    next();
  } catch (e) { next(e); }
}

/** GET /printer-agent/jobs?status=new&limit=10 — задания на печать для ЭТОГО принтера */
router.get('/jobs', agentKeyAuth, async (req,res,next)=>{
  try {
    const { status='new', limit=20 } = req.query;
    // printer_name/device_name нужны агенту, чтобы понять, какому устройству ОС
    // (Windows/CUPS) слать печать — оставляем join, как было в старом эндпоинте.
    // paper_size_name — необязательное имя именованного формата бумаги (Stock)
    // из настроек драйвера конкретного принтера (см. migration 016) - агент
    // подставляет его в paperSize при печати вместо generic custom-size, если
    // оно задано в карточке принтера.
    const r = await query(
      `SELECT pj.*, p.printer_name, p.device_name, p.paper_size_name
       FROM wms.print_jobs pj
       JOIN wms.printers p ON p.id = pj.printer_id
       WHERE pj.tenant_id=$1 AND pj.printer_id=$2 AND pj.status=$3
       ORDER BY pj.created_at ASC LIMIT $4`,
      [req.agentPrinter.tenantId, req.agentPrinter.id, status, Math.min(Number(limit)||20,100)]
    );
    res.json({ ok:true, data:r.rows });
  } catch(e){ next(e); }
});

/** PATCH /printer-agent/jobs/:id — обновить статус задания (сам агент) */
router.patch('/jobs/:id', agentKeyAuth, async (req,res,next)=>{
  try {
    const id = validatePositiveInt(req.params.id,'id');
    const { status, error_text } = req.body;
    const allowed = ['processing','printed','error','cancelled'];
    if (!allowed.includes(status)) throw new ValidationError(`status must be one of: ${allowed.join(', ')}`);
    const r = await query(
      // Явный ::text — без него Postgres не может согласовать тип $1 между
      // "status=$1" (енум wms.print_job_status) и "$1='printed'" в CASE
      // (сравнение со строкой) и падает с "inconsistent types deduced for
      // parameter $1". Именно из-за этого агент не мог сохранить статус
      // 'processing'/'printed' — печать до самой отправки на принтер даже
      // не доходила.
      `UPDATE wms.print_jobs
       SET status=$1::wms.print_job_status, error_text=$2,
           printed_at=CASE WHEN $1::text='printed' THEN NOW() ELSE NULL END,
           attempt_count=attempt_count+1, last_attempt_at=NOW(), updated_at=NOW()
       WHERE id=$3 AND tenant_id=$4 AND printer_id=$5
       RETURNING id, status, printed_at`,
      [status, error_text||null, id, req.agentPrinter.tenantId, req.agentPrinter.id]
    );
    if (r.rowCount===0) throw new NotFoundError('PrintJob', id);
    res.json({ ok:true, job:r.rows[0] });
  } catch(e){ next(e); }
});

module.exports = router;
