'use strict';

const { ValidationError } = require('./errors');

// =============================================================================
// Переиспользуемые валидаторы. Выбрасывают ValidationError при ошибке.
// =============================================================================

/**
 * Проверить что значение — положительное целое число
 */
function validatePositiveInt(value, fieldName) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError(`Field '${fieldName}' must be a positive integer, got: ${value}`);
  }
  return n;
}

/**
 * Проверить что строка — непустая
 */
function validateNonEmptyString(value, fieldName, maxLength = 1000) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`Field '${fieldName}' must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ValidationError(`Field '${fieldName}' must not exceed ${maxLength} characters`);
  }
  return trimmed;
}

/**
 * Проверить что значение — дата в формате YYYY-MM-DD
 */
function validateDateOnly(value, fieldName) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
    throw new ValidationError(`Field '${fieldName}' must be in YYYY-MM-DD format, got: ${value}`);
  }
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    throw new ValidationError(`Field '${fieldName}' is not a valid date: ${value}`);
  }
  return value;
}

/**
 * Проверить что date_from <= date_to
 */
function validateDateRange(dateFrom, dateTo) {
  if (dateFrom > dateTo) {
    throw new ValidationError('date_from cannot be greater than date_to');
  }
}

/**
 * Нормализовать и проверить barcode
 */
function validateBarcode(value, fieldName = 'barcode') {
  const s = String(value || '').trim();
  if (!s) {
    throw new ValidationError(`Field '${fieldName}' is required and cannot be empty`);
  }
  if (s.length > 200) {
    throw new ValidationError(`Field '${fieldName}' is too long (max 200 chars)`);
  }
  return s;
}

/**
 * Проверить email
 */
function validateEmail(value, fieldName = 'email') {
  if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
    throw new ValidationError(`Field '${fieldName}' must be a valid email address`);
  }
  return value.trim().toLowerCase();
}

/**
 * Проверить пароль (min length)
 */
function validatePassword(value, minLength = 8) {
  if (typeof value !== 'string' || value.length < minLength) {
    throw new ValidationError(`Password must be at least ${minLength} characters`);
  }
  return value;
}

/**
 * Нормализовать boolean
 */
function parseBool(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', '1', 'yes'].includes(v)) return true;
    if (['false', '0', 'no'].includes(v)) return false;
  }
  return Boolean(value);
}

/**
 * Проверить и нормализовать qty (целое, >= 1 по умолчанию)
 */
function validateQty(value, fieldName = 'qty', min = 1) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) {
    throw new ValidationError(`Field '${fieldName}' must be an integer >= ${min}, got: ${value}`);
  }
  return n;
}

/**
 * Проверить nullable int (может быть null/undefined)
 */
function parseNullableInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Проверить что значение входит в допустимый набор
 */
function validateEnum(value, allowedValues, fieldName) {
  const s = String(value || '').trim().toLowerCase();
  if (!allowedValues.includes(s)) {
    throw new ValidationError(
      `Field '${fieldName}' must be one of: ${allowedValues.join(', ')}, got: ${value}`
    );
  }
  return s;
}

module.exports = {
  validatePositiveInt,
  validateNonEmptyString,
  validateDateOnly,
  validateDateRange,
  validateBarcode,
  validateEmail,
  validatePassword,
  parseBool,
  validateQty,
  parseNullableInt,
  validateEnum,
};
