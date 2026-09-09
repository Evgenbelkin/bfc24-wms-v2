-- =============================================================================
-- BFC24 WMS v2 — Migration 060: Алиасы штрихкодов товара + слияние дублей
-- =============================================================================
-- Проблема: у одной карточки WB (nm_id) может быть зарегистрировано НЕСКОЛЬКО
-- штрихкодов на один и тот же физический товар/размер (не путать с разными
-- размерами одной карточки — те остаются раздельными позициями, это
-- нормально). wms.items привязан к товару РОВНО ОДНИМ штрихкодом
-- (UNIQUE(tenant_id, client_id, barcode)), поэтому раньше такие "второй
-- штрихкод того же товара" молча заводили ОТДЕЛЬНУЮ строку wms.items со
-- своим отдельным остатком — задание от WB с одним штрихкодом не видело
-- остаток, принятый под другим штрихкодом того же физического товара.
--
-- Решение: отдельная таблица алиасов — любой штрихкод (кроме "основного",
-- уже лежащего в items.barcode) можно привязать к item_id. Резолв штрихкода
-- при скане (см. items.service.js) сначала смотрит сюда, потом — как раньше,
-- в items.barcode. items.barcode не трогаем и не отменяем — это по-прежнему
-- "основной/отображаемый" штрихкод товара.
BEGIN;

CREATE TABLE wms.item_barcodes (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   INT         NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  client_id   INT         NOT NULL REFERENCES wms.clients(id) ON DELETE CASCADE,
  item_id     INT         NOT NULL REFERENCES wms.items(id) ON DELETE CASCADE,
  barcode     TEXT        NOT NULL,
  source      TEXT        NOT NULL DEFAULT 'wb', -- wb | merge | manual
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, client_id, barcode)
);

CREATE INDEX idx_item_barcodes_item ON wms.item_barcodes(item_id);

-- Товар, "проигравший" при слиянии дублей (см. одноразовый скрипт слияния),
-- не удаляется физически — история (движения, кизы, задачи) на нём могла
-- уже быть. Помечаем is_active=false (поле уже есть) и явно указываем, во
-- что он слит, чтобы это было видно в БД и в возможных будущих отчётах.
ALTER TABLE wms.items ADD COLUMN merged_into_item_id INT REFERENCES wms.items(id);
CREATE INDEX idx_items_merged_into ON wms.items(merged_into_item_id) WHERE merged_into_item_id IS NOT NULL;

COMMIT;
