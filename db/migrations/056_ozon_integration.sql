-- =============================================================================
-- BFC24 WMS v2 — Migration 056: Ozon Integration (staging tables)
--
-- Аналог 008_wb_integration.sql, но под модель данных Ozon Seller API (FBS).
-- Ключевое архитектурное отличие от WB, подтверждённое живым тестовым запросом
-- к v3/posting/fbs/list (07.09.2026, задача #72): у Ozon НЕТ понятия "поставка"
-- (WB'шный createSupply/addOrdersToSupply) как отдельного шага перед сборкой —
-- единица группировки заказа сразу "отправление" (posting_number), и оно же
-- станет external_id в wms.shipments напрямую, без промежуточного контейнера.
--
-- Ozon группирует НЕСКОЛЬКО товарных позиций (products[]) в одном отправлении
-- (в отличие от WB, где wms.wb_orders — уже одна строка на единицу товара) —
-- поэтому здесь два уровня: заголовок отправления (ozon_postings) и позиции
-- (ozon_posting_items), последние станут заготовкой для wms.picking_tasks
-- (1 позиция посылки = 1 задача на сборку, как и у WB).
--
-- barcode на позиции сознательно NULLABLE — в ответе posting.products только
-- offer_id (артикул продавца) и sku (внутренний id Ozon), самого штрихкода там
-- нет. Резолвится отдельным шагом через product-info API Ozon (нужна отдельная
-- роль токена, "Цены и остатки"/"Товары" — ещё не получена на момент этой
-- миграции, шаг синка добавится отдельно после проверки на живых данных).
-- =============================================================================
BEGIN;

-- Отправления Ozon FBS (кэш синхронизации, до формирования волны)
CREATE TABLE wms.ozon_postings (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           INT         NOT NULL REFERENCES platform.tenants(id),
  mp_account_id       INT         NOT NULL REFERENCES wms.mp_accounts(id),
  posting_number      TEXT        NOT NULL,   -- "19317429-0178-1"
  order_id            BIGINT      NOT NULL,
  order_number        TEXT,                   -- "19317429-0178" — общий для всех posting'ов multibox-заказа
  parent_posting_number TEXT,                 -- заполнено, если это часть multibox-разбивки
  status              TEXT        NOT NULL,   -- awaiting_packaging | awaiting_deliver | delivering | delivered | cancelled | ...
  substatus           TEXT,
  warehouse_id        BIGINT,
  warehouse_name      TEXT,
  tpl_provider        TEXT,                   -- служба доставки ("Доставка Ozon" и т.п.)
  shipment_date        TIMESTAMPTZ,           -- дедлайн отгрузки (аналог cutoff у WB)
  in_process_at        TIMESTAMPTZ,
  tracking_number      TEXT,
  ozon_shipment_id      TEXT,                 -- зарезервировано под будущую группировку на отгрузку/акт (аналог wb_supply_id) — пока не используется
  wms_shipment_code     TEXT,                 -- проставляется при "Сформировать волну" — по нему находим уже созданный wms.shipments
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw                 JSONB,
  UNIQUE (mp_account_id, posting_number)
);

CREATE INDEX idx_ozon_postings_tenant  ON wms.ozon_postings(tenant_id);
CREATE INDEX idx_ozon_postings_account ON wms.ozon_postings(mp_account_id);
CREATE INDEX idx_ozon_postings_status  ON wms.ozon_postings(mp_account_id, status);
CREATE INDEX idx_ozon_postings_wave    ON wms.ozon_postings(mp_account_id, wms_shipment_code) WHERE wms_shipment_code IS NOT NULL;

-- Товарные позиции внутри отправления
CREATE TABLE wms.ozon_posting_items (
  id                  BIGSERIAL PRIMARY KEY,
  tenant_id           INT         NOT NULL REFERENCES platform.tenants(id),
  posting_id          BIGINT      NOT NULL REFERENCES wms.ozon_postings(id) ON DELETE CASCADE,
  offer_id            TEXT        NOT NULL,   -- артикул продавца
  sku                 BIGINT,                 -- внутренний id товара у Ozon
  barcode             TEXT,                   -- резолвится отдельным шагом синка (см. комментарий выше), пока может быть NULL
  item_name           TEXT,
  qty                 INT         NOT NULL DEFAULT 1,
  price               NUMERIC(14,2),
  currency_code       TEXT,
  requires_marking    BOOLEAN     NOT NULL DEFAULT FALSE,  -- из requirements.products_requiring_mandatory_mark посылки

  CONSTRAINT ozon_posting_items_qty_positive CHECK (qty > 0)
);

CREATE INDEX idx_ozon_posting_items_tenant  ON wms.ozon_posting_items(tenant_id);
CREATE INDEX idx_ozon_posting_items_posting ON wms.ozon_posting_items(posting_id);
CREATE INDEX idx_ozon_posting_items_barcode ON wms.ozon_posting_items(barcode) WHERE barcode IS NOT NULL;

-- Регистрируем модуль в каталоге (по аналогии с wb_integration, см.
-- 001_initial_platform.sql) — выключен по умолчанию (is_core=FALSE), включать
-- по тенанту отдельно через platform.tenant_modules, так же как wb_integration.
INSERT INTO platform.modules (module_code, module_name, description, is_core)
VALUES ('ozon_integration', 'Ozon Integration', 'Интеграция с Ozon', FALSE)
ON CONFLICT (module_code) DO NOTHING;

COMMIT;
