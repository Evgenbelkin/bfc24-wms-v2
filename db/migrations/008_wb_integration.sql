-- =============================================================================
-- BFC24 WMS v2 — Migration 008: WB Integration
-- =============================================================================
BEGIN;

-- WB карточки товаров
CREATE TABLE wms.wb_items (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           INT         NOT NULL REFERENCES platform.tenants(id),
  mp_account_id       INT         NOT NULL REFERENCES wms.mp_accounts(id) ON DELETE CASCADE,
  nm_id               BIGINT      NOT NULL,
  imt_id              BIGINT,
  vendor_code         TEXT,
  brand               TEXT,
  title               TEXT,
  preview_url         TEXT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mp_account_id, nm_id)
);

CREATE INDEX idx_wb_items_tenant  ON wms.wb_items(tenant_id);
CREATE INDEX idx_wb_items_account ON wms.wb_items(mp_account_id);
CREATE INDEX idx_wb_items_nm_id   ON wms.wb_items(nm_id);

-- WB штрихкоды
CREATE TABLE wms.wb_item_barcodes (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       INT         NOT NULL REFERENCES platform.tenants(id),
  mp_account_id   INT         NOT NULL REFERENCES wms.mp_accounts(id) ON DELETE CASCADE,
  nm_id           BIGINT      NOT NULL,
  chrt_id         BIGINT      NOT NULL,
  barcode         TEXT        NOT NULL,
  UNIQUE (mp_account_id, nm_id, chrt_id, barcode)
);

CREATE INDEX idx_wb_barcodes_tenant  ON wms.wb_item_barcodes(tenant_id);
CREATE INDEX idx_wb_barcodes_barcode ON wms.wb_item_barcodes(mp_account_id, barcode);
CREATE INDEX idx_wb_barcodes_nm_id   ON wms.wb_item_barcodes(mp_account_id, nm_id);

-- WB заказы
CREATE TABLE wms.wb_orders (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           INT         NOT NULL REFERENCES platform.tenants(id),
  mp_account_id       INT         NOT NULL REFERENCES wms.mp_accounts(id),
  wb_order_id         BIGINT      NOT NULL,
  nm_id               BIGINT,
  chrt_id             BIGINT,
  article             TEXT,
  barcode             TEXT,
  warehouse_id        BIGINT,
  warehouse_name      TEXT,
  region_name         TEXT,
  price               NUMERIC(14,2),
  converted_price     NUMERIC(14,2),
  currency_code       TEXT,
  status              TEXT,
  wb_supply_id        TEXT,
  wb_sticker_code     TEXT,
  wb_sticker          TEXT,  -- base64 SVG
  created_at          TIMESTAMPTZ,
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw                 JSONB,
  UNIQUE (mp_account_id, wb_order_id)
);

CREATE INDEX idx_wb_orders_tenant   ON wms.wb_orders(tenant_id);
CREATE INDEX idx_wb_orders_account  ON wms.wb_orders(mp_account_id);
CREATE INDEX idx_wb_orders_supply   ON wms.wb_orders(mp_account_id, wb_supply_id) WHERE wb_supply_id IS NOT NULL;
CREATE INDEX idx_wb_orders_status   ON wms.wb_orders(mp_account_id, status);
CREATE INDEX idx_wb_orders_barcode  ON wms.wb_orders(mp_account_id, barcode) WHERE barcode IS NOT NULL;

-- WB поставки
CREATE TABLE wms.wb_supplies (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       INT         NOT NULL REFERENCES platform.tenants(id),
  mp_account_id   INT         NOT NULL REFERENCES wms.mp_accounts(id),
  supply_code     TEXT        NOT NULL,  -- WB-GI-XXXXX
  sticker_code    TEXT,
  sticker_svg_base64 TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mp_account_id, supply_code)
);

CREATE INDEX idx_wb_supplies_tenant  ON wms.wb_supplies(tenant_id);
CREATE INDEX idx_wb_supplies_account ON wms.wb_supplies(mp_account_id);

-- WB склады продавца
CREATE TABLE wms.wb_seller_warehouses (
  id                      SERIAL PRIMARY KEY,
  tenant_id               INT     NOT NULL REFERENCES platform.tenants(id),
  mp_account_id           INT     NOT NULL REFERENCES wms.mp_accounts(id) ON DELETE CASCADE,
  wb_warehouse_id         BIGINT  NOT NULL,
  warehouse_code          TEXT    NOT NULL,
  warehouse_name          TEXT,
  is_active               BOOLEAN NOT NULL DEFAULT TRUE,
  is_enabled_for_dist     BOOLEAN NOT NULL DEFAULT TRUE,  -- участвует в распределении
  weight                  NUMERIC(8,4) NOT NULL DEFAULT 1.0,
  source                  TEXT    NOT NULL DEFAULT 'wb_api',
  last_synced_at          TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mp_account_id, warehouse_code)
);

CREATE INDEX idx_wb_wh_tenant  ON wms.wb_seller_warehouses(tenant_id);
CREATE INDEX idx_wb_wh_account ON wms.wb_seller_warehouses(mp_account_id);

-- WB распределение остатков по складам
CREATE TABLE wms.wb_stock_distribution (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       INT     NOT NULL REFERENCES platform.tenants(id),
  mp_account_id   INT     NOT NULL REFERENCES wms.mp_accounts(id),
  barcode         TEXT    NOT NULL,
  warehouse_code  TEXT    NOT NULL,
  qty             INT     NOT NULL DEFAULT 0,
  calculated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mp_account_id, barcode, warehouse_code)
);

CREATE INDEX idx_wb_dist_account ON wms.wb_stock_distribution(mp_account_id, barcode);

-- Сырые данные синхронизации статистики
CREATE TABLE wms.wb_sync_runs (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       INT     NOT NULL REFERENCES platform.tenants(id),
  mp_account_id   INT     NOT NULL REFERENCES wms.mp_accounts(id),
  sync_type       TEXT    NOT NULL,  -- orders | sales | items
  status          TEXT    NOT NULL DEFAULT 'running',  -- running | success | failed
  date_from       DATE,
  date_to         DATE,
  rows_loaded     INT     NOT NULL DEFAULT 0,
  error_text      TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ
);

CREATE INDEX idx_wb_sync_runs_tenant  ON wms.wb_sync_runs(tenant_id);
CREATE INDEX idx_wb_sync_runs_account ON wms.wb_sync_runs(mp_account_id);
CREATE INDEX idx_wb_sync_runs_status  ON wms.wb_sync_runs(status) WHERE status = 'running';

COMMIT;
