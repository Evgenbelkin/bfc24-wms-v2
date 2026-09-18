-- =============================================================================
-- Migration 014: доп. поля для управления подпиской клиента из платформенной
-- админки — единая дата "доступ действует до" (и для триала, и для оплаченного
-- периода — чтобы UI мог одной кнопкой "Продлить на 30 дней" двигать её вперёд),
-- и персональный лимит пользователей поверх тарифа (не трогая сам тариф).
-- =============================================================================

BEGIN;

ALTER TABLE platform.tenants ADD COLUMN IF NOT EXISTS access_expires_at TIMESTAMPTZ;
ALTER TABLE platform.tenants ADD COLUMN IF NOT EXISTS max_users_override INT;

-- Бэкофилл: у уже существующих тенантов на триале access_expires_at = ранее
-- заведённый trial_ends_at, чтобы не потерять уже посчитанный срок.
UPDATE platform.tenants
   SET access_expires_at = trial_ends_at
 WHERE access_expires_at IS NULL AND trial_ends_at IS NOT NULL;

COMMIT;
