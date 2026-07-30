-- =============================================================================
-- BFC24 WMS v2 — Migration 026: Локальный учёт кодов "Честный знак"
-- =============================================================================
-- Скоуп (согласован с клиентом):
--   - ТОЛЬКО локальный учёт, без интеграции с ЦРПТ/госсистемой "Честный знак".
--   - Без агрегации коробов — учёт поштучный, один код = одна физическая единица.
--   - Коды поставляются оператором заранее (импорт списком в справочнике товара)
--     и просто раздаются по одному на каждую принятую/упакованную единицу.
--   - Печать стикера с Data Matrix — на приёмке и/или упаковке, настраивается
--     на уровне товара (wms.items.marking_trigger), т.к. разным товарам разных
--     клиентов это может быть нужно в разный момент. Обязательное требование:
--     стикер ВБ и стикер "Честный знак" печатаются ВМЕСТЕ, одним сканированием
--     штрихкода — чтобы сотрудник не искал, что на товар клеить.
--
-- wms.marking_codes — пул кодов на товар. Код "используется" (status='used')
-- в момент фактической печати, ссылаясь на операцию (used_ref_type/used_ref_id),
-- которая его востребовала — receiving_tasks.id либо stock_movements.id
-- (упаковка). used_ref_type/used_ref_id — не FK (два разных возможных типа
-- источника), только для трассировки "какой код на какую операцию ушёл".
-- =============================================================================

BEGIN;

ALTER TABLE wms.items
  ADD COLUMN requires_marking BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN marking_trigger TEXT NOT NULL DEFAULT 'packing'
    CHECK (marking_trigger IN ('receiving', 'packing'));

CREATE TABLE wms.marking_codes (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    INT     NOT NULL REFERENCES platform.tenants(id),
  item_id      INT     NOT NULL REFERENCES wms.items(id),
  code         TEXT    NOT NULL,                 -- сырое содержимое Data Matrix (как импортировано)
  status       TEXT    NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'used')),
  used_at      TIMESTAMPTZ,
  used_ref_type TEXT,                            -- 'receiving' | 'packing'
  used_ref_id  BIGINT,
  used_by      INT     REFERENCES wms.users(id),
  created_by   INT     REFERENCES wms.users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

-- Быстрая выборка "следующих N свободных кодов на товар" — самый горячий путь
-- (allocate при каждом скане на приёмке/упаковке).
CREATE INDEX idx_marking_codes_available ON wms.marking_codes(tenant_id, item_id, id)
  WHERE status = 'available';

INSERT INTO platform.modules (module_code, module_name, description, is_core) VALUES
  ('marking', 'Marking (Честный знак)', 'Локальный учёт кодов маркировки Честный знак, без интеграции с ЦРПТ', FALSE)
ON CONFLICT (module_code) DO NOTHING;

INSERT INTO platform.tenant_modules (tenant_id, module_code)
SELECT id, 'marking' FROM platform.tenants
ON CONFLICT (tenant_id, module_code) DO NOTHING;

COMMIT;
