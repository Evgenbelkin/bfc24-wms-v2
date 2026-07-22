'use strict';

// =============================================================================
// Иерархия ошибок приложения
// Все ошибки должны быть экземплярами AppError или его наследников.
// Это позволяет errorHandler правильно формировать HTTP-ответ.
// =============================================================================

class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = null) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true; // operational = ожидаемая ошибка, а не баг
    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

class AuthError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'AUTH_REQUIRED');
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Access forbidden', details = null) {
    super(message, 403, 'FORBIDDEN', details);
  }
}

class NotFoundError extends AppError {
  constructor(entity = 'Resource', id = null) {
    const msg = id ? `${entity} with id=${id} not found` : `${entity} not found`;
    super(msg, 404, 'NOT_FOUND');
    this.entity = entity;
    this.entityId = id;
  }
}

class ConflictError extends AppError {
  constructor(message, details = null) {
    super(message, 409, 'CONFLICT', details);
  }
}

class InsufficientStockError extends AppError {
  constructor(available, required, itemId = null, locationId = null) {
    super(
      `Insufficient stock: available=${available}, required=${required}`,
      409,
      'INSUFFICIENT_STOCK',
      { available, required, itemId, locationId }
    );
  }
}

class TenantSuspendedError extends AppError {
  constructor() {
    super('Tenant account is suspended', 403, 'TENANT_SUSPENDED');
  }
}

class ModuleDisabledError extends AppError {
  constructor(moduleCode) {
    super(`Module '${moduleCode}' is not enabled for this tenant`, 403, 'MODULE_DISABLED');
    this.moduleCode = moduleCode;
  }
}

class PlanLimitError extends AppError {
  constructor(limitType, current, max) {
    super(
      `Plan limit exceeded: ${limitType} (current=${current}, max=${max})`,
      402,
      'PLAN_LIMIT_EXCEEDED',
      { limitType, current, max }
    );
  }
}

/**
 * Конвертировать PostgreSQL ошибки в AppError
 */
function fromDbError(err) {
  if (err instanceof AppError) return err;

  // Unique constraint violation
  if (err.code === '23505') {
    return new ConflictError(
      err.detail || 'Duplicate entry',
      { constraint: err.constraint }
    );
  }

  // Foreign key violation
  if (err.code === '23503') {
    return new ValidationError(
      `Referenced record not found: ${err.detail || err.constraint}`,
    );
  }

  // Not null violation
  if (err.code === '23502') {
    return new ValidationError(`Field '${err.column}' cannot be null`);
  }

  // Check constraint violation
  if (err.code === '23514') {
    return new ValidationError(`Value violates constraint: ${err.constraint}`);
  }

  // Application-level errors (RAISE EXCEPTION in PL/pgSQL)
  if (err.code === 'P0001') { // Insufficient stock
    return new InsufficientStockError(0, 0);
  }
  if (err.code === 'P0002') { // Insufficient available stock
    return new InsufficientStockError(0, 0);
  }

  return err;
}

module.exports = {
  AppError,
  ValidationError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  InsufficientStockError,
  TenantSuspendedError,
  ModuleDisabledError,
  PlanLimitError,
  fromDbError,
};
