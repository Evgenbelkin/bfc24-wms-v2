'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../../config/database');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { ValidationError } = require('../../utils/errors');
const { generateCheckinBarcodeSvg } = require('../../utils/qrcode');
const { signCheckinToken, verifyCheckinToken, CHECKIN_TOKEN_TTL_MS } = require('../../utils/checkinToken');
const { CHECKIN_VALID_HOURS } = require('../../middleware/requireCheckedIn');

// =============================================================================
// Checkin Router — отметка складских сотрудников по QR
//
// GET  /checkin/token   — (supervisor/admin) свежий QR для экрана на входе,
//                         перевыпускается по запросу, ничего не хранит в БД.
// POST /checkin/scan    — (любой сотрудник) сканирует токен с экрана телефоном.
// GET  /checkin/status  — (любой сотрудник) текущий статус отметки — нужен
//                         экрану "Отметка на складе", чтобы показать "вы уже
//                         отмечены до HH:MM" вместо камеры, если это не нужно.
// =============================================================================

router.use(authRequired, tenantMiddleware);

router.get('/token', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const token = signCheckinToken();
    // Раньше был QR — часть складов работает с 1D-лазерными сканерами
    // (только линейные штрихкоды, не читают QR/DataMatrix), поэтому код
    // отметки теперь Code128 - его читает любой сканер: и 1D, и 2D/ТСД, и
    // камера. См. generateCheckinBarcodeSvg в utils/qrcode.js.
    const qrSvg = generateCheckinBarcodeSvg(token, { width: 480, height: 140 });
    res.json({
      ok: true,
      token,
      qr_svg: qrSvg,
      ttl_ms: CHECKIN_TOKEN_TTL_MS,
      expires_at: new Date(Date.now() + CHECKIN_TOKEN_TTL_MS).toISOString(),
    });
  } catch (e) { next(e); }
});

router.post('/scan', async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) throw new ValidationError('token is required');
    if (!verifyCheckinToken(token)) {
      throw new ValidationError('QR-код истёк или недействителен — обновите экран и отсканируйте заново');
    }

    await query(
      `INSERT INTO wms.employee_checkins (employee_id, tenant_id, checked_in_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (employee_id) DO UPDATE SET checked_in_at = NOW()`,
      [req.user.id, req.user.tenantId]
    );

    const validUntil = new Date(Date.now() + CHECKIN_VALID_HOURS * 3600 * 1000);
    res.json({ ok: true, checked_in_at: new Date().toISOString(), valid_until: validUntil.toISOString() });
  } catch (e) { next(e); }
});

router.get('/status', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT checked_in_at FROM wms.employee_checkins WHERE employee_id=$1 AND tenant_id=$2`,
      [req.user.id, req.user.tenantId]
    );
    const checkedInAt = rows[0]?.checked_in_at || null;
    const validUntil = checkedInAt
      ? new Date(new Date(checkedInAt).getTime() + CHECKIN_VALID_HOURS * 3600 * 1000)
      : null;
    const checkedIn = !!(validUntil && validUntil > new Date());

    res.json({
      ok: true,
      checked_in: checkedIn,
      checked_in_at: checkedInAt,
      valid_until: validUntil ? validUntil.toISOString() : null,
    });
  } catch (e) { next(e); }
});

module.exports = router;
