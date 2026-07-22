'use strict';

const { query } = require('../../config/database');
const { validatePositiveInt } = require('../../utils/validators');

// =============================================================================
// Audit Service
//
// Работа с таблицей audit.action_log — журнал действий пользователей.
// Запись в audit происходит из других модулей вызовом logAction().
// Этот модуль предоставляет:
//   logAction        — записать действие в журнал
//   listActions      — список записей с фильтрами
//   getAction        — детальная запись
//   getUserActivity  — активность конкретного пользователя
//   getEntityHistory — история изменений конкретной сущности
//   getStats         — сводка активности по периоду
// =============================================================================

/**
 * Записать действие в audit log
 * Вызывается из других сервисов
 */
async function logAction({
  tenantId,
  userId,
  userRole,
  action,
  entityType = null,
  entityId   = null,
  beforeState = null,
  afterState  = null,
  ipAddress  = null,
  userAgent  = null,
  requestId  = null,
}) {
  try {
    await query(
      `INSERT INTO audit.action_log
         (tenant_id, user_id, user_role, action,
          entity_type, entity_id,
          before_state, after_state,
          ip_address, user_agent, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::inet,$10,$11)`,
      [
        tenantId, userId, userRole, action,
        entityType, entityId ? String(entityId) : null,
        beforeState ? JSON.stringify(beforeState) : null,
        afterState  ? JSON.stringify(afterState)  : null,
        ipAddress, userAgent, requestId,
      ]
    );
  } catch (_) {
    // Audit никогда не должен ломать основной поток
  }
}

/**
 * Список записей аудита
 */
async function listActions({
  tenantId,
  userId     = null,
  userRole   = null,
  action     = null,
  entityType = null,
  entityId   = null,
  dateFrom   = null,
  dateTo     = null,
  search     = null,
  limit  = 200,
  offset = 0,
}) {
  const params = [tenantId];
  const conds  = ['al.tenant_id=$1'];
  let idx = 2;

  if (userId)     { conds.push(`al.user_id=$${idx++}`);     params.push(userId); }
  if (userRole)   { conds.push(`al.user_role=$${idx++}`);   params.push(userRole); }
  if (action)     { conds.push(`al.action ILIKE $${idx++}`);params.push(`%${action}%`); }
  if (entityType) { conds.push(`al.entity_type=$${idx++}`); params.push(entityType); }
  if (entityId)   { conds.push(`al.entity_id=$${idx++}`);   params.push(String(entityId)); }
  if (dateFrom)   { conds.push(`al.created_at>=$${idx++}::date`); params.push(dateFrom); }
  if (dateTo)     { conds.push(`al.created_at<($${idx++}::date+interval '1 day')`); params.push(dateTo); }
  if (search) {
    conds.push(`(al.action ILIKE $${idx} OR al.entity_type ILIKE $${idx} OR al.entity_id ILIKE $${idx})`);
    params.push(`%${search}%`); idx++;
  }

  const total = (await query(
    `SELECT COUNT(*)::int AS n FROM audit.action_log al WHERE ${conds.join(' AND ')}`,
    params
  )).rows[0].n;

  params.push(Math.min(limit, 2000), Math.max(offset, 0));
  const r = await query(
    `SELECT
       al.id, al.action, al.entity_type, al.entity_id,
       al.user_role, al.ip_address, al.request_id,
       al.created_at,
       al.before_state, al.after_state,
       u.username, u.full_name
     FROM audit.action_log al
     LEFT JOIN wms.users u ON u.id=al.user_id
     WHERE ${conds.join(' AND ')}
     ORDER BY al.created_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params
  );
  return { actions: r.rows, total, limit, offset };
}

async function getAction({ tenantId, actionId }) {
  const r = await query(
    `SELECT al.*, u.username, u.full_name
     FROM audit.action_log al
     LEFT JOIN wms.users u ON u.id=al.user_id
     WHERE al.id=$1 AND al.tenant_id=$2`,
    [actionId, tenantId]
  );
  if (r.rowCount === 0) throw new Error(`Audit action ${actionId} not found`);
  return r.rows[0];
}

/**
 * Активность пользователя (последние действия)
 */
async function getUserActivity({ tenantId, userId, limit = 100 }) {
  const r = await query(
    `SELECT al.action, al.entity_type, al.entity_id, al.ip_address, al.created_at
     FROM audit.action_log al
     WHERE al.tenant_id=$1 AND al.user_id=$2
     ORDER BY al.created_at DESC
     LIMIT $3`,
    [tenantId, userId, Math.min(limit, 500)]
  );
  return r.rows;
}

/**
 * История изменений сущности (например, всё что делали с picking_task #123)
 */
async function getEntityHistory({ tenantId, entityType, entityId }) {
  const r = await query(
    `SELECT al.action, al.user_role, al.before_state, al.after_state,
            al.created_at, u.username
     FROM audit.action_log al
     LEFT JOIN wms.users u ON u.id=al.user_id
     WHERE al.tenant_id=$1 AND al.entity_type=$2 AND al.entity_id=$3
     ORDER BY al.created_at ASC`,
    [tenantId, entityType, String(entityId)]
  );
  return r.rows;
}

/**
 * Сводка активности по периоду
 */
async function getStats({ tenantId, dateFrom, dateTo }) {
  const r = await query(
    `SELECT
       al.action,
       COUNT(*)::int AS count,
       COUNT(DISTINCT al.user_id)::int AS unique_users,
       MAX(al.created_at) AS last_at
     FROM audit.action_log al
     WHERE al.tenant_id=$1
       AND ($2::date IS NULL OR al.created_at >= $2::date)
       AND ($3::date IS NULL OR al.created_at <  ($3::date + interval '1 day'))
     GROUP BY al.action
     ORDER BY count DESC
     LIMIT 100`,
    [tenantId, dateFrom || null, dateTo || null]
  );

  const byUser = await query(
    `SELECT
       u.username, u.full_name, al.user_role,
       COUNT(*)::int AS action_count,
       MAX(al.created_at) AS last_action_at
     FROM audit.action_log al
     LEFT JOIN wms.users u ON u.id=al.user_id
     WHERE al.tenant_id=$1
       AND ($2::date IS NULL OR al.created_at >= $2::date)
       AND ($3::date IS NULL OR al.created_at <  ($3::date + interval '1 day'))
     GROUP BY u.username, u.full_name, al.user_role
     ORDER BY action_count DESC
     LIMIT 50`,
    [tenantId, dateFrom || null, dateTo || null]
  );

  return {
    by_action: r.rows,
    by_user:   byUser.rows,
  };
}

module.exports = {
  logAction,
  listActions,
  getAction,
  getUserActivity,
  getEntityHistory,
  getStats,
};
