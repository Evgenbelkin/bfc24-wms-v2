-- =============================================================================
-- BFC24 WMS v2 — Migration 052: история переходов wbStatus (для сроков/комиссии)
-- =============================================================================
-- wms.wb_orders.wb_status/wb_status_updated_at (051) хранит только ТЕКУЩИЙ
-- статус - для метрики "сколько часов прошло от создания заказа до передачи
-- в WB" (напрямую определяет скидку/наценку на комиссию WB, см. FBS-аналитику
-- фаза 2) нужен МОМЕНТ ПЕРВОГО перехода в каждый статус, а не только
-- последний известный статус. Одна строка = первое наблюдение заказа в этом
-- статусе (дальше не перезаписывается) - гранулярность ограничена частотой
-- опроса (по умолчанию раз в 30 минут, wbFbsStatusSync.js), это не точный
-- таймстемп от WB, а "когда мы это заметили".
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS wms.wb_order_status_events (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      INT    NOT NULL REFERENCES platform.tenants(id),
  mp_account_id  INT    NOT NULL REFERENCES wms.mp_accounts(id),
  wb_order_id    BIGINT NOT NULL,
  wb_status      TEXT   NOT NULL,
  observed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mp_account_id, wb_order_id, wb_status)
);

CREATE INDEX IF NOT EXISTS idx_wb_status_events_order  ON wms.wb_order_status_events(mp_account_id, wb_order_id);
CREATE INDEX IF NOT EXISTS idx_wb_status_events_tenant ON wms.wb_order_status_events(tenant_id, observed_at);

COMMIT;
