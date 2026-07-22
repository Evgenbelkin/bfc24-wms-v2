-- =============================================================================
-- BFC24 WMS v2 — Migration 006: Warehouse Flows
-- =============================================================================
-- Все операционные таблицы склада
-- =============================================================================

BEGIN;

-- ===========================================================================
-- ПРИЁМКА (Receiving Tasks)
-- ===========================================================================
CREATE TYPE wms.receiving_task_status AS ENUM (
  'open', 'in_progress', 'completed', 'cancelled'
);

CREATE TABLE wms.receiving_tasks (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       INT         NOT NULL REFERENCES platform.tenants(id),
  warehouse_id    INT         NOT NULL REFERENCES wms.warehouses(id),
  client_id       INT         NOT NULL REFERENCES wms.clients(id),
  inbound_order_id BIGINT     REFERENCES wms.inbound_orders(id),  -- NULL = свободная приёмка
  item_id         INT         NOT NULL REFERENCES wms.items(id),
  barcode         TEXT        NOT NULL,
  location_id     INT         REFERENCES wms.locations(id),  -- место приёмки
  location_code   TEXT,

  qty_expected    INT,        -- NULL = свободная приёмка
  qty_received    INT         NOT NULL DEFAULT 0,
  qty_damaged     INT         NOT NULL DEFAULT 0,

  status          wms.receiving_task_status NOT NULL DEFAULT 'open',
  receiver_id     INT         REFERENCES wms.users(id),
  notes           TEXT,

  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      INT         REFERENCES wms.users(id)
);

CREATE INDEX idx_recv_tasks_tenant   ON wms.receiving_tasks(tenant_id);
CREATE INDEX idx_recv_tasks_client   ON wms.receiving_tasks(client_id);
CREATE INDEX idx_recv_tasks_inbound  ON wms.receiving_tasks(inbound_order_id) WHERE inbound_order_id IS NOT NULL;
CREATE INDEX idx_recv_tasks_status   ON wms.receiving_tasks(tenant_id, status);
CREATE INDEX idx_recv_tasks_receiver ON wms.receiving_tasks(receiver_id) WHERE receiver_id IS NOT NULL;

CREATE TRIGGER trg_recv_tasks_updated_at
  BEFORE UPDATE ON wms.receiving_tasks
  FOR EACH ROW EXECUTE FUNCTION platform.update_updated_at();

-- ===========================================================================
-- ЗАДАНИЯ НА СБОРКУ (Picking Tasks & Waves)
-- ===========================================================================
CREATE TYPE wms.picking_task_status AS ENUM (
  'new', 'in_progress', 'done', 'cancelled', 'skipped'
);

CREATE TYPE wms.wave_status AS ENUM (
  'open',        -- сформирована, ещё не назначена
  'offered',     -- предложена сборщику
  'active',      -- взята сборщиком в работу
  'ready',       -- все задачи выполнены, ждёт паркинга
  'done',        -- закрыта
  'cancelled'
);

-- Волны сборки
CREATE TABLE wms.pick_waves (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           INT         NOT NULL REFERENCES platform.tenants(id),
  warehouse_id        INT         NOT NULL REFERENCES wms.warehouses(id),
  client_id           INT         NOT NULL REFERENCES wms.clients(id),
  shipment_code       TEXT        NOT NULL,   -- WB-GI-XXXXX или внутренний код
  status              wms.wave_status NOT NULL DEFAULT 'open',
  picker_id           INT         REFERENCES wms.users(id),
  buffer_location_id  INT         REFERENCES wms.locations(id),
  buffer_location_code TEXT,
  total_tasks         INT         NOT NULL DEFAULT 0,
  done_tasks          INT         NOT NULL DEFAULT 0,
  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at         TIMESTAMPTZ,
  ready_at            TIMESTAMPTZ,
  closed_at           TIMESTAMPTZ,
  created_by          INT         REFERENCES wms.users(id),
  UNIQUE (tenant_id, shipment_code)
);

CREATE INDEX idx_waves_tenant    ON wms.pick_waves(tenant_id);
CREATE INDEX idx_waves_status    ON wms.pick_waves(tenant_id, status);
CREATE INDEX idx_waves_picker    ON wms.pick_waves(picker_id, status);
CREATE INDEX idx_waves_warehouse ON wms.pick_waves(warehouse_id);

CREATE TRIGGER trg_waves_updated_at
  BEFORE UPDATE ON wms.pick_waves
  FOR EACH ROW EXECUTE FUNCTION platform.update_updated_at();

-- Задания на сборку
CREATE TABLE wms.picking_tasks (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       INT         NOT NULL REFERENCES platform.tenants(id),
  warehouse_id    INT         NOT NULL REFERENCES wms.warehouses(id),
  client_id       INT         NOT NULL REFERENCES wms.clients(id),
  wave_id         BIGINT      REFERENCES wms.pick_waves(id),
  item_id         INT         NOT NULL REFERENCES wms.items(id),
  barcode         TEXT        NOT NULL,
  location_id     INT         REFERENCES wms.locations(id),
  location_code   TEXT,

  qty             INT         NOT NULL,
  qty_picked      INT         NOT NULL DEFAULT 0,

  status          wms.picking_task_status NOT NULL DEFAULT 'new',
  picker_id       INT         REFERENCES wms.users(id),
  scan_step       TEXT        NOT NULL DEFAULT 'await_location',  -- await_location | await_item | done

  shipment_code   TEXT,
  wb_order_id     BIGINT,
  order_ref       TEXT,
  priority        SMALLINT    NOT NULL DEFAULT 3,
  reason          TEXT,
  comment         TEXT,

  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      INT         REFERENCES wms.users(id),
  updated_by      INT         REFERENCES wms.users(id),

  CONSTRAINT picking_qty_positive CHECK (qty > 0),
  CONSTRAINT picking_picked_nonneg CHECK (qty_picked >= 0)
);

CREATE INDEX idx_picking_tenant    ON wms.picking_tasks(tenant_id);
CREATE INDEX idx_picking_wave      ON wms.picking_tasks(wave_id);
CREATE INDEX idx_picking_status    ON wms.picking_tasks(tenant_id, status);
CREATE INDEX idx_picking_picker    ON wms.picking_tasks(picker_id, status);
CREATE INDEX idx_picking_shipment  ON wms.picking_tasks(tenant_id, shipment_code);
CREATE INDEX idx_picking_item      ON wms.picking_tasks(item_id);
CREATE INDEX idx_picking_wb_order  ON wms.picking_tasks(wb_order_id) WHERE wb_order_id IS NOT NULL;

CREATE TRIGGER trg_picking_updated_at
  BEFORE UPDATE ON wms.picking_tasks
  FOR EACH ROW EXECUTE FUNCTION platform.update_updated_at();

-- Журнал сканирований при сборке
CREATE TABLE wms.picking_scans (
  id              BIGSERIAL PRIMARY KEY,
  picking_task_id BIGINT      NOT NULL REFERENCES wms.picking_tasks(id) ON DELETE CASCADE,
  picker_id       INT         NOT NULL REFERENCES wms.users(id),
  scan_type       TEXT        NOT NULL,  -- location | item | skip
  expected        TEXT,
  scanned         TEXT,
  result          TEXT        NOT NULL,  -- ok | mismatch | error
  message         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_picking_scans_task ON wms.picking_scans(picking_task_id);

-- ===========================================================================
-- ИНВЕНТАРИЗАЦИЯ
-- ===========================================================================
CREATE TYPE wms.inventory_task_status AS ENUM (
  'open', 'in_progress', 'done', 'cancelled'
);

CREATE TABLE wms.inventory_tasks (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       INT         NOT NULL REFERENCES platform.tenants(id),
  warehouse_id    INT         NOT NULL REFERENCES wms.warehouses(id),
  client_id       INT         NOT NULL REFERENCES wms.clients(id),
  item_id         INT         REFERENCES wms.items(id),
  barcode         TEXT        NOT NULL,
  location_id     INT         REFERENCES wms.locations(id),
  location_code   TEXT        NOT NULL,

  qty_system      INT,        -- остаток по системе на момент создания задачи
  qty_actual      INT,        -- фактически пересчитано
  qty_delta       INT,        -- qty_actual - qty_system

  status          wms.inventory_task_status NOT NULL DEFAULT 'open',
  priority        SMALLINT    NOT NULL DEFAULT 3,
  reason          TEXT,
  comment         TEXT,
  assignee_id     INT         REFERENCES wms.users(id),

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      INT         REFERENCES wms.users(id),
  closed_at       TIMESTAMPTZ,
  closed_by       INT         REFERENCES wms.users(id)
);

CREATE INDEX idx_inventory_tenant   ON wms.inventory_tasks(tenant_id);
CREATE INDEX idx_inventory_status   ON wms.inventory_tasks(tenant_id, status);
CREATE INDEX idx_inventory_item_loc ON wms.inventory_tasks(item_id, location_id, status);
CREATE INDEX idx_inventory_barcode  ON wms.inventory_tasks(tenant_id, barcode, location_code, status);

CREATE TRIGGER trg_inventory_updated_at
  BEFORE UPDATE ON wms.inventory_tasks
  FOR EACH ROW EXECUTE FUNCTION platform.update_updated_at();

-- ===========================================================================
-- УПАКОВКА (Packing)
-- ===========================================================================
CREATE TYPE wms.packing_task_status AS ENUM (
  'new', 'in_progress', 'done', 'cancelled'
);

CREATE TABLE wms.packing_tasks (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       INT         NOT NULL REFERENCES platform.tenants(id),
  warehouse_id    INT         NOT NULL REFERENCES wms.warehouses(id),
  client_id       INT         NOT NULL REFERENCES wms.clients(id),
  shipment_code   TEXT        NOT NULL,
  status          wms.packing_task_status NOT NULL DEFAULT 'new',
  packer_id       INT         REFERENCES wms.users(id),
  boxes_count     INT,
  priority        SMALLINT    NOT NULL DEFAULT 100,
  comment         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      INT         REFERENCES wms.users(id),
  updated_by      INT         REFERENCES wms.users(id)
);

CREATE INDEX idx_packing_tenant   ON wms.packing_tasks(tenant_id);
CREATE INDEX idx_packing_shipment ON wms.packing_tasks(tenant_id, shipment_code);
CREATE INDEX idx_packing_status   ON wms.packing_tasks(tenant_id, status);
CREATE INDEX idx_packing_packer   ON wms.packing_tasks(packer_id, status);

CREATE TRIGGER trg_packing_updated_at
  BEFORE UPDATE ON wms.packing_tasks
  FOR EACH ROW EXECUTE FUNCTION platform.update_updated_at();

-- ===========================================================================
-- ОТГРУЗКИ (Shipments)
-- ===========================================================================
CREATE TYPE wms.shipment_status AS ENUM (
  'new',
  'picking',
  'packing',
  'ready_to_ship',
  'shipping',
  'in_transit',
  'done',
  'cancelled'
);

CREATE TABLE wms.shipments (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           INT         NOT NULL REFERENCES platform.tenants(id),
  warehouse_id        INT         NOT NULL REFERENCES wms.warehouses(id),
  client_id           INT         NOT NULL REFERENCES wms.clients(id),
  external_id         TEXT        NOT NULL,   -- WB-GI-XXXXX или внутренний код
  marketplace         TEXT        NOT NULL DEFAULT 'wb',
  status              wms.shipment_status NOT NULL DEFAULT 'new',

  total_planned_qty   INT         NOT NULL DEFAULT 0,
  total_picked_qty    INT         NOT NULL DEFAULT 0,
  total_packed_qty    INT         NOT NULL DEFAULT 0,
  total_shipped_qty   INT         NOT NULL DEFAULT 0,

  packing_location_id     INT     REFERENCES wms.locations(id),
  packing_location_code   TEXT,
  packing_started_at      TIMESTAMPTZ,
  packing_finished_at     TIMESTAMPTZ,
  shipped_at              TIMESTAMPTZ,

  wb_supply_qr_base64 TEXT,
  packer_id           INT         REFERENCES wms.users(id),
  shipper_id          INT         REFERENCES wms.users(id),

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by          INT         REFERENCES wms.users(id),

  UNIQUE (tenant_id, external_id)
);

CREATE INDEX idx_shipments_tenant   ON wms.shipments(tenant_id);
CREATE INDEX idx_shipments_client   ON wms.shipments(client_id);
CREATE INDEX idx_shipments_status   ON wms.shipments(tenant_id, status);
CREATE INDEX idx_shipments_ext_id   ON wms.shipments(tenant_id, external_id);

CREATE TRIGGER trg_shipments_updated_at
  BEFORE UPDATE ON wms.shipments
  FOR EACH ROW EXECUTE FUNCTION platform.update_updated_at();

-- ===========================================================================
-- SKU Registry (barcode → item mapping для tenant/client)
-- Гарантирует уникальность barcode внутри client
-- ===========================================================================
CREATE TABLE wms.sku_registry (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   INT     NOT NULL REFERENCES platform.tenants(id),
  client_id   INT     NOT NULL REFERENCES wms.clients(id),
  item_id     INT     NOT NULL REFERENCES wms.items(id),
  barcode     TEXT    NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, client_id, barcode)
);

CREATE INDEX idx_sku_registry_tenant  ON wms.sku_registry(tenant_id, barcode);
CREATE INDEX idx_sku_registry_item    ON wms.sku_registry(item_id);

COMMIT;
