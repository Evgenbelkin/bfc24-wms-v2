-- =============================================================================
-- BFC24 WMS v2 — Migration 024: Расходные материалы + сдельная ЗП
-- =============================================================================
-- Два независимых блока:
--
-- 1) РАСХОДНИКИ (wms.consumables / wms.consumable_usage)
--    Складской учёт упаковочных материалов (пакеты, короба, скотч и т.п.).
--    У расходника два ценника: cost_price (себестоимость для фулфилмента) и
--    client_unit_price (сколько списываем с клиента за единицу — необязательно,
--    NULL значит "только внутренний учёт, клиенту не выставляем"). Списание
--    оформляется через consumables.service.js:recordUsage, которая одной
--    транзакцией уменьшает остаток и (если задана client_unit_price и передан
--    client_id) создаёт начисление billing.service_charges через уже
--    существующий billing.service.js:addCharge — поэтому здесь достаточно
--    добавить новое значение enum 'materials', не трогая client_price_list.
--
-- 2) СДЕЛЬНАЯ ЗП (billing.employee_rates)
--    Ставка за операцию (движение по wms.movement_type) — на роль ИЛИ на
--    конкретного сотрудника (override). Отчёт по ЗП считается "на лету" из
--    существующего wms.stock_movements (там уже есть user_id на каждой
--    операции) — отдельный лог начислений не нужен, в отличие от billing,
--    где начисления клиенту физически хранятся (там это деньги за услугу,
--    здесь — просто множитель на существующий факт движения).
-- =============================================================================

BEGIN;

-- Новый тип начисления клиенту — за списанные расходники
ALTER TYPE billing.service_type ADD VALUE IF NOT EXISTS 'materials';

-- ---------------------------------------------------------------------------
-- Расходные материалы
-- ---------------------------------------------------------------------------
CREATE TABLE wms.consumables (
  id                 SERIAL PRIMARY KEY,
  tenant_id          INT     NOT NULL REFERENCES platform.tenants(id),
  name               TEXT    NOT NULL,
  unit               TEXT    NOT NULL DEFAULT 'шт',
  qty_on_hand        NUMERIC(14,3) NOT NULL DEFAULT 0,
  low_stock_threshold NUMERIC(14,3),
  cost_price         NUMERIC(14,4),           -- себестоимость закупки, для внутреннего учёта
  client_unit_price  NUMERIC(14,4),           -- NULL = клиенту не выставляем, только учёт остатка
  currency           TEXT    NOT NULL DEFAULT 'RUB',
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX idx_consumables_tenant ON wms.consumables(tenant_id) WHERE is_active = TRUE;

CREATE TABLE wms.consumable_usage (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      INT     NOT NULL REFERENCES platform.tenants(id),
  consumable_id  INT     NOT NULL REFERENCES wms.consumables(id),
  client_id      INT     REFERENCES wms.clients(id),         -- NULL = внутреннее списание, не клиенту
  warehouse_id   INT     REFERENCES wms.warehouses(id),
  qty            NUMERIC(14,3) NOT NULL,                     -- положительное = списание, отрицательное = поступление/корректировка
  ref_type       TEXT,                                       -- 'shipment' | 'manual' | 'adjustment'
  ref_id         BIGINT,
  charge_id      BIGINT,                                     -- billing.service_charges.id, если клиенту выставили
  user_id        INT     REFERENCES wms.users(id),
  comment        TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_consumable_usage_tenant ON wms.consumable_usage(tenant_id, created_at DESC);
CREATE INDEX idx_consumable_usage_consumable ON wms.consumable_usage(consumable_id);
CREATE INDEX idx_consumable_usage_client ON wms.consumable_usage(client_id) WHERE client_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Сдельная ЗП — ставки за операцию
-- ---------------------------------------------------------------------------
CREATE TABLE billing.employee_rates (
  id            SERIAL PRIMARY KEY,
  tenant_id     INT     NOT NULL REFERENCES platform.tenants(id),
  role          TEXT,                                  -- ставка на роль (receiver/picker/packer/shipper/inventory_manager)
  employee_id   INT     REFERENCES wms.users(id) ON DELETE CASCADE,  -- ИЛИ ставка на конкретного сотрудника (override роли)
  movement_type wms.movement_type NOT NULL,
  rate          NUMERIC(10,4) NOT NULL DEFAULT 0,
  currency      TEXT    NOT NULL DEFAULT 'RUB',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT employee_rates_role_xor_employee CHECK (
    (role IS NOT NULL AND employee_id IS NULL) OR (role IS NULL AND employee_id IS NOT NULL)
  )
);

-- Одна ставка на роль+операцию и одна ставка на сотрудника+операцию
CREATE UNIQUE INDEX ux_employee_rates_role ON billing.employee_rates(tenant_id, role, movement_type) WHERE employee_id IS NULL;
CREATE UNIQUE INDEX ux_employee_rates_employee ON billing.employee_rates(tenant_id, employee_id, movement_type) WHERE role IS NULL;

-- ---------------------------------------------------------------------------
-- Регистрируем модули в реестре платформы + сразу включаем существующим
-- тенантам (включая billing — он был написан ранее, но ни разу не был
-- включён ни одному тенанту, т.к. UI для него появляется только сейчас).
-- ---------------------------------------------------------------------------
INSERT INTO platform.modules (module_code, module_name, description, is_core) VALUES
  ('consumables', 'Consumables', 'Учёт расходных материалов и автосписание клиенту', FALSE),
  ('payroll',     'Payroll',     'Сдельная оплата труда сотрудников склада', FALSE)
ON CONFLICT (module_code) DO NOTHING;

INSERT INTO platform.tenant_modules (tenant_id, module_code)
SELECT t.id, m.module_code
FROM platform.tenants t
CROSS JOIN (VALUES ('billing'), ('consumables'), ('payroll')) AS m(module_code)
ON CONFLICT (tenant_id, module_code) DO NOTHING;

COMMIT;
