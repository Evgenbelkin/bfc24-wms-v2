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
  // Убираем ВЕСЬ whitespace, а не только края - штрихкод не может легитимно
  // содержать пробел/таб/перенос строки, а сканеры иногда добавляют лишний
  // пробел (настройки префикса/суффикса, гонка фокуса на странице и т.п.),
  // что раньше приводило к "не найден товар" при, казалось бы, верном штрихкоде.
  const s = String(value || '').replace(/\s+/g, '');
  if (!s) {
    throw new ValidationError(`Field '${fieldName}' is required and cannot be empty`);
  }
  if (s.length > 200) {
    throw new ValidationError(`Field '${fieldName}' is too long (max 200 chars)`);
  }
  return s;
}

/**
 * Похоже ли значение на реальный код маркировки "Честный знак" (КИЗ), а не
 * на обычный товарный штрихкод, случайно отсканированный в то же поле.
 *
 * КИЗ — это GS1 DataMatrix: минимум AI(01)+GTIN(14 цифр)+AI(21)+серийный
 * номер (обычно ещё символов 13-20), а в норме ещё AI(91) и AI(92) с
 * криптохвостом — итоговая длина у реального кода почти всегда 40+, часто
 * 80-100+ символов. Обычный штрихкод товара (EAN-13/EAN-8/внутренний код
 * ВБ) — почти всегда чисто цифровой и не длиннее 14 символов. Порог в 25
 * символов взят с большим запасом ниже любого реального КИЗ и выше любого
 * обычного штрихкода — так что отличить их можно без разбора точного
 * GS1-формата (сканеры по-разному передают разделители групп \x1D, само
 * поле "91/92" иногда обрезано настройками сканера).
 */
function isValidKizCode(value) {
  const s = String(value || '').trim();
  if (s.length < 25) return false;
  return true;
}

/**
 * То же самое, но бросает ValidationError вместо true/false — для мест,
 * где код обязан быть валидным КИЗ (иначе запрос вообще не должен пройти).
 */
function validateKizCode(value, fieldName = 'code') {
  const s = String(value || '').trim();
  if (!isValidKizCode(s)) {
    throw new ValidationError(
      `Field '${fieldName}' does not look like a valid "Честный знак" marking code (too short — looks like a product barcode was scanned instead)`
    );
  }
  return s;
}

/**
 * Достать GTIN (14 цифр) из начала кода "Честный знак".
 *
 * GS1 DataMatrix всегда начинается с идентификатора применения (01) —
 * "дальше идёт GTIN", сразу за которым 14 цифр самого GTIN. Дальше в коде
 * идут другие поля (серийный номер, крипто-хвост) — их не трогаем, они нам
 * не нужны. Некоторые сканеры в режиме "идентификатор символики" добавляют
 * технический префикс перед данными (например "]d2") — на всякий случай
 * срезаем его, если есть.
 *
 * Возвращает null, если код не начинается с ожидаемой структуры (значит
 * это не настоящий/распознаваемый КИЗ, или сканер передал что-то нестандартное)
 * — вызывающий код должен в этом случае откатываться на ручной ввод штрихкода,
 * а не падать с ошибкой.
 */
function extractGtinFromKizCode(value) {
  let s = String(value || '').trim();
  // Технический префикс символики (не данные, чисто метаинформация сканера)
  if (/^\]d2/i.test(s)) s = s.slice(3);
  if (!s.startsWith('01')) return null;
  const gtin = s.slice(2, 16);
  if (gtin.length !== 14 || !/^\d{14}$/.test(gtin)) return null;
  return gtin;
}

/**
 * GTIN-14 → кандидаты обычного штрихкода товара для поиска в справочнике.
 * GTIN — это, как правило, EAN-13 с одним нулём спереди (упаковка/размер
 * товара). Возвращаем и сам GTIN как есть (на случай, если в справочнике
 * барcode уже хранится в 14-значном виде), и вариант с обрезанным ведущим
 * нулём (обычный EAN-13) — пробуем оба, штрихкоды в базе не гарантированно
 * чистый EAN (ручной ввод, Ozon и т.п.), так что берём оба разумных варианта.
 */
function gtinToBarcodeCandidates(gtin) {
  const candidates = [gtin];
  if (gtin.startsWith('0')) candidates.push(gtin.slice(1));
  return candidates;
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
  isValidKizCode,
  validateKizCode,
  extractGtinFromKizCode,
  gtinToBarcodeCandidates,
  validateEmail,
  validatePassword,
  parseBool,
  validateQty,
  parseNullableInt,
  validateEnum,
};
