-- =============================================================================
-- BFC24 WMS v2 — Migration 032: Акт приёмки товара — отдельная сущность
-- =============================================================================
-- В 031 поля акта были добавлены прямо на wms.inbound_orders — оказалось,
-- что акт нужен и без заявки (машина приехала без предварительной заявки,
-- приняли по свободной приёмке, тоже нужен акт). Пока эти колонки нигде не
-- использовались в проде, поэтому просто убираем их и заводим акт как
-- отдельную сущность: может ссылаться на заявку (inbound_order_id), а может
-- существовать сама по себе — со своим набором строк.
-- =============================================================================

BEGIN;

ALTER TABLE wms.inbound_orders
  DROP COLUMN IF EXISTS act_number,
  DROP COLUMN IF EXISTS act_supplier,
  DROP COLUMN IF EXISTS act_boxes_count,
  DROP COLUMN IF EXISTS act_pallets_count,
  DROP COLUMN IF EXISTS act_weight_kg,
  DROP COLUMN IF EXISTS act_carrier,
  DROP COLUMN IF EXISTS act_source_doc,
  DROP COLUMN IF EXISTS act_packaging_ok,
  DROP COLUMN IF EXISTS act_remarks,
  DROP COLUMN IF EXISTS act_client_signer,
  DROP COLUMN IF EXISTS act_operator_signer,
  DROP COLUMN IF EXISTS act_city,
  DROP COLUMN IF EXISTS act_generated_at,
  DROP COLUMN IF EXISTS act_generated_by;

-- ---------------------------------------------------------------------------
-- Акты приёмки товара
-- ---------------------------------------------------------------------------
CREATE TABLE wms.acceptance_acts (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           INT         NOT NULL REFERENCES platform.tenants(id),
  warehouse_id        INT         NOT NULL REFERENCES wms.warehouses(id),
  client_id           INT         NOT NULL REFERENCES wms.clients(id),
  inbound_order_id    BIGINT      REFERENCES wms.inbound_orders(id),  -- NULL = приёмка без заявки

  act_number          TEXT        NOT NULL,
  act_city            TEXT,
  act_supplier        TEXT,
  act_boxes_count     INT,
  act_pallets_count   INT,
  act_weight_kg       NUMERIC(10,2),
  act_carrier         TEXT,
  act_source_doc      TEXT,
  act_packaging_ok    BOOLEAN,
  act_remarks         TEXT,
  act_client_signer   TEXT,
  act_operator_signer TEXT,
  driver_name         TEXT,
  vehicle_make        TEXT,

  created_by          INT         REFERENCES wms.users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_acceptance_acts_tenant ON wms.acceptance_acts(tenant_id);
CREATE INDEX idx_acceptance_acts_client ON wms.acceptance_acts(tenant_id, client_id);
CREATE INDEX idx_acceptance_acts_order  ON wms.acceptance_acts(inbound_order_id) WHERE inbound_order_id IS NOT NULL;

CREATE TRIGGER trg_acceptance_acts_updated_at
  BEFORE UPDATE ON wms.acceptance_acts
  FOR EACH ROW EXECUTE FUNCTION platform.update_updated_at();

-- ---------------------------------------------------------------------------
-- Строки акта (снимок товаров на момент формирования)
-- ---------------------------------------------------------------------------
CREATE TABLE wms.acceptance_act_lines (
  id            BIGSERIAL PRIMARY KEY,
  act_id        BIGINT      NOT NULL REFERENCES wms.acceptance_acts(id) ON DELETE CASCADE,
  tenant_id     INT         NOT NULL REFERENCES platform.tenants(id),
  item_id       INT         REFERENCES wms.items(id),
  barcode       TEXT,
  item_name     TEXT,
  qty_expected  INT,               -- NULL для приёмки без заявки (плана не было)
  qty_received  INT         NOT NULL DEFAULT 0,
  qty_damaged   INT         NOT NULL DEFAULT 0,
  notes         TEXT
);

CREATE INDEX idx_acceptance_act_lines_act ON wms.acceptance_act_lines(act_id);

-- ---------------------------------------------------------------------------
-- Генератор номера акта (для актов "без заявки", где нет order_number)
-- ---------------------------------------------------------------------------
CREATE SEQUENCE wms.acceptance_act_seq START 1000;

CREATE OR REPLACE FUNCTION wms.generate_act_number(p_tenant_id INT)
RETURNS TEXT AS $$
DECLARE
  v_seq BIGINT;
  v_prefix TEXT;
BEGIN
  SELECT nextval('wms.acceptance_act_seq') INTO v_seq;
  SELECT UPPER(LEFT(tenant_code, 3)) INTO v_prefix
  FROM platform.tenants WHERE id = p_tenant_id;
  RETURN v_prefix || '-ACT-' || LPAD(v_seq::TEXT, 6, '0');
END;
$$ LANGUAGE plpgsql;

COMMIT;
