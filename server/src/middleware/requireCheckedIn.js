'use strict';

const { query } = require('../config/database');
const { ForbiddenError } = require('../utils/errors');

// =============================================================================
// Требует, чтобы складской сотрудник был "отмечен на складе" (см. миграцию 023
// и server/src/modules/checkin/checkin.router.js). Действует ТОЛЬКО на роли
// из FLOOR_ROLES — tenant_admin и supervisor всегда проходят без проверки
// (в том числе если у сотрудника supervisor/admin есть ДОПОЛНИТЕЛЬНО ещё и
// складская роль через wms.user_roles — наличие admin/supervisor в наборе
// ролей полностью освобождает от чек-ина).
//
// Подключается в router.use(...) сразу после tenantMiddleware, теми же
// роутерами, что чек-ин и должен защищать: picking/packing/receiving/
// shipping/movement/placement/inventory. Не влияет на seller/analyst — они
// физически не ходят в эти роутеры.
// =============================================================================

const FLOOR_ROLES = ['receiver', 'picker', 'packer', 'shipper', 'inventory_manager'];
const CHECKIN_VALID_HOURS = 12; // "смена" — после этого нужно отметиться заново

async function requireCheckedIn(req, res, next) {
  try {
    const userRoles = (req.user.roles && req.user.roles.length) ? req.user.roles : [req.user.role];

    if (userRoles.includes('tenant_admin') || userRoles.includes('supervisor')) return next();
    if (!userRoles.some(r => FLOOR_ROLES.includes(r))) return next();

    const { rows } = await query(
      `SELECT checked_in_at FROM wms.employee_checkins WHERE employee_id=$1 AND tenant_id=$2`,
      [req.user.id, req.user.tenantId]
    );
    const checkedInAt = rows[0]?.checked_in_at || null;
    const validUntil = checkedInAt
      ? new Date(new Date(checkedInAt).getTime() + CHECKIN_VALID_HOURS * 3600 * 1000)
      : null;

    if (!validUntil || validUntil < new Date()) {
      const err = new ForbiddenError('Отметьтесь на складе, чтобы продолжить работу');
      err.code = 'NOT_CHECKED_IN'; // ui распознаёт этот код и ведёт на экран скана (см. shared/api.js)
      return next(err);
    }

    next();
  } catch (e) { next(e); }
}

module.exports = { requireCheckedIn, FLOOR_ROLES, CHECKIN_VALID_HOURS };
