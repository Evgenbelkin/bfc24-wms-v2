-- =============================================================================
-- BFC24 WMS v2 — Migration 053: регион покупателя + СЦ WB на заказе
-- (для фичи "время доставки склад -> регион")
-- =============================================================================
-- Регион/область покупателя НЕ приходит в /api/v3/orders/new (address всегда
-- null в реальных ответах WB для FBS, проверено на живых данных) - но
-- присутствует в Statistics API (/api/v1/supplier/orders) под другим
-- идентификатором заказа - srid. Проверено на живых данных 30.08.2026:
-- srid ИЗ Statistics API совпадает буквально (как строка) с rid, который WB
-- уже отдаёт в /api/v3/orders/new и который мы храним внутри wb_orders.raw
-- (52 из 62 заказов сматчились напрямую в тестовом прогоне). Поэтому просто
-- добавляем rid отдельной (индексируемой) колонкой и place для полей из
-- Statistics API прямо на wb_orders - это 1:1 связь с заказом, отдельная
-- таблица не нужна.
--
-- region_name уже существует в схеме (008_wb_integration.sql) - раньше
-- ожидалось, что его будет заполнять v3 Orders API (o.regionName), но WB
-- этого не делает - колонка всегда была NULL. Переиспользуем её под данные
-- из Statistics API вместо создания дублирующей колонки.
-- =============================================================================

BEGIN;

ALTER TABLE wms.wb_orders
  ADD COLUMN IF NOT EXISTS rid                TEXT,
  ADD COLUMN IF NOT EXISTS oblast_okrug_name   TEXT,   -- федеральный округ, напр. "Приволжский федеральный округ"
  ADD COLUMN IF NOT EXISTS country_name        TEXT,
  ADD COLUMN IF NOT EXISTS wb_sc_name          TEXT,   -- склад/СЦ WB, обрабатывающий заказ (warehouseName из Statistics API - НЕ наш internal warehouse)
  ADD COLUMN IF NOT EXISTS stats_order_date    TIMESTAMPTZ, -- date из Statistics API (может отличаться от нашего created_at на секунды/минуты)
  ADD COLUMN IF NOT EXISTS stats_synced_at     TIMESTAMPTZ; -- когда в последний раз обновили эти поля из Statistics API

-- Бэкфилл rid из уже накопленного raw JSON (для заказов, синканных до этой миграции)
UPDATE wms.wb_orders SET rid = raw->>'rid' WHERE rid IS NULL AND raw ? 'rid';

CREATE INDEX IF NOT EXISTS idx_wb_orders_rid    ON wms.wb_orders(mp_account_id, rid) WHERE rid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wb_orders_region ON wms.wb_orders(tenant_id, wb_sc_name, region_name) WHERE region_name IS NOT NULL;

COMMIT;
