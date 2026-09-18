'use strict';

const { ForbiddenError } = require('../utils/errors');

// =============================================================================
// Проверка роли пользователя
// =============================================================================

// NB: единственное встроенное правило иерархии — tenant_admin имеет доступ ко всему.
// Остальные роли НЕ наследуют права друг друга (например supervisor не получает
// доступ к тому, что разрешено только 'picker', если явно не перечислен) — это
// плоский список ролей, а не настоящая иерархия.

/**
 * Factory middleware: требует одну из указанных ролей
 *
 * Использование:
 *   router.post('/something', requireRole('tenant_admin', 'supervisor'), handler)
 *   router.get('/other', requireRole(['receiver', 'supervisor']), handler)
 */
function requireRole(...rolesInput) {
  // Нормализуем: принимаем массив или varargs
  const roles = rolesInput.flat().filter(Boolean);

  if (roles.length === 0) {
    throw new Error('requireRole: at least one role must be specified');
  }

  // tenant_admin всегда имеет доступ
  const effectiveRoles = roles.includes('tenant_admin')
    ? roles
    : [...roles, 'tenant_admin'];

  return (req, res, next) => {
    if (!req.user) {
      return next(new ForbiddenError('Authentication required'));
    }

    // Мульти-роли: у пользователя может быть основная роль + доп. роли поверх
    // неё (wms.user_roles) — сотрудник видит/может открывать сразу несколько
    // рабочих модулей. Пропускаем, если пересекается хотя бы одна роль.
    const userRoles = req.user.roles && req.user.roles.length ? req.user.roles : [req.user.role];

    if (!effectiveRoles.some(r => userRoles.includes(r))) {
      return next(
        new ForbiddenError(
          `Role(s) '${userRoles.join(',')}' not allowed. Required: ${roles.join(' | ')}`,
          { required: roles, actual: userRoles }
        )
      );
    }

    next();
  };
}

/**
 * Проверить что пользователь — не seller (для WMS-операций)
 */
function requireWarehouseRole(req, res, next) {
  const userRoles = req.user?.roles && req.user.roles.length ? req.user.roles : [req.user?.role];
  if (userRoles.includes('seller')) {
    return next(new ForbiddenError('Sellers cannot perform warehouse operations'));
  }
  next();
}

/**
 * Проверить что пользователь — seller
 */
function requireSellerRole(req, res, next) {
  const userRoles = req.user?.roles && req.user.roles.length ? req.user.roles : [req.user?.role];
  if (!userRoles.includes('seller')) {
    return next(new ForbiddenError('This endpoint is for sellers only'));
  }
  next();
}

module.exports = { requireRole, requireWarehouseRole, requireSellerRole };
