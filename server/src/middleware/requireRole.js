'use strict';

const { ForbiddenError } = require('../utils/errors');

// =============================================================================
// Проверка роли пользователя
// =============================================================================

// Иерархия ролей: tenant_admin имеет все права
const ROLE_HIERARCHY = [
  'tenant_admin',
  'supervisor',
  'receiver',
  'picker',
  'packer',
  'shipper',
  'inventory_manager',
  'analyst',
  'seller',
];

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

    const { role } = req.user;

    if (!effectiveRoles.includes(role)) {
      return next(
        new ForbiddenError(
          `Role '${role}' is not allowed. Required: ${roles.join(' | ')}`,
          { required: roles, actual: role }
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
  if (req.user?.role === 'seller') {
    return next(new ForbiddenError('Sellers cannot perform warehouse operations'));
  }
  next();
}

/**
 * Проверить что пользователь — seller
 */
function requireSellerRole(req, res, next) {
  if (req.user?.role !== 'seller') {
    return next(new ForbiddenError('This endpoint is for sellers only'));
  }
  next();
}

module.exports = { requireRole, requireWarehouseRole, requireSellerRole };
