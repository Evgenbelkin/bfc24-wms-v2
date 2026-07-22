'use strict';

const express = require('express');
const router = express.Router();
const usersService = require('./users.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { validatePositiveInt } = require('../../utils/validators');

// Все роуты требуют auth + tenant
router.use(authRequired, tenantMiddleware);

/** GET /users — список пользователей */
router.get('/', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const { role, is_active, search } = req.query;
    const users = await usersService.listUsers({
      tenantId: req.user.tenantId,
      role:     role || null,
      isActive: is_active !== undefined ? is_active === 'true' : null,
      search:   search || null,
    });
    res.json({ ok: true, users });
  } catch (err) { next(err); }
});

/** GET /users/:id */
router.get('/:id', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const userId = validatePositiveInt(req.params.id, 'id');
    const user = await usersService.getUserById({ tenantId: req.user.tenantId, userId });
    res.json({ ok: true, user });
  } catch (err) { next(err); }
});

/** POST /users — создать пользователя */
router.post('/', requireRole('tenant_admin'), async (req, res, next) => {
  try {
    const user = await usersService.createUser({
      tenantId:    req.user.tenantId,
      createdById: req.user.id,
      data:        req.body,
    });
    res.status(201).json({ ok: true, user });
  } catch (err) { next(err); }
});

/** PATCH /users/:id — обновить пользователя */
router.patch('/:id', requireRole('tenant_admin'), async (req, res, next) => {
  try {
    const userId = validatePositiveInt(req.params.id, 'id');
    const user = await usersService.updateUser({
      tenantId:    req.user.tenantId,
      userId,
      data:        req.body,
      updatedById: req.user.id,
    });
    res.json({ ok: true, user });
  } catch (err) { next(err); }
});

/** DELETE /users/:id — деактивировать */
router.delete('/:id', requireRole('tenant_admin'), async (req, res, next) => {
  try {
    const userId = validatePositiveInt(req.params.id, 'id');
    const user = await usersService.deactivateUser({
      tenantId:    req.user.tenantId,
      userId,
      requesterId: req.user.id,
    });
    res.json({ ok: true, user });
  } catch (err) { next(err); }
});

module.exports = router;
