-- =============================================================================
-- BFC24 WMS v2 — Migration 057: Ozon Catalog (справочник товаров)
--
-- Аналог wms.wb_items из 008_wb_integration.sql, но под Ozon: карточка товара
-- (offer_id) с фото и габаритами, подтягивается отдельным шагом "Импортировать
-- карточки", независимым от прихода заказов — как и "Справочник WB" на
-- аналогичном экране Wildberries (задача #78, начата 07.09.2026 по просьбе
-- клиента: нужны габариты и фото товара, "всё по аналогии с ВБ").
--
-- ВАЖНО про поля high/width/depth/weight/preview_url: их реальная форма в
-- ответе Ozon /v3/product/info/list ещё НЕ подтверждена живым запросом (в
-- отличие от barcodes[], который уже проверен на реальном товаре в задаче
-- #77) — по документации Ozon это top-level поля height/width/depth (в
-- dimension_unit, обычно "mm") и weight/weight_unit (обычно "g"), а фото —
-- primary_image/images[]. Поэтому raw JSONB хранит ответ Ozon целиком:
-- если реальные имена полей окажутся другими, повторный импорт с
-- исправленным парсингом ничего не потеряет — просто перечитает raw.
-- =============================================================================
BEGIN;

CREATE TABLE wms.ozon_items (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           INT         NOT NULL REFERENCES platform.tenants(id),
  mp_account_id       INT         NOT NULL REFERENCES wms.mp_accounts(id) ON DELETE CASCADE,
  offer_id            TEXT        NOT NULL,   -- артикул продавца — то же значение, что и в ozon_posting_items
  ozon_product_id      BIGINT,
  ozon_sku             BIGINT,
  name                TEXT,
  preview_url         TEXT,
  length_cm           NUMERIC(8,2),
  width_cm            NUMERIC(8,2),
  height_cm           NUMERIC(8,2),
  weight_grams        INT,
  raw                 JSONB,                  -- полный ответ Ozon product/info/list по этой карточке — см. комментарий выше
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mp_account_id, offer_id)
);

CREATE INDEX idx_ozon_items_tenant   ON wms.ozon_items(tenant_id);
CREATE INDEX idx_ozon_items_account  ON wms.ozon_items(mp_account_id);
CREATE INDEX idx_ozon_items_offer_id ON wms.ozon_items(mp_account_id, offer_id);

COMMIT;
