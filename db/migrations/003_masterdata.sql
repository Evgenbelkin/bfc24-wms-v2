-- =============================================================================
-- BFC24 WMS v2 — Migration 003: Masterdata
-- =============================================================================
-- Справочники: склады, клиенты, товары, места хранения
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- СКЛАДЫ (multi-warehouse)
-- ---------------------------------------------------------------------------
CREATE TABLE wms.warehouses (
  id              SERIAL PRIMARY KEY,
  tenant_id       INT         NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  warehouse_code  TEXT        NOT NULL,
  warehouse_name  TEXT        NOT NULL,
  address         TEXT,
  timezone        TEXT        NOT NULL DEFAULT 'Europe/Moscow',
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  is_default      BOOLEAN     NOT NULL DEFAULT FALSE,
  settings        JSONB       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      INT         REFERENCES wms.users(id),
  UNIQUE (tenant_id, warehouse_code)
);

CREATE INDEX idx_warehouses_tenant ON wms.warehouses(tenant_id);

CREATE TRIGGER trg_warehouses_updated_at
  BEFORE UPDATE ON wms.warehouses
  FOR EACH ROW EXECUTE FUNCTION platform.update_updated_at();

-- ---------------------------------------------------------------------------
-- КЛИЕНТЫ фулфилмента (внутри tenant)
-- ---------------------------------------------------------------------------
CREATE TABLE wms.clients (
  id              SERIAL PRIMARY KEY,
  tenant_id       INT         NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  client_code     TEXT        NOT NULL,   -- уникальный код внутри tenant
  client_name     TEXT        NOT NULL,
  contact_name    TEXT,
  contact_email   TEXT,
  contact_phone   TEXT,
  telegram_chat_id TEXT,
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  settings        JSONB       NOT NULL DEFAULT '{}',
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      INT         REFERENCES wms.users(id),
  UNIQUE (tenant_id, client_code)
);

CREATE INDEX idx_clients_tenant ON wms.clients(tenant_id);
CREATE INDEX idx_clients_active ON wms.clients(tenant_id, is_active);

CREATE TRIGGER trg_clients_updated_at
  BEFORE UPDATE ON wms.clients
  FOR EACH ROW EXECUTE FUNCTION platform.update_updated_at();

-- FK из users на clients (для seller role)
ALTER TABLE wms.users
  ADD CONSTRAINT fk_users_client FOREIGN KEY (client_id)
    REFERENCES wms.clients(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- MARKETPLACE ACCOUNTS
-- Аккаунты WB, Ozon и т.д., привязанные к клиентам
-- ---------------------------------------------------------------------------
CREATE TABLE wms.mp_accounts (
  id              SERIAL PRIMARY KEY,
  tenant_id       INT         NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  client_id       INT         NOT NULL REFERENCES wms.clients(id) ON DELETE CASCADE,
  marketplace     TEXT        NOT NULL DEFAULT 'wb',  -- wb | ozon | yandex
  account_code    TEXT,       -- человекочитаемый код
  account_name    TEXT        NOT NULL,
  supplier_id     TEXT,       -- ID поставщика у маркетплейса (WB: supplier_id)
  api_token       TEXT,       -- токен (зашифровать в будущем)
  token_expires_at TIMESTAMPTZ,
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  settings        JSONB       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      INT         REFERENCES wms.users(id),
  CONSTRAINT mp_accounts_marketplace_check CHECK (marketplace IN ('wb', 'ozon', 'yandex', 'sber'))
);

CREATE INDEX idx_mp_accounts_tenant  ON wms.mp_accounts(tenant_id);
CREATE INDEX idx_mp_accounts_client  ON wms.mp_accounts(client_id);
CREATE INDEX idx_mp_accounts_active  ON wms.mp_accounts(tenant_id, is_active);

CREATE TRIGGER trg_mp_accounts_updated_at
  BEFORE UPDATE ON wms.mp_accounts
  FOR EACH ROW EXECUTE FUNCTION platform.update_updated_at();

-- ---------------------------------------------------------------------------
-- ТОВАРЫ (masterdata)
-- Ключевой идентификатор — barcode
-- ---------------------------------------------------------------------------
CREATE TYPE wms.item_unit AS ENUM (
  'шт',    -- штука
  'л',     -- литр
  'кг',    -- килограмм
  'м',     -- метр
  'компл', -- комплект
  'пара',  -- пара
  'упак'   -- упаковка
);

CREATE TABLE wms.items (
  id                SERIAL PRIMARY KEY,
  tenant_id         INT         NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  client_id         INT         NOT NULL REFERENCES wms.clients(id) ON DELETE CASCADE,
  barcode           TEXT        NOT NULL,
  item_name         TEXT        NOT NULL,
  vendor_code       TEXT,       -- артикул продавца
  wb_vendor_code    TEXT,       -- артикул WB (supplierArticle)
  brand             TEXT,
  unit              wms.item_unit NOT NULL DEFAULT 'шт',
  volume_liters     NUMERIC(10,4), -- для литражных товаров
  length_cm         NUMERIC(8,2),
  width_cm          NUMERIC(8,2),
  height_cm         NUMERIC(8,2),
  weight_grams      NUMERIC(10,2),
  cost_price        NUMERIC(14,2),
  processing_fee    NUMERIC(14,2),
  needs_packaging   BOOLEAN     NOT NULL DEFAULT FALSE,
  is_active         BOOLEAN     NOT NULL DEFAULT TRUE,
  source            TEXT        NOT NULL DEFAULT 'manual',  -- manual | wb | ozon
  wb_nm_id          BIGINT,     -- nmId WB
  preview_url       TEXT,
  extra             JSONB       NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by        INT         REFERENCES wms.users(id),
  UNIQUE (tenant_id, client_id, barcode),
  CONSTRAINT items_volume_required CHECK (
    unit <> 'л' OR volume_liters IS NOT NULL
  )
);

CREATE INDEX idx_items_tenant         ON wms.items(tenant_id);
CREATE INDEX idx_items_client         ON wms.items(client_id);
CREATE INDEX idx_items_barcode        ON wms.items(tenant_id, barcode);
CREATE INDEX idx_items_vendor_code    ON wms.items(tenant_id, vendor_code) WHERE vendor_code IS NOT NULL;
CREATE INDEX idx_items_wb_nm_id       ON wms.items(tenant_id, wb_nm_id) WHERE wb_nm_id IS NOT NULL;
CREATE INDEX idx_items_active         ON wms.items(tenant_id, client_id, is_active);

-- GIN индекс для ILIKE поиска
CREATE INDEX idx_items_name_trgm ON wms.items USING gin (item_name gin_trgm_ops);

CREATE TRIGGER trg_items_updated_at
  BEFORE UPDATE ON wms.items
  FOR EACH ROW EXECUTE FUNCTION platform.update_updated_at();

-- ---------------------------------------------------------------------------
-- МЕСТА ХРАНЕНИЯ (МХ / локации)
-- ---------------------------------------------------------------------------
CREATE TYPE wms.location_type AS ENUM (
  'rack',      -- стеллажная ячейка
  'floor',     -- напольная зона
  'buffer',    -- буферная зона (упаковка и т.п.)
  'receiving', -- зона приёмки
  'shipping',  -- зона отгрузки
  'quarantine',-- карантинная зона
  'virtual'    -- виртуальная (для технических операций)
);

CREATE TABLE wms.locations (
  id              SERIAL PRIMARY KEY,
  tenant_id       INT         NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  warehouse_id    INT         NOT NULL REFERENCES wms.warehouses(id) ON DELETE CASCADE,
  location_code   TEXT        NOT NULL,
  description     TEXT,
  location_type   wms.location_type NOT NULL DEFAULT 'rack',
  zone_code       TEXT,       -- зона склада
  aisle           TEXT,       -- проход
  rack            TEXT,       -- стеллаж
  shelf           TEXT,       -- полка
  position        TEXT,       -- позиция
  max_weight_kg   NUMERIC(8,2),
  max_volume_l    NUMERIC(8,2),
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  is_pick_location BOOLEAN    NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      INT         REFERENCES wms.users(id),
  UNIQUE (tenant_id, warehouse_id, location_code)
);

CREATE INDEX idx_locations_tenant    ON wms.locations(tenant_id);
CREATE INDEX idx_locations_warehouse ON wms.locations(warehouse_id);
CREATE INDEX idx_locations_code      ON wms.locations(tenant_id, location_code);
CREATE INDEX idx_locations_zone      ON wms.locations(tenant_id, zone_code) WHERE zone_code IS NOT NULL;
CREATE INDEX idx_locations_active    ON wms.locations(tenant_id, is_active);
CREATE INDEX idx_locations_type      ON wms.locations(tenant_id, location_type);

-- GIN для поиска по коду ячейки
CREATE INDEX idx_locations_code_trgm ON wms.locations USING gin (location_code gin_trgm_ops);

CREATE TRIGGER trg_locations_updated_at
  BEFORE UPDATE ON wms.locations
  FOR EACH ROW EXECUTE FUNCTION platform.update_updated_at();

COMMIT;
