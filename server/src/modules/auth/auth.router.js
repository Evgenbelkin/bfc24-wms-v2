'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const authService = require('./auth.service');
const { authRequired } = require('../../middleware/auth');
const config = require('../../config');

// =============================================================================
// Auth Router
// POST /api/v2/auth/login
// POST /api/v2/auth/refresh
// POST /api/v2/auth/logout
// GET  /api/v2/auth/me
// POST /api/v2/auth/change-password
// POST /api/v2/auth/platform/login
// =============================================================================

// Rate limiter только для login endpoint
const loginLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max:      config.rateLimit.loginMax,
  message:  { ok: false, error: { code: 'RATE_LIMIT', message: 'Too many login attempts. Try again later.' } },
  standardHeaders: true,
  legacyHeaders:   false,
});

/**
 * POST /login
 * Вход пользователя tenant'а
 */
router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const result = await authService.loginUser({
      username,
      password,
      ip:        req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /refresh
 * Обновление access token по refresh token
 */
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body || {};
    const result = await authService.refreshAccessToken({
      refreshToken,
      ip: req.ip,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /logout
 * Выход — отзыв refresh token
 */
router.post('/logout', authRequired, async (req, res, next) => {
  try {
    const { refreshToken } = req.body || {};
    await authService.logoutUser({
      userId: req.user.id,
      refreshToken,
    });
    res.json({ ok: true, message: 'Logged out' });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /me
 * Получить текущего пользователя
 */
router.get('/me', authRequired, async (req, res, next) => {
  try {
    const userRes = await require('../../config/database').query(
      `SELECT
         u.id, u.tenant_id, u.client_id, u.username, u.full_name, u.role,
         u.is_active, u.last_login_at, u.settings,
         t.company_name, t.tenant_code, t.status AS tenant_status,
         t.timezone
       FROM wms.users u
       JOIN platform.tenants t ON t.id = u.tenant_id
       WHERE u.id = $1`,
      [req.user.id]
    );

    if (userRes.rowCount === 0) {
      return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
    }

    const u = userRes.rows[0];
    res.json({
      ok: true,
      user: {
        id:           u.id,
        tenantId:     u.tenant_id,
        clientId:     u.client_id,
        username:     u.username,
        fullName:     u.full_name,
        role:         u.role,
        isActive:     u.is_active,
        lastLoginAt:  u.last_login_at,
        settings:     u.settings,
        tenant: {
          id:          u.tenant_id,
          code:        u.tenant_code,
          name:        u.company_name,
          status:      u.tenant_status,
          timezone:    u.timezone,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /change-password
 */
router.post('/change-password', authRequired, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    await authService.changePassword({
      userId:          req.user.id,
      tenantId:        req.user.tenantId,
      currentPassword,
      newPassword,
    });
    res.json({ ok: true, message: 'Password changed successfully' });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /platform/login
 * Вход для Platform Owner
 */
router.post('/platform/login', loginLimiter, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const result = await authService.loginPlatformOwner({ username, password });
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
