'use strict';

const { query } = require('../config/database');
const {
  AuthError,
  ForbiddenError,
  TenantSuspendedError,
  ModuleDisabledError,
  NotFoundError,
} = require('../utils/errors');
const logger = require('../utils/logger');

// =============================================================================
// Tenant isolation middleware
// Загружает tenant из БД, проверяет статус, добавляет req.tenant
// =============================================================================

// Кеш активных tenant'ов (сброс при изменениях — упрощённая версия)
const tenantCache = new Map(); // tenantId → { tenant, modules, expiresAt }
const CACHE_TTL_MS = 30_000; // 30 секунд

async function loadTenant(tenantId) {
  // Проверяем кеш
  const cached = tenantCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached;
  }

  // Загружаем tenant
  const tenantRes = await query(
    `SELECT
       t.id, t.tenant_code, t.company_name, t.status,
       t.timezone, t.settings, t.plan_id,
       p.max_users, p.max_clients, p.max_warehouses,
       p.max_skus, p.max_orders_per_month
     FROM platform.tenants t
     LEFT JOIN platform.plans p ON p.id = t.plan_id
     WHERE t.id = $1`,
    [tenantId]
  );

  if (tenantRes.rowCount === 0) {
    throw new NotFoundError('Tenant', tenantId);
  }

  const tenant = tenantRes.rows[0];

  // Загружаем включённые модули
  const modulesRes = await query(
    `SELECT module_code FROM platform.tenant_modules WHERE tenant_id = $1`,
    [tenantId]
  );

  // Добавляем core-модули (всегда включены)
  const coreRes = await query(
    `SELECT module_code FROM platform.modules WHERE is_core = TRUE`
  );

  const modules = new Set([
    ...coreRes.rows.map((r) => r.module_code),
    ...modulesRes.rows.map((r) => r.module_code),
  ]);

  const result = { tenant, modules, expiresAt: Date.now() + CACHE_TTL_MS };
  tenantCache.set(tenantId, result);
  return result;
}

/**
 * Сбросить кеш tenant'а (вызывать при изменении настроек)
 */
function invalidateTenantCache(tenantId) {
  tenantCache.delete(tenantId);
}

/**
 * Middleware: загрузить и проверить tenant
 * Требует req.user (после authRequired)
 * Добавляет req.tenant и req.tenantModules
 */
async function tenantMiddleware(req, res, next) {
  try {
    if (!req.user) throw new AuthError('User not authenticated');

    const tenantId = req.user.tenantId;
    const { tenant, modules } = await loadTenant(tenantId);

    // Проверяем статус tenant'а
    if (tenant.status === 'blocked') {
      throw new ForbiddenError('Tenant account is blocked. Contact support.');
    }
    if (tenant.status === 'archived') {
      throw new ForbiddenError('Tenant account is archived.');
    }
    if (tenant.status === 'suspended') {
      throw new TenantSuspendedError();
    }

    req.tenant = tenant;
    req.tenantModules = modules;

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Factory: проверить что у tenant включён модуль
 * Использование: router.use(requireModule('wb_integration'))
 */
function requireModule(moduleCode) {
  return (req, res, next) => {
    if (!req.tenantModules) {
      return next(new AuthError('Tenant context not loaded'));
    }
    if (!req.tenantModules.has(moduleCode)) {
      return next(new ModuleDisabledError(moduleCode));
    }
    next();
  };
}

/**
 * Проверить что tenantId в URL params совпадает с tenantId из JWT
 * Защита от IDOR атак
 */
function validateTenantParam(req, res, next) {
  if (!req.user) {
    return next(new AuthError('User not authenticated'));
  }
  const paramTenantId = Number(req.params.tenantId);
  if (paramTenantId && paramTenantId !== req.user.tenantId) {
    return next(new ForbiddenError('Access to this tenant is not allowed'));
  }
  next();
}

/**
 * Проверить что client_id принадлежит текущему tenant'у
 */
async function validateClientBelongsToTenant(clientId, tenantId) {
  const res = await query(
    'SELECT id FROM wms.clients WHERE id = $1 AND tenant_id = $2 AND is_active = TRUE',
    [clientId, tenantId]
  );
  if (res.rowCount === 0) {
    throw new ForbiddenError(`Client ${clientId} does not belong to this tenant or is inactive`);
  }
}

/**
 * Для роли seller: scope ограничен только своим client_id
 * Возвращает client_id: из JWT (для seller) или из query/body (для admin)
 */
function resolveClientScope(req, requestedClientId = null) {
  const { role, clientId: jwtClientId } = req.user;

  if (role === 'seller') {
    if (!jwtClientId) {
      throw new ForbiddenError('Seller account has no client_id assigned');
    }
    if (requestedClientId && Number(requestedClientId) !== jwtClientId) {
      throw new ForbiddenError('Sellers can only access their own client data');
    }
    return jwtClientId;
  }

  // Для non-seller ролей
  if (requestedClientId) {
    const n = Number(requestedClientId);
    if (!Number.isInteger(n) || n <= 0) {
      throw new ForbiddenError('Invalid client_id');
    }
    return n;
  }

  return null; // не ограничен по клиенту
}

module.exports = {
  tenantMiddleware,
  requireModule,
  validateTenantParam,
  validateClientBelongsToTenant,
  resolveClientScope,
  invalidateTenantCache,
};
