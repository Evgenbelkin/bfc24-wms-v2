'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { query, transaction } = require('../../config/database');
const { signUserToken, signRefreshToken, signPlatformToken } = require('../../middleware/auth');
const {
  AuthError,
  ValidationError,
  ForbiddenError,
  NotFoundError,
} = require('../../utils/errors');
const {
  validateNonEmptyString,
  validatePassword,
  validateEmail,
} = require('../../utils/validators');
const logger = require('../../utils/logger');
const config = require('../../config');

const BCRYPT_ROUNDS = 12;
const REFRESH_TOKEN_BYTES = 48;

// =============================================================================
// Auth Service
// =============================================================================

/**
 * Вход пользователя tenant'а
 * @returns { accessToken, refreshToken, user }
 */
async function loginUser({ username, password, ip, userAgent }) {
  validateNonEmptyString(username, 'username');
  if (!password) throw new ValidationError('Password is required');

  // Ищем пользователя
  const res = await query(
    `SELECT
       u.id, u.tenant_id, u.client_id, u.username, u.password_hash,
       u.role, u.is_active, u.full_name,
       t.status AS tenant_status, t.company_name,
       COALESCE(
         (SELECT jsonb_agg(ur.role) FROM wms.user_roles ur WHERE ur.user_id=u.id),
         '[]'::jsonb
       ) AS extra_roles
     FROM wms.users u
     JOIN platform.tenants t ON t.id = u.tenant_id
     WHERE u.username = $1
     LIMIT 1`,
    [username.trim()]
  );

  if (res.rowCount === 0) {
    // Намеренно одинаковое сообщение чтобы не давать информацию о том, существует ли пользователь
    throw new AuthError('Invalid username or password');
  }

  const user = res.rows[0];

  // Проверяем tenant
  if (user.tenant_status === 'blocked') {
    throw new ForbiddenError('Account blocked. Contact support.');
  }
  if (user.tenant_status === 'archived') {
    throw new ForbiddenError('Account archived.');
  }

  if (!user.is_active) {
    throw new ForbiddenError('User account is disabled');
  }

  // Проверяем пароль
  const passwordOk = await bcrypt.compare(password, user.password_hash);
  if (!passwordOk) {
    logger.warn({ username, ip }, 'Failed login attempt');
    throw new AuthError('Invalid username or password');
  }

  // Эффективный набор ролей = основная роль + доп. роли (wms.user_roles) —
  // сотрудник может работать сразу в нескольких модулях (например сборка +
  // упаковка) и сам переключаться туда, где сейчас есть работа.
  const roles = [...new Set([user.role, ...(user.extra_roles || [])])];

  // Генерируем токены
  const accessToken = signUserToken({
    id:       user.id,
    tenantId: user.tenant_id,
    clientId: user.client_id,
    role:     user.role,
    roles,
    username: user.username,
  });

  const rawRefreshToken = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
  const refreshTokenHash = await bcrypt.hash(rawRefreshToken, 10);

  // Считаем срок жизни refresh token
  const expiresAt = new Date();
  const days = parseInt(config.jwt.refreshExpiresIn, 10) || 30;
  expiresAt.setDate(expiresAt.getDate() + days);

  // Сохраняем refresh token
  await query(
    `INSERT INTO wms.refresh_tokens (user_id, tenant_id, token_hash, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [user.id, user.tenant_id, refreshTokenHash, expiresAt, userAgent || null, ip || null]
  );

  // Обновляем last_login_at
  await query(
    `UPDATE wms.users SET last_login_at = NOW() WHERE id = $1`,
    [user.id]
  );

  logger.info({ userId: user.id, tenantId: user.tenant_id, role: user.role }, 'User logged in');

  return {
    accessToken,
    refreshToken: rawRefreshToken,
    user: {
      id:          user.id,
      tenantId:    user.tenant_id,
      clientId:    user.client_id,
      username:    user.username,
      fullName:    user.full_name,
      role:        user.role,
      roles,
      companyName: user.company_name,
    },
  };
}

/**
 * Обновление access token через refresh token
 */
async function refreshAccessToken({ refreshToken, ip }) {
  if (!refreshToken) throw new AuthError('Refresh token required');

  // Ищем все активные refresh tokens и проверяем bcrypt
  // (нельзя хранить хеш в сессии — перебираем последние по пользователю)
  const tokenRes = await query(
    `SELECT rt.id, rt.user_id, rt.tenant_id, rt.token_hash, rt.expires_at, rt.revoked_at
     FROM wms.refresh_tokens rt
     WHERE rt.expires_at > NOW() AND rt.revoked_at IS NULL
     ORDER BY rt.created_at DESC
     LIMIT 100`
  );

  let foundToken = null;
  for (const row of tokenRes.rows) {
    const match = await bcrypt.compare(refreshToken, row.token_hash);
    if (match) {
      foundToken = row;
      break;
    }
  }

  if (!foundToken) {
    throw new AuthError('Invalid or expired refresh token');
  }

  // Получаем пользователя
  const userRes = await query(
    `SELECT u.id, u.tenant_id, u.client_id, u.username, u.role, u.is_active,
       COALESCE(
         (SELECT jsonb_agg(ur.role) FROM wms.user_roles ur WHERE ur.user_id=u.id),
         '[]'::jsonb
       ) AS extra_roles
     FROM wms.users u
     WHERE u.id = $1 AND u.is_active = TRUE`,
    [foundToken.user_id]
  );

  if (userRes.rowCount === 0) {
    throw new AuthError('User not found or inactive');
  }

  const user = userRes.rows[0];

  // Ротация refresh token: отзываем старый, создаём новый
  const newRawToken = crypto.randomBytes(REFRESH_TOKEN_BYTES).toString('hex');
  const newTokenHash = await bcrypt.hash(newRawToken, 10);

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  await transaction(async (client) => {
    // Отзываем старый
    await client.query(
      `UPDATE wms.refresh_tokens SET revoked_at = NOW() WHERE id = $1`,
      [foundToken.id]
    );
    // Создаём новый
    await client.query(
      `INSERT INTO wms.refresh_tokens (user_id, tenant_id, token_hash, expires_at, ip_address)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.id, user.tenant_id, newTokenHash, expiresAt, ip || null]
    );
  });

  const roles = [...new Set([user.role, ...(user.extra_roles || [])])];

  const accessToken = signUserToken({
    id:       user.id,
    tenantId: user.tenant_id,
    clientId: user.client_id,
    role:     user.role,
    roles,
    username: user.username,
  });

  return { accessToken, refreshToken: newRawToken };
}

/**
 * Выход (отзываем refresh token)
 */
async function logoutUser({ userId, refreshToken }) {
  if (!refreshToken) return; // Нечего отзывать

  const tokenRes = await query(
    `SELECT id, token_hash FROM wms.refresh_tokens
     WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
    [userId]
  );

  for (const row of tokenRes.rows) {
    const match = await bcrypt.compare(refreshToken, row.token_hash);
    if (match) {
      await query(
        `UPDATE wms.refresh_tokens SET revoked_at = NOW() WHERE id = $1`,
        [row.id]
      );
      break;
    }
  }
}

/**
 * Смена пароля
 */
async function changePassword({ userId, tenantId, currentPassword, newPassword }) {
  validatePassword(newPassword);

  const res = await query(
    `SELECT password_hash FROM wms.users WHERE id = $1 AND tenant_id = $2`,
    [userId, tenantId]
  );
  if (res.rowCount === 0) throw new NotFoundError('User', userId);

  const ok = await bcrypt.compare(currentPassword, res.rows[0].password_hash);
  if (!ok) throw new AuthError('Current password is incorrect');

  const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await query(
    `UPDATE wms.users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
    [hash, userId]
  );

  // Отзываем все refresh tokens
  await query(
    `UPDATE wms.refresh_tokens SET revoked_at = NOW()
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
}

/**
 * Вход для Platform Owner
 */
async function loginPlatformOwner({ username, password }) {
  validateNonEmptyString(username, 'username');
  if (!password) throw new ValidationError('Password is required');

  const res = await query(
    `SELECT id, username, password_hash, full_name, is_active
     FROM platform.users WHERE username = $1 LIMIT 1`,
    [username.trim()]
  );

  if (res.rowCount === 0) throw new AuthError('Invalid credentials');

  const user = res.rows[0];
  if (!user.is_active) throw new ForbiddenError('Account disabled');

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) throw new AuthError('Invalid credentials');

  await query(
    `UPDATE platform.users SET last_login_at = NOW() WHERE id = $1`,
    [user.id]
  );

  const token = signPlatformToken({ id: user.id, username: user.username });

  return {
    token,
    user: { id: user.id, username: user.username, fullName: user.full_name },
  };
}

/**
 * Хешировать пароль (для создания пользователей)
 */
async function hashPassword(password) {
  validatePassword(password);
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

module.exports = {
  loginUser,
  refreshAccessToken,
  logoutUser,
  changePassword,
  loginPlatformOwner,
  hashPassword,
};
