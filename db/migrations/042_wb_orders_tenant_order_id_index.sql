BEGIN;

-- Карточка отгрузки (shipping.service.js getShipmentDetails) джойнит
-- wms.wb_orders по (tenant_id, wb_order_id) - НЕ по (mp_account_id,
-- wb_order_id), поэтому существующий UNIQUE(mp_account_id, wb_order_id)
-- тут бесполезен: для каждой строки picking_tasks (одна на позицию сборки)
-- Postgres сканирует все заказы этого тенанта в поиске совпадения.
-- На отгрузках с десятками позиций (то есть с ростом числа складов и
-- истории заказов) это давало заметное торможение при открытии карточки.
CREATE INDEX IF NOT EXISTS idx_wb_orders_tenant_order_id
  ON wms.wb_orders(tenant_id, wb_order_id);

COMMIT;
