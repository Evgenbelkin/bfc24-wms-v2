-- =============================================================================
-- BFC24 WMS v2 — Migration 066: Под-склады (учёт остатков внутри склада)
-- =============================================================================
-- Задача (17.09.2026, клиент "ЭсЭнДи"): весь товар физически лежит на одном
-- большом складе, но клиент хочет вести учёт остатков в разрезе виртуальных
-- "под-складов" внутри него — так же, как деление склада на несколько
-- складов в 1С/МойСклад. Уточнили с клиентом: пока это ТОЛЬКО фиксация
-- остатков — приёмка/сборка/размещение ничего не проверяют и не
-- ограничивают (сборка под сети первое время будет вестись вручную).
--
-- Поэтому решение полностью аддитивное, по аналогии с "пул остатков"
-- (миграция 061), но проще — там резолвер нужен был на запись остатка,
-- здесь наоборот: остаток как был привязан к конкретной ЯЧЕЙКЕ
-- (stock_balances.location_id), так и остаётся — под-склад это просто
-- необязательный тег на самой ячейке. Ни stock_balances, ни
-- stock_movements, ни apply_stock_movement/reserve_stock, ни сборка/
-- размещение/резервирование не меняются ни на строчку — они продолжают
-- работать по ячейкам, как раньше. Под-склад используется только на чтении
-- (группировка в отчёте "Обзор склада").
-- =============================================================================

BEGIN;

CREATE TABLE wms.sub_warehouses (
  id            SERIAL      PRIMARY KEY,
  tenant_id     INT         NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  warehouse_id  INT         NOT NULL REFERENCES wms.warehouses(id) ON DELETE CASCADE,
  code          TEXT        NOT NULL,
  name          TEXT        NOT NULL,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    INT         REFERENCES wms.users(id),
  UNIQUE (tenant_id, warehouse_id, code)
);

CREATE INDEX idx_sub_warehouses_tenant_warehouse ON wms.sub_warehouses(tenant_id, warehouse_id);

CREATE TRIGGER trg_sub_warehouses_updated_at
  BEFORE UPDATE ON wms.sub_warehouses
  FOR EACH ROW EXECUTE FUNCTION platform.update_updated_at();

ALTER TABLE wms.locations
  ADD COLUMN IF NOT EXISTS sub_warehouse_id INT REFERENCES wms.sub_warehouses(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_locations_sub_warehouse ON wms.locations(sub_warehouse_id) WHERE sub_warehouse_id IS NOT NULL;

COMMENT ON TABLE wms.sub_warehouses IS 'Виртуальное деление физического склада на под-склады — только для учёта остатков (группировка ячеек по тегу), не влияет на сборку/размещение/резервирование.';
COMMENT ON COLUMN wms.locations.sub_warehouse_id IS 'Необязательная привязка ячейки к под-складу (wms.sub_warehouses). NULL = ячейка не отнесена ни к одному под-складу.';

COMMIT;
