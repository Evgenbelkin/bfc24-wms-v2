-- =============================================================================
-- BFC24 WMS v2 — Migration 051: реальный статус заказа на стороне WB (wbStatus)
-- =============================================================================
-- До сих пор wms.wb_orders.status - это НАШ локальный жизненный цикл
-- (new->confirm->shipped/external->cancel), а реальный статус WB (wbStatus:
-- waiting/sorted/sold/canceled/canceled_by_client/declined_by_client/defect,
-- см. POST /api/v3/orders/status) нигде не хранился - использовался "на лету"
-- в syncDeliveryStatusForTenant и сразу выбрасывался. Это первая часть
-- FBS-аналитики (сводка по статусам заказов, по образцу TrueStats) - без
-- сохранённого wbStatus посчитать "Выкуплено"/"Отменено"/"В пути" нельзя.
-- =============================================================================

BEGIN;

ALTER TABLE wms.wb_orders
  ADD COLUMN IF NOT EXISTS wb_status TEXT,
  ADD COLUMN IF NOT EXISTS wb_status_updated_at TIMESTAMPTZ;

-- (tenant_id, created_at DESC) уже есть - idx_wb_orders_tenant_created (018)
CREATE INDEX IF NOT EXISTS idx_wb_orders_wbstatus ON wms.wb_orders(tenant_id, wb_status);

COMMIT;
