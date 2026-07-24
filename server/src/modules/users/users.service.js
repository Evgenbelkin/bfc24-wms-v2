'use strict';

const { query, transaction } = require('../../config/database');
const { hashPassword } = require('../auth/auth.service');
const {
  NotFoundError,
  ConflictError,
  ForbiddenError,
  ValidationError,
} = require('../../utils/errors');
const {
  validateNonEmptyString,
  validatePositiveInt,
  validateEnum,
  parseBool,
} = require('../../utils/validators');

// =============================================================================
// Users Service
// =============================================================================

const VALID_ROLES = [
  'tenant_admin', 'supervisor', 'receiver', 'picker',
  'packer', 'shipper', 'inventory_manager', 'analyst', 'seller',
];

/**
 * Доп. роли поверх основной (wms.users.role) — сотрудник может работать
 * сразу в нескольких модулях (например Сборка + Упаковка) и переключаться
 * туда, где сейчас есть работа, без участия админа каждый раз.
 */
async function getExtraRoles({ tenantId, userId }) {
  const res = await query(
    `SELECT role FROM wms.user_roles WHERE tenant_id=$1 AND user_id=$2 ORDER BY role`,
    [tenantId, userId]
  );
  return res.rows.map(r => r.role);
}

/** Полностью заменить набор доп. ролей пользователя (delete+insert в транзакции) */
async function setExtraRoles({ tenantId, userId, roles, actorId }) {
  const clean = [...new Set((roles || []).map(r => validateEnum(r, VALID_ROLES, 'extra_roles[]')))];
  await transaction(async (client) => {
    await client.query(`DELETE FROM wms.user_roles WHERE tenant_id=$1 AND user_id=$2`, [tenantId, userId]);
    for (const role of clean) {
      await client.query(
        `INSERT INTO wms.user_roles (tenant_id, user_id, role, created_by) VALUES ($1,$2,$3,$4)`,
        [tenantId, userId, role, actorId || null]
      );
    }
  });
  return clean;
}

/**
 * Список пользователей tenant'а
 */
async function listUsers({ tenantId, role = null, isActive = null, search = null }) {
  const params = [tenantId];
  const conditions = ['u.tenant_id = $1'];
  let idx = 2;

  if (role) {
    conditions.push(`u.role = $${idx++}`);
    params.push(role);
  }
  if (isActive !== null) {
    conditions.push(`u.is_active = $${idx++}`);
    params.push(isActive);
  }
  if (search) {
    conditions.push(`(u.username ILIKE $${idx} OR u.full_name ILIKE $${idx})`);
    params.push(`%${search}%`);
    idx++;
  }

  const res = await query(
    `SELECT
       u.id, u.username, u.full_name, u.role, u.is_active,
       u.last_login_at, u.created_at,
       c.client_name,
       COALESCE(
         (SELECT array_agg(ur.role ORDER BY ur.role) FROM wms.user_roles ur WHERE ur.user_id=u.id),
         ARRAY[]::wms.user_role[]
       ) AS extra_roles
     FROM wms.users u
     LEFT JOIN wms.clients c ON c.id = u.client_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY u.role, u.username`,
    params
  );

  return res.rows;
}

/**
 * Получить пользователя по ID
 */
async function getUserById({ tenantId, userId }) {
  const res = await query(
    `SELECT
       u.id, u.tenant_id, u.client_id, u.username, u.full_name, u.role,
       u.is_active, u.last_login_at, u.settings, u.created_at,
       c.client_name,
       COALESCE(
         (SELECT array_agg(ur.role ORDER BY ur.role) FROM wms.user_roles ur WHERE ur.user_id=u.id),
         ARRAY[]::wms.user_role[]
       ) AS extra_roles
     FROM wms.users u
     LEFT JOIN wms.clients c ON c.id = u.client_id
     WHERE u.id = $1 AND u.tenant_id = $2`,
    [userId, tenantId]
  );

  if (res.rowCount === 0) throw new NotFoundError('User', userId);
  return res.rows[0];
}

/**
 * Создать пользователя
 */
async function createUser({ tenantId, createdById, data }) {
  const username  = validateNonEmptyString(data.username, 'username', 100);
  const role      = validateEnum(data.role, VALID_ROLES, 'role');
  const password  = data.password;
  if (!password) throw new ValidationError('Password is required');

  const fullName  = data.full_name ? String(data.full_name).trim() : null;
  const isActive  = parseBool(data.is_active, true);
  const clientId  = data.client_id ? Number(data.client_id) : null;

  // Для роли seller — client_id обязателен
  if (role === 'seller' && !clientId) {
    throw new ValidationError('client_id is required for seller role');
  }

  // Проверяем уникальность username внутри tenant
  const exists = await query(
    `SELECT id FROM wms.users WHERE tenant_id = $1 AND username = $2`,
    [tenantId, username]
  );
  if (exists.rowCount > 0) {
    throw new ConflictError(`Username '${username}' already exists in this tenant`);
  }

  // Проверяем client_id принадлежит tenant'у
  if (clientId) {
    const clientCheck = await query(
      `SELECT id FROM wms.clients WHERE id = $1 AND tenant_id = $2`,
      [clientId, tenantId]
    );
    if (clientCheck.rowCount === 0) {
      throw new ValidationError(`Client ${clientId} not found in this tenant`);
    }
  }

  const passwordHash = await hashPassword(password);

  const res = await query(
    `INSERT INTO wms.users
       (tenant_id, client_id, username, password_hash, full_name, role, is_active, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, tenant_id, client_id, username, full_name, role, is_active, created_at`,
    [tenantId, clientId, username, passwordHash, fullName, role, isActive, createdById]
  );

  const user = res.rows[0];

  // Доп. роли (если переданы) — не блокируем создание пользователя, если тут что-то не так
  let extraRoles = [];
  if (Array.isArray(data.extra_roles) && data.extra_roles.length) {
    extraRoles = await setExtraRoles({
      tenantId, userId: user.id,
      roles: data.extra_roles.filter(r => r !== role), // основную роль не дублируем в доп.
      actorId: createdById,
    });
  }

  return { ...user, extra_roles: extraRoles };
}

/**
 * Обновить пользователя
 */
async function updateUser({ tenantId, userId, data, updatedById }) {
  // Проверяем существование
  const current = await getUserById({ tenantId, userId });

  const fields = [];
  const params = [];
  let idx = 1;

  if (data.full_name !== undefined) {
    fields.push(`full_name = $${idx++}`);
    params.push(data.full_name ? String(data.full_name).trim() : null);
  }

  if (data.role !== undefined) {
    const role = validateEnum(data.role, VALID_ROLES, 'role');
    fields.push(`role = $${idx++}`);
    params.push(role);
  }

  if (data.is_active !== undefined) {
    fields.push(`is_active = $${idx++}`);
    params.push(parseBool(data.is_active));
  }

  if (data.client_id !== undefined) {
    const clientId = data.client_id ? Number(data.client_id) : null;
    if (clientId) {
      const check = await query(
        `SELECT id FROM wms.clients WHERE id = $1 AND tenant_id = $2`,
        [clientId, tenantId]
      );
      if (check.rowCount === 0) throw new ValidationError(`Client ${clientId} not found`);
    }
    fields.push(`client_id = $${idx++}`);
    params.push(clientId);
  }

  if (data.password) {
    const hash = await hashPassword(data.password);
    fields.push(`password_hash = $${idx++}`);
    params.push(hash);

    // Отзываем все refresh tokens при смене пароля
    await query(
      `UPDATE wms.refresh_tokens SET revoked_at = NOW()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );
  }

  if (fields.length === 0 && data.extra_roles === undefined) {
    throw new ValidationError('No fields to update');
  }

  let updated = current;
  if (fields.length > 0) {
    fields.push(`updated_at = NOW()`);
    params.push(userId, tenantId);

    const res = await query(
      `UPDATE wms.users SET ${fields.join(', ')}
       WHERE id = $${idx++} AND tenant_id = $${idx}
       RETURNING id, username, full_name, role, is_active, client_id, updated_at`,
      params
    );
    updated = res.rows[0];
  }

  // Доп. роли — заменяем набор целиком, если поле явно передано
  let extraRoles = current.extra_roles || [];
  if (data.extra_roles !== undefined) {
    const primaryRole = updated.role || current.role;
    extraRoles = await setExtraRoles({
      tenantId, userId,
      roles: (data.extra_roles || []).filter(r => r !== primaryRole),
      actorId: updatedById,
    });
  }

  return { ...updated, extra_roles: extraRoles };
}

/**
 * Удалить (деактивировать) пользователя
 */
async function deactivateUser({ tenantId, userId, requesterId }) {
  if (userId === requesterId) {
    throw new ForbiddenError('Cannot deactivate yourself');
  }

  const res = await query(
    `UPDATE wms.users SET is_active = FALSE, updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2
     RETURNING id, username, is_active`,
    [userId, tenantId]
  );

  if (res.rowCount === 0) throw new NotFoundError('User', userId);

  // Отзываем токены
  await query(
    `UPDATE wms.refresh_tokens SET revoked_at = NOW()
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );

  return res.rows[0];
}

module.exports = {
  listUsers,
  getUserById,
  createUser,
  updateUser,
  deactivateUser,
};
