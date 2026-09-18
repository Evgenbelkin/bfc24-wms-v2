-- =============================================================================
-- BFC24 WMS v2 — Migration 043: Материалы упаковки на товар
-- =============================================================================
-- Связь "этому товару для упаковки нужны вот такие расходники" — раньше
-- расходники (wms.consumables, миграция 024) списывались только вручную,
-- упаковщик должен был сам помнить/угадывать, во что класть конкретный товар.
-- Теперь у товара можно указать список расходников с нормой на 1 штуку —
-- при сканировании на упаковке (packing.service.js:scanItem) они спишутся
-- автоматически той же consumables.service.js:recordUsage, и если у расходника
-- задана client_unit_price — начислится клиенту (service_type='materials'),
-- прямо как за приёмку/сборку/отгрузку.
-- =============================================================================

BEGIN;

CREATE TABLE wms.item_packaging_materials (
  id            SERIAL PRIMARY KEY,
  tenant_id     INT NOT NULL REFERENCES platform.tenants(id),
  item_id       INT NOT NULL REFERENCES wms.items(id) ON DELETE CASCADE,
  consumable_id INT NOT NULL REFERENCES wms.consumables(id) ON DELETE CASCADE,
  qty_per_unit  NUMERIC(14,3) NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (item_id, consumable_id)
);

CREATE INDEX idx_item_packaging_materials_item ON wms.item_packaging_materials(item_id);

COMMIT;
