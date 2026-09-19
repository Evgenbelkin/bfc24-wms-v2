-- =============================================================================
-- BFC24 WMS v2 — Migration 068: кэш scanDt чужих поставок WB
-- =============================================================================
-- Владелец, 19.09.2026 (отчёт "Эффективность складов WB"): "мне важна
-- информация как быстро работают другие склады". Метрика "до ворот ВБ" для
-- складов, которые обрабатывает не наш тенант, в принципе не считалась —
-- wms.shipments.wb_accepted_at заполняется ТОЛЬКО для поставок, которые мы
-- сами формируем (см. wb.router.js addOrdersToSupply). Для чужих поставок
-- supplyId нам вообще неизвестен (WB не отдаёт его через /orders/new заранее
-- собранным заказам, а wo.wb_supply_id мы проставляем только сами себе).
--
-- Решение: WB отдаёт список ВСЕХ поставок аккаунта (не только созданных
-- нами) через GET /api/v3/supplies, включая scanDt (см. wbClient.listSupplies,
-- dev.wildberries.ru раздел "Get a Supplies List"). Джоба
-- jobs/wbForeignSupplySync.js периодически обходит этот список, для новых
-- ЧУЖИХ закрытых поставок (которых нет в wms.shipments) через
-- GET /api/marketplace/v3/supplies/{id}/order-ids узнаёт состав и кладёт
-- результат сюда + backfill'ит wo.wb_supply_id (только там, где он ещё NULL -
-- свою разметку не трогаем).
--
-- Специально ОТДЕЛЬНАЯ таблица, а не переиспользование wms.shipments: та
-- таблица завязана на наш собственный жизненный цикл поставки (status,
-- client_id NOT NULL и т.д. - предположение "это НАША поставка" зашито по
-- всему остальному коду), пихать туда чужие поставки - source of bugs.
-- =============================================================================

BEGIN;

CREATE TABLE wms.wb_foreign_supplies (
  id             SERIAL PRIMARY KEY,
  tenant_id      INT     NOT NULL REFERENCES platform.tenants(id),
  mp_account_id  INT     NOT NULL REFERENCES wms.mp_accounts(id) ON DELETE CASCADE,
  supply_id      TEXT    NOT NULL,               -- "WB-GI-1234567", формат WB
  scan_dt        TIMESTAMPTZ,                     -- момент скана QR на приёмке (может быть NULL, если поставка ещё не принята)
  done           BOOLEAN NOT NULL DEFAULT FALSE,  -- поставка закрыта (по данным WB)
  orders_synced  BOOLEAN NOT NULL DEFAULT FALSE,  -- уже сходили за order-ids и проставили wb_supply_id заказам
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mp_account_id, supply_id)
);

CREATE INDEX idx_wb_foreign_supplies_account ON wms.wb_foreign_supplies(mp_account_id);

COMMIT;
