-- =============================================================================
-- BFC24 WMS v2 — Migration 001: Platform (SaaS Layer)
-- =============================================================================
-- Верхний уровень SaaS-платформы: tenants, тарифы, модули, подписки
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Extension
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- для LIKE-поиска по индексу

-- ---------------------------------------------------------------------------
-- SCHEMA: platform
-- Всё, что относится к SaaS-управлению платформой
-- ---------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA IF NOT EXISTS wms;
CREATE SCHEMA IF NOT EXISTS seller;
CREATE SCHEMA IF NOT EXISTS analytics;
CREATE SCHEMA IF NOT EXISTS billing;
CREATE SCHEMA IF NOT EXISTS audit;

-- ---------------------------------------------------------------------------
-- Тарифные планы
-- ---------------------------------------------------------------------------
CREATE TABLE platform.plans (
  id              SERIAL PRIMARY KEY,
  plan_code       TEXT        NOT NULL UNIQUE,
  plan_name       TEXT        NOT NULL,
  description     TEXT,
  price_monthly   NUMERIC(12,2) NOT NULL DEFAULT 0,
  price_annually  NUMERIC(12,2) NOT NULL DEFAULT 0,
  max_users       INT         NOT NULL DEFAULT 10,
  max_clients     INT         NOT NULL DEFAULT 5,
  max_warehouses  INT         NOT NULL DEFAULT 1,
  max_skus        INT         NOT NULL DEFAULT 5000,
  max_orders_per_month INT    NOT NULL DEFAULT 1000,
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Модули системы (feature flags)
-- ---------------------------------------------------------------------------
CREATE TABLE platform.modules (
  id          SERIAL PRIMARY KEY,
  module_code TEXT    NOT NULL UNIQUE,
  module_name TEXT    NOT NULL,
  description TEXT,
  is_core     BOOLEAN NOT NULL DEFAULT FALSE, -- core модули всегда включены
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Вставляем все модули системы
INSERT INTO platform.modules (module_code, module_name, description, is_core) VALUES
  ('auth',          'Auth & Users',         'Аутентификация и управление пользователями', TRUE),
  ('masterdata',    'Masterdata',           'Справочники: товары, клиенты, локации', TRUE),
  ('stock',         'Stock',                'Управление остатками и движениями', TRUE),
  ('receiving',     'Receiving',            'Модуль приёмки товаров', TRUE),
  ('placement',     'Placement',            'Модуль размещения товаров', TRUE),
  ('movement',      'Movement',             'Перемещение между ячейками', TRUE),
  ('picking',       'Picking',              'Сборка заказов', TRUE),
  ('packing',       'Packing',              'Упаковка заказов', TRUE),
  ('shipping',      'Shipping',             'Отгрузка', TRUE),
  ('inventory',     'Inventory',            'Инвентаризация', FALSE),
  ('inbound_orders','Inbound Orders',       'Заявки на поставку от селлеров', FALSE),
  ('seller_cabinet','Seller Cabinet',       'Личный кабинет селлера', FALSE),
  ('wb_integration','WB Integration',       'Интеграция с Wildberries', FALSE),
  ('printing',      'Printing',             'Управление принтерами и печатью', FALSE),
  ('analytics',     'Analytics',            'Аналитика и отчёты', FALSE),
  ('billing',       'Billing',              'Биллинг и тарификация', FALSE),
  ('multi_warehouse','Multi-Warehouse',     'Несколько складов', FALSE);

-- ---------------------------------------------------------------------------
-- Tenant'ы (фулфилменты)
-- ---------------------------------------------------------------------------
CREATE TYPE platform.tenant_status AS ENUM (
  'trial',      -- пробный период
  'active',     -- активный
  'suspended',  -- приостановлен (просрочка платежа и т.п.)
  'blocked',    -- заблокирован платформой
  'archived'    -- архивный
);

CREATE TABLE platform.tenants (
  id              SERIAL PRIMARY KEY,
  tenant_code     TEXT        NOT NULL UNIQUE,  -- уникальный slug (bfc24, mywms, etc.)
  company_name    TEXT        NOT NULL,
  contact_email   TEXT        NOT NULL,
  contact_phone   TEXT,
  timezone        TEXT        NOT NULL DEFAULT 'Europe/Moscow',
  country_code    TEXT        NOT NULL DEFAULT 'RU',
  status          platform.tenant_status NOT NULL DEFAULT 'trial',
  plan_id         INT         REFERENCES platform.plans(id),
  trial_ends_at   TIMESTAMPTZ,
  notes           TEXT,
  settings        JSONB       NOT NULL DEFAULT '{}',  -- произвольные настройки
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      INT,  -- platform_owner user id
  CONSTRAINT tenants_code_format CHECK (tenant_code ~ '^[a-z0-9_-]{2,50}$')
);

CREATE INDEX idx_tenants_status ON platform.tenants(status);
CREATE INDEX idx_tenants_code   ON platform.tenants(tenant_code);

-- ---------------------------------------------------------------------------
-- Включённые модули по tenant
-- ---------------------------------------------------------------------------
CREATE TABLE platform.tenant_modules (
  id          SERIAL PRIMARY KEY,
  tenant_id   INT NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  module_code TEXT NOT NULL REFERENCES platform.modules(module_code),
  enabled_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  enabled_by  INT,
  UNIQUE (tenant_id, module_code)
);

CREATE INDEX idx_tenant_modules_tenant ON platform.tenant_modules(tenant_id);

-- ---------------------------------------------------------------------------
-- Подписки tenant → план
-- ---------------------------------------------------------------------------
CREATE TYPE platform.subscription_status AS ENUM (
  'active', 'cancelled', 'expired', 'paused'
);

CREATE TABLE platform.subscriptions (
  id              SERIAL PRIMARY KEY,
  tenant_id       INT         NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  plan_id         INT         NOT NULL REFERENCES platform.plans(id),
  status          platform.subscription_status NOT NULL DEFAULT 'active',
  billing_period  TEXT        NOT NULL DEFAULT 'monthly', -- monthly | annually
  price           NUMERIC(12,2) NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_subscriptions_tenant ON platform.subscriptions(tenant_id);
CREATE INDEX idx_subscriptions_status ON platform.subscriptions(status);

-- ---------------------------------------------------------------------------
-- Platform users (only platform_owner role)
-- ---------------------------------------------------------------------------
CREATE TABLE platform.users (
  id              SERIAL PRIMARY KEY,
  username        TEXT        NOT NULL UNIQUE,
  email           TEXT        NOT NULL UNIQUE,
  password_hash   TEXT        NOT NULL,
  full_name       TEXT,
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Функция обновления updated_at
CREATE OR REPLACE FUNCTION platform.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Триггер на tenants
CREATE TRIGGER trg_tenants_updated_at
  BEFORE UPDATE ON platform.tenants
  FOR EACH ROW EXECUTE FUNCTION platform.update_updated_at();

CREATE TRIGGER trg_plans_updated_at
  BEFORE UPDATE ON platform.plans
  FOR EACH ROW EXECUTE FUNCTION platform.update_updated_at();

-- Базовый тарифный план
INSERT INTO platform.plans (plan_code, plan_name, description, price_monthly, max_users, max_clients, max_warehouses, max_skus, max_orders_per_month)
VALUES
  ('starter',    'Starter',    'Для небольших фулфилментов', 0, 5, 3, 1, 1000, 500),
  ('business',   'Business',   'Для растущих операций', 9900, 15, 10, 2, 10000, 5000),
  ('enterprise', 'Enterprise', 'Для крупных операторов', 29900, 999, 999, 999, 999999, 999999);

COMMIT;
