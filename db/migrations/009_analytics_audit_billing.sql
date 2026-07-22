-- =============================================================================
-- BFC24 WMS v2 — Migration 009: Analytics, Audit, Billing
-- =============================================================================
BEGIN;

-- ===========================================================================
-- AUDIT LOG (ключевые действия пользователей)
-- ===========================================================================
CREATE TABLE audit.action_log (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       INT         REFERENCES platform.tenants(id),
  user_id         INT         REFERENCES wms.users(id),
  user_role       TEXT,
  action          TEXT        NOT NULL,  -- 'receiving.accept', 'picking.confirm', etc.
  entity_type     TEXT,                  -- 'shipment', 'picking_task', etc.
  entity_id       TEXT,                  -- строковый ID
  before_state    JSONB,                 -- состояние до
  after_state     JSONB,                 -- состояние после
  ip_address      INET,
  user_agent      TEXT,
  request_id      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_tenant   ON audit.action_log(tenant_id, created_at DESC);
CREATE INDEX idx_audit_user     ON audit.action_log(user_id, created_at DESC);
CREATE INDEX idx_audit_action   ON audit.action_log(action, created_at DESC);
CREATE INDEX idx_audit_entity   ON audit.action_log(entity_type, entity_id) WHERE entity_type IS NOT NULL;

-- ===========================================================================
-- WB ANALYTICS (нормализованные данные для аналитики)
-- ===========================================================================

-- Сырые продажи WB
CREATE TABLE analytics.wb_sales_raw (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           INT     NOT NULL REFERENCES platform.tenants(id),
  mp_account_id       INT     NOT NULL REFERENCES wms.mp_accounts(id),
  report_type         TEXT    NOT NULL DEFAULT 'sales',
  source_order_id     TEXT,
  source_sale_id      TEXT,
  source_nm_id        BIGINT,
  source_chrt_id      BIGINT,
  barcode             TEXT,
  article             TEXT,
  subject             TEXT,
  brand               TEXT,
  warehouse_name      TEXT,
  region_name         TEXT,
  country_name        TEXT,
  status_raw          TEXT,
  event_datetime      TIMESTAMPTZ,
  sale_datetime       TIMESTAMPTZ,
  price_raw           NUMERIC(14,2),
  final_price_raw     NUMERIC(14,2),
  for_pay_raw         NUMERIC(14,2),
  finished_price_raw  NUMERIC(14,2),
  raw                 JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wb_sales_raw_tenant  ON analytics.wb_sales_raw(tenant_id, created_at);
CREATE INDEX idx_wb_sales_raw_account ON analytics.wb_sales_raw(mp_account_id);

-- Сырые заказы WB (из Statistics API)
CREATE TABLE analytics.wb_orders_raw (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       INT     NOT NULL REFERENCES platform.tenants(id),
  mp_account_id   INT     NOT NULL REFERENCES wms.mp_accounts(id),
  source_order_id TEXT,
  source_rid      TEXT,
  source_nm_id    BIGINT,
  source_chrt_id  BIGINT,
  article         TEXT,
  barcode         TEXT,
  warehouse_name  TEXT,
  region_name     TEXT,
  status_raw      TEXT,
  event_datetime  TIMESTAMPTZ,
  order_datetime  TIMESTAMPTZ,
  price_raw       NUMERIC(14,2),
  converted_price_raw NUMERIC(14,2),
  final_price_raw NUMERIC(14,2),
  raw             JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_wb_orders_raw_tenant  ON analytics.wb_orders_raw(tenant_id, created_at);
CREATE INDEX idx_wb_orders_raw_account ON analytics.wb_orders_raw(mp_account_id);

-- ===========================================================================
-- BILLING FOUNDATION
-- ===========================================================================
CREATE TYPE billing.service_type AS ENUM (
  'receiving',      -- приёмка (за единицу)
  'storage',        -- хранение (за ед/день)
  'placement',      -- размещение (за единицу)
  'picking',        -- сборка (за единицу)
  'packing',        -- упаковка (за единицу)
  'shipping',       -- отгрузка (за единицу)
  'processing',     -- обработка (за единицу, кастомная)
  'returns',        -- возврат
  'subscription'    -- подписка (периодический платёж)
);

-- Прайс-лист услуг для каждого клиента
CREATE TABLE billing.client_price_list (
  id              SERIAL PRIMARY KEY,
  tenant_id       INT     NOT NULL REFERENCES platform.tenants(id),
  client_id       INT     NOT NULL REFERENCES wms.clients(id),
  service_type    billing.service_type NOT NULL,
  description     TEXT,
  unit_price      NUMERIC(14,4) NOT NULL DEFAULT 0,
  min_charge      NUMERIC(14,4),   -- минимальная стоимость за операцию
  currency        TEXT    NOT NULL DEFAULT 'RUB',
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  valid_from      DATE    NOT NULL DEFAULT CURRENT_DATE,
  valid_to        DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, client_id, service_type, valid_from)
);

CREATE INDEX idx_price_list_tenant ON billing.client_price_list(tenant_id, client_id, service_type);

-- Журнал оказанных услуг
CREATE TABLE billing.service_charges (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       INT     NOT NULL REFERENCES platform.tenants(id),
  client_id       INT     NOT NULL REFERENCES wms.clients(id),
  service_type    billing.service_type NOT NULL,
  description     TEXT,
  ref_type        TEXT,         -- movement | picking_task | receiving_task | etc.
  ref_id          BIGINT,
  quantity        NUMERIC(14,4) NOT NULL DEFAULT 1,
  unit_price      NUMERIC(14,4) NOT NULL DEFAULT 0,
  total_amount    NUMERIC(14,4) NOT NULL DEFAULT 0,
  currency        TEXT    NOT NULL DEFAULT 'RUB',
  period_date     DATE    NOT NULL DEFAULT CURRENT_DATE,
  is_invoiced     BOOLEAN NOT NULL DEFAULT FALSE,
  invoice_id      BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_charges_tenant   ON billing.service_charges(tenant_id, client_id);
CREATE INDEX idx_charges_period   ON billing.service_charges(tenant_id, period_date);
CREATE INDEX idx_charges_invoiced ON billing.service_charges(tenant_id, is_invoiced, period_date);
CREATE INDEX idx_charges_ref      ON billing.service_charges(ref_type, ref_id) WHERE ref_type IS NOT NULL;

-- Инвойсы (основа под акты/счета)
CREATE TABLE billing.invoices (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       INT     NOT NULL REFERENCES platform.tenants(id),
  client_id       INT     NOT NULL REFERENCES wms.clients(id),
  invoice_number  TEXT    NOT NULL,
  period_from     DATE    NOT NULL,
  period_to       DATE    NOT NULL,
  total_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency        TEXT    NOT NULL DEFAULT 'RUB',
  status          TEXT    NOT NULL DEFAULT 'draft',  -- draft | sent | paid | cancelled
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, invoice_number)
);

-- FK из service_charges
ALTER TABLE billing.service_charges
  ADD CONSTRAINT fk_charges_invoice FOREIGN KEY (invoice_id)
    REFERENCES billing.invoices(id) ON DELETE SET NULL;

COMMIT;
