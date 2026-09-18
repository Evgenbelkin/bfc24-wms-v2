-- =============================================================================
-- BFC24 WMS v2 — Migration 005: Inbound Orders
-- =============================================================================
-- Заявки на поставку: селлер создаёт заявку, склад принимает строго по ней
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Статусы заявки на поставку
-- ---------------------------------------------------------------------------
CREATE TYPE wms.inbound_order_status AS ENUM (
  'draft',       -- черновик (селлер ещё редактирует)
  'confirmed',   -- подтверждена (отправлена складу)
  'scheduled',   -- назначена дата приёмки
  'in_progress', -- приёмка началась
  'completed',   -- полностью принята
  'partial',     -- частично принята (часть товара)
  'cancelled'    -- отменена
);

-- ---------------------------------------------------------------------------
-- Заявки на поставку
-- ---------------------------------------------------------------------------
CREATE TABLE wms.inbound_orders (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       INT         NOT NULL REFERENCES platform.tenants(id),
  warehouse_id    INT         NOT NULL REFERENCES wms.warehouses(id),
  client_id       INT         NOT NULL REFERENCES wms.clients(id),

  order_number    TEXT        NOT NULL,  -- человекочитаемый номер (авто или от клиента)
  barcode         TEXT        NOT NULL,  -- штрихкод/QR заявки для сканирования на складе
  status          wms.inbound_order_status NOT NULL DEFAULT 'draft',

  expected_date   DATE,                  -- плановая дата поступления
  scheduled_date  DATE,                  -- назначенная дата приёмки складом
  notes           TEXT,

  total_expected_qty  INT     NOT NULL DEFAULT 0,  -- сумма ожидаемых единиц
  total_received_qty  INT     NOT NULL DEFAULT 0,  -- сумма принятых единиц

  created_by_user_id INT      REFERENCES wms.users(id),
  confirmed_at    TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, order_number),
  UNIQUE (tenant_id, barcode)
);

CREATE INDEX idx_inbound_orders_tenant   ON wms.inbound_orders(tenant_id);
CREATE INDEX idx_inbound_orders_client   ON wms.inbound_orders(client_id);
CREATE INDEX idx_inbound_orders_status   ON wms.inbound_orders(tenant_id, status);
CREATE INDEX idx_inbound_orders_barcode  ON wms.inbound_orders(tenant_id, barcode);
CREATE INDEX idx_inbound_orders_date     ON wms.inbound_orders(tenant_id, expected_date);

CREATE TRIGGER trg_inbound_orders_updated_at
  BEFORE UPDATE ON wms.inbound_orders
  FOR EACH ROW EXECUTE FUNCTION platform.update_updated_at();

-- ---------------------------------------------------------------------------
-- Строки заявки (товары и количества)
-- ---------------------------------------------------------------------------
CREATE TYPE wms.inbound_line_status AS ENUM (
  'pending',     -- ожидает приёмки
  'partial',     -- частично принята
  'received',    -- полностью принята
  'excess',      -- принято больше ожидаемого
  'cancelled'    -- отменена
);

CREATE TABLE wms.inbound_order_lines (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       INT         NOT NULL REFERENCES platform.tenants(id),
  inbound_order_id BIGINT     NOT NULL REFERENCES wms.inbound_orders(id) ON DELETE CASCADE,
  client_id       INT         NOT NULL REFERENCES wms.clients(id),
  item_id         INT         REFERENCES wms.items(id),  -- может быть null если товар ещё не в справочнике
  barcode         TEXT        NOT NULL,
  item_name       TEXT,       -- денормализация на момент создания заявки
  vendor_code     TEXT,

  qty_expected    INT         NOT NULL,
  qty_received    INT         NOT NULL DEFAULT 0,
  qty_damaged     INT         NOT NULL DEFAULT 0,

  status          wms.inbound_line_status NOT NULL DEFAULT 'pending',
  notes           TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT inbound_line_qty_positive CHECK (qty_expected > 0),
  CONSTRAINT inbound_line_received_nonneg CHECK (qty_received >= 0)
);

CREATE INDEX idx_inbound_lines_order   ON wms.inbound_order_lines(inbound_order_id);
CREATE INDEX idx_inbound_lines_barcode ON wms.inbound_order_lines(tenant_id, barcode);
CREATE INDEX idx_inbound_lines_item    ON wms.inbound_order_lines(item_id) WHERE item_id IS NOT NULL;

CREATE TRIGGER trg_inbound_lines_updated_at
  BEFORE UPDATE ON wms.inbound_order_lines
  FOR EACH ROW EXECUTE FUNCTION platform.update_updated_at();

-- ---------------------------------------------------------------------------
-- Функция генерации номера заявки
-- ---------------------------------------------------------------------------
CREATE SEQUENCE wms.inbound_order_seq START 1000;

CREATE OR REPLACE FUNCTION wms.generate_inbound_order_number(p_tenant_id INT)
RETURNS TEXT AS $$
DECLARE
  v_seq BIGINT;
  v_prefix TEXT;
BEGIN
  SELECT nextval('wms.inbound_order_seq') INTO v_seq;
  SELECT UPPER(LEFT(tenant_code, 3)) INTO v_prefix
  FROM platform.tenants WHERE id = p_tenant_id;
  RETURN v_prefix || '-IN-' || LPAD(v_seq::TEXT, 6, '0');
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Функция генерации штрихкода заявки
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wms.generate_inbound_barcode()
RETURNS TEXT AS $$
BEGIN
  RETURN 'IN' || UPPER(REPLACE(gen_random_uuid()::TEXT, '-', ''));
END;
$$ LANGUAGE plpgsql;

COMMIT;
