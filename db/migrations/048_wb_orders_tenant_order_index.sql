-- =============================================================================
-- BFC24 WMS v2 — Migration 048: индекс под джойн стикера ВБ в отчётах "Честный знак"
-- =============================================================================
-- Контекст: в getShippedReport/getCodesJournal (marking.service.js) добавлен
-- LEFT JOIN LATERAL на wms.wb_orders по (tenant_id, wb_order_id), чтобы вывести
-- в журнал/отчёт готовый стикер ВБ (wb_sticker_code), уже привязанный к коду
-- "Честный знак" через wms.marking_codes.wb_order_id. Раньше у wb_orders был
-- индекс только по (mp_account_id, wb_order_id) (уникальный) и отдельно по
-- tenant_id — под выборку "конкретный заказ этого тенанта по wb_order_id" без
-- знания mp_account_id индекса не было.
-- =============================================================================

BEGIN;

CREATE INDEX IF NOT EXISTS idx_wb_orders_tenant_order
  ON wms.wb_orders(tenant_id, wb_order_id);

COMMIT;
