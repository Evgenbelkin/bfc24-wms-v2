-- =============================================================================
-- BFC24 WMS v2 — Migration 022: комплекты (kit/BOM)
-- =============================================================================
-- Один и тот же физический товар продаётся на WB в нескольких комплектациях
-- (например, отпугиватель мышей: карточки "1 шт", "2 шт", "3 шт", "4 шт" —
-- у каждой свой штрихкод/карточка на WB, но физически это один и тот же товар).
--
-- kit_of_item_id + kit_multiplier превращают товар в "комплект": он состоит
-- из kit_multiplier штук базового товара kit_of_item_id. Комплект — обычный
-- wms.items с собственным barcode/остатками (stock_balances) — отличие только
-- в том, ЧЕМ его наполняют: не приёмкой с улицы, а сборкой из базового товара
-- (см. новый movement_type 'assembly' и inventory.service.js/assembleKit()).
-- После сборки комплект ведёт себя как любой другой товар — сборка/упаковка/
-- отгрузка/распределение по складам WB не требуют никаких доработок, потому
-- что у комплекта появляется самый обычный физический остаток.
-- =============================================================================
BEGIN;

ALTER TABLE wms.items ADD COLUMN IF NOT EXISTS kit_of_item_id INT REFERENCES wms.items(id);
ALTER TABLE wms.items ADD COLUMN IF NOT EXISTS kit_multiplier INT NOT NULL DEFAULT 1;
ALTER TABLE wms.items ADD CONSTRAINT items_kit_multiplier_positive CHECK (kit_multiplier >= 1);

CREATE INDEX IF NOT EXISTS idx_items_kit_of ON wms.items(kit_of_item_id) WHERE kit_of_item_id IS NOT NULL;

-- Новый тип движения — сборка комплекта (расход базового товара + приход комплекта
-- одной операцией). enum нельзя расширить и тут же использовать новое значение
-- в ОДНОЙ транзакции — но эта миграция только добавляет значение, использовать
-- будем в следующих отдельных транзакциях (обычные INSERT из кода приложения).
ALTER TYPE wms.movement_type ADD VALUE IF NOT EXISTS 'assembly';

COMMIT;
