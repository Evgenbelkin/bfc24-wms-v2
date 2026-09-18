-- =============================================================================
-- BFC24 WMS v2 — Migration 049: тарифы приёмки/логистики/хранения WB по складам
-- =============================================================================
-- Общеплатформенная фича, видна ТОЛЬКО владельцу платформы (Jeka), не тенантам:
-- - роуты живут в server/src/modules/platform/*, защищены platformAuthRequired
-- - таблицы в схеме platform, без tenant_id
-- - Тарифы WB одинаковые для любого продавца (не зависят от тенанта/клиента),
--   поэтому запрашиваются ОДНИМ токеном (личный кабинет владельца, не токены
--   клиентов), см. platform.settings ниже.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Общие настройки платформы (key/value) — на будущее пригодится не только
-- для WB-тарифов. Значение как есть, без шифрования (это внутренний токен
-- владельца платформы, а не клиентские секреты, доступ только через
-- platformAuthRequired).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform.settings (
  key         TEXT PRIMARY KEY,
  value       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  INT -- platform.users.id
);

-- ---------------------------------------------------------------------------
-- Тарифы приёмки/логистики/хранения WB по складам (GET /api/v1/tariffs/box).
-- Снимок на дату — WB присылает актуальные тарифы на сегодня (дата в
-- tariff_date), история копится сама по себе построчно за счёт UNIQUE(warehouse_name,tariff_date).
-- raw_data хранит сырой ответ WB целиком - на случай если понадобится поле,
-- которое мы не выделили в отдельную колонку.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform.wb_warehouse_rates (
  id                              SERIAL PRIMARY KEY,
  tariff_date                     DATE NOT NULL,
  warehouse_name                  TEXT NOT NULL,
  geo_name                        TEXT,
  box_delivery_base               NUMERIC(12,2),
  box_delivery_coef_expr          NUMERIC(12,2),
  box_delivery_liter              NUMERIC(12,2),
  box_delivery_marketplace_base   NUMERIC(12,2),
  box_delivery_marketplace_coef_expr NUMERIC(12,2),
  box_delivery_marketplace_liter  NUMERIC(12,2),
  box_storage_base                NUMERIC(12,2),
  box_storage_coef_expr           NUMERIC(12,2),
  box_storage_liter               NUMERIC(12,2),
  dt_next_box                     TIMESTAMPTZ,
  dt_till_max                     TIMESTAMPTZ,
  raw_data                        JSONB,
  fetched_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (warehouse_name, tariff_date)
);

CREATE INDEX IF NOT EXISTS idx_wb_warehouse_rates_date ON platform.wb_warehouse_rates(tariff_date DESC);

COMMIT;
