-- =============================================================================
-- BFC24 WMS v2 — Migration 071: "Поставки Дефициты"
-- =============================================================================
-- 20-21.09.2026 (обсуждение с владельцем): сборщик жмёт "Пропустить", если
-- остатка товара реально нет нигде на складе (см. picking.service.js::skipTask,
-- карантин + попытка найти альтернативную ячейку) — вместо того чтобы просто
-- держать задачу 'skipped' и тормозить закрытие исходной поставки ВБ, заказ
-- физически переносится в отдельную "копящуюся" поставку ВБ "Дефициты" тем же
-- самым методом addOrdersToSupply, которым мы и так добавляем заказы в
-- обычные поставки — согласно официальной доке ВБ
-- (dev.wildberries.ru/en/openapi/orders-fbs, "Add Assembly Orders to the
-- Supply"): "It can also move the assembly orders between active supplies" —
-- WB сам открепляет заказ от старой поставки. Работает только пока исходная
-- поставка ещё активна (не сдана в доставку), что для skip во время сборки
-- всегда так.
--
-- У ВБ поставка при первом добавленном заказе фиксирует тип упаковки
-- (cargoType) — так что в теории на один склад назначения может понадобиться
-- больше одной "копящейся" поставки Дефициты (если WB отклонит перенос из-за
-- несовпадения типа). Этот случай пока не считаем частым и обрабатываем как
-- уже обрабатывается похожая ситуация в generate-wave (extractRejectedOrderIds) —
-- заявка на второй проход, если понадобится, а не блокировка первой версии.
--
-- Одна "копящаяся" (status='accumulating') поставка на (аккаунт, склад ВБ) —
-- гарантируется частичным уникальным индексом ниже. Когда её "запускают на
-- сборку" (см. будущий роут /wb/deficit-supplies/:id/launch), статус
-- переходит в 'in_wave' и тут же заводится новая "копящаяся" под тот же
-- склад, чтобы дальнейшие skip'ы было куда складывать.
-- =============================================================================
BEGIN;

CREATE TABLE wms.wb_deficit_supplies (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       INT         NOT NULL REFERENCES platform.tenants(id),
  mp_account_id   INT         NOT NULL REFERENCES wms.mp_accounts(id) ON DELETE CASCADE,
  warehouse_id    BIGINT      NOT NULL,  -- ID склада назначения в ВБ (как o.warehouse_id в wms.wb_orders)
  warehouse_name  TEXT,
  supply_code     TEXT        NOT NULL,  -- WB-GI-XXXXX
  status          TEXT        NOT NULL DEFAULT 'accumulating'
                    CHECK (status IN ('accumulating','in_wave','delivered')),
  shipment_code   TEXT,        -- = supply_code (нормализованный), заполняется при запуске в волну
  orders_count    INT         NOT NULL DEFAULT 0,  -- кэш для списка в UI; источник истины — wms.wb_orders.wb_supply_id
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  launched_at     TIMESTAMPTZ,
  launched_by     INT         REFERENCES wms.users(id),
  UNIQUE (mp_account_id, supply_code)
);

CREATE INDEX idx_wb_deficit_supplies_tenant  ON wms.wb_deficit_supplies(tenant_id);
CREATE INDEX idx_wb_deficit_supplies_account ON wms.wb_deficit_supplies(mp_account_id, warehouse_id);

-- Ровно одна "копящаяся" поставка на (аккаунт, склад) одновременно.
CREATE UNIQUE INDEX idx_wb_deficit_supplies_one_accumulating
  ON wms.wb_deficit_supplies(mp_account_id, warehouse_id)
  WHERE status = 'accumulating';

-- Привязка исходной пропущенной задачи к тому, в какую поставку Дефициты её
-- унесло — чисто для истории/UI ("эта задача была перенесена в Дефициты №X"),
-- на сам механизм переноса не влияет (та задача уже 'skipped' и не участвует
-- в прогрессе исходной волны — см. skipTask, remaining-запрос уже исключает
-- skipped).
ALTER TABLE wms.picking_tasks
  ADD COLUMN IF NOT EXISTS moved_to_deficit_supply_id BIGINT REFERENCES wms.wb_deficit_supplies(id),
  ADD COLUMN IF NOT EXISTS deficit_moved_at TIMESTAMPTZ;

COMMIT;
