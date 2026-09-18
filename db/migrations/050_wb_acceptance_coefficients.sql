-- =============================================================================
-- BFC24 WMS v2 — Migration 050: коэффициенты приёмки ФБС по складам WB
-- =============================================================================
-- Другая сущность, чем platform.wb_warehouse_rates (049) — та хранит СТАТИЧНЫЕ
-- тарифы логистики/хранения (обновляются раз в сутки), а это ДИНАМИЧЕСКИЙ
-- коэффициент приёмки на ближайшие ~14 дней (0 = бесплатно, >0 = платно,
-- -1 = склад закрыт для приёмки на эту дату) - то, что видно в кабинете WB
-- при планировании поставки ("Коэффициент приёмки"). GET /api/v1/acceptance/
-- coefficients, хост supplies-api.wildberries.ru, категория токена "Поставки".
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS platform.wb_acceptance_coefficients (
  id                SERIAL PRIMARY KEY,
  warehouse_id      INT NOT NULL,
  warehouse_name    TEXT NOT NULL,
  box_type_id       INT NOT NULL DEFAULT -1,
  box_type_name     TEXT,
  coef_date         DATE NOT NULL,
  coefficient       NUMERIC(6,2),
  allow_unload      BOOLEAN,
  is_sorting_center BOOLEAN,
  raw_data          JSONB,
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (warehouse_id, box_type_id, coef_date)
);

CREATE INDEX IF NOT EXISTS idx_wb_acceptance_coef_date       ON platform.wb_acceptance_coefficients(coef_date);
CREATE INDEX IF NOT EXISTS idx_wb_acceptance_coef_warehouse  ON platform.wb_acceptance_coefficients(warehouse_id);

COMMIT;
