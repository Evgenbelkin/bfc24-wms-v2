'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');
const { AuthError, ForbiddenError } = require('../utils/errors');

// =============================================================================
// JWT аутентификация и tenant isolation middleware
// =============================================================================

/**
 * Декодировать Bearer token из Authorization header
 */
function extractBearerToken(req) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim() || null;
}

/**
 * Middleware: обязательная аутентификация для tenant users
 * Кладёт в req.user:
 *   { id, tenantId, clientId, role, username }
 */
function authRequired(req, res, next) {
  try {
    const token = extractBearerToken(req);
    if (!token) throw new AuthError('Bearer token required');

    let decoded;
    try {
      decoded = jwt.verify(token, config.jwt.secret);
    } catch (jwtErr) {
      if (jwtErr.name === 'TokenExpiredError') {
        throw new AuthError('Token expired');
      }
      throw new AuthError('Invalid token');
    }

    // Валидация payload
    const userId = Number(decoded.id);
    const tenantId = Number(decoded.tenantId);

    if (!Number.isInteger(userId) || userId <= 0) {
      throw new AuthError('Invalid token payload: id');
    }
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
      throw new AuthError('Invalid token payload: tenantId');
    }
    if (!decoded.role) {
      throw new AuthError('Invalid token payload: role');
    }

    req.user = {
      id:       userId,
      tenantId: tenantId,
      clientId: decoded.clientId ? Number(decoded.clientId) : null,
      role:     decoded.role,
      username: decoded.username || null,
    };

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Middleware: аутентификация для Platform Owner (SaaS-уровень)
 */
function platformAuthRequired(req, res, next) {
  try {
    const token = extractBearerToken(req);
    if (!token) throw new AuthError('Bearer token required');

    let decoded;
    try {
      decoded = jwt.verify(token, config.platformJwt.secret);
    } catch (jwtErr) {
      if (jwtErr.name === 'TokenExpiredError') {
        throw new AuthError('Platform token expired');
      }
      throw new AuthError('Invalid platform token');
    }

    if (decoded.role !== 'platform_owner') {
      throw new ForbiddenError('Platform owner access required');
    }

    req.platformUser = {
      id:       Number(decoded.id),
      username: decoded.username,
      role:     'platform_owner',
    };

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Опциональная аутентификация (не падает если токена нет)
 */
function authOptional(req, res, next) {
  try {
    const token = extractBearerToken(req);
    if (!token) return next();

    const decoded = jwt.verify(token, config.jwt.secret);
    req.user = {
      id:       Number(decoded.id),
      tenantId: Number(decoded.tenantId),
      clientId: decoded.clientId ? Number(decoded.clientId) : null,
      role:     decoded.role,
      username: decoded.username || null,
    };
  } catch (_) {
    // Молча игнорируем — пользователь просто не авторизован
  }
  next();
}

/**
 * Подписать JWT для tenant user
 */
function signUserToken(user) {
  return jwt.sign(
    {
      id:       user.id,
      tenantId: user.tenantId,
      clientId: user.clientId || null,
      role:     user.role,
      username: user.username,
    },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
}

/**
 * Подписать refresh token
 */
function signRefreshToken(userId, tenantId) {
  return jwt.sign(
    { id: userId, tenantId, type: 'refresh' },
    config.jwt.refreshSecret,
    { expiresIn: config.jwt.refreshExpiresIn }
  );
}

/**
 * Подписать platform JWT
 */
function signPlatformToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: 'platform_owner' },
    config.platformJwt.secret,
    { expiresIn: config.platformJwt.expiresIn }
  );
}

module.exports = {
  authRequired,
  platformAuthRequired,
  authOptional,
  signUserToken,
  signRefreshToken,
  signPlatformToken,
  extractBearerToken,
};
