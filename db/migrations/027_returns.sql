-- =============================================================================
-- BFC24 WMS v2 — Migration 027: Возвраты товара
-- =============================================================================
-- Реальный процесс (со слов клиента): товар клиента возвращается на ПВЗ
-- маркетплейса, фулфилмент забирает его и везёт на свой склад, там
-- проверяют/переупаковывают и СРАЗУ ЖЕ (в один шаг) решают: обратно в продажу
-- (возвращается в остатки) или в утиль (списание, в остатки не идёт).
--
-- wms.returns — единый источник истины по возвратам (и для админки, и для
-- кабинета клиента): один товар/кол-во/решение за одну регистрацию.
-- Если disposition='resale' — соответствующее движение остатков пишется через
-- уже существующий wms.stock_movements (movement_type='return', см. миграцию
-- 004_stock_ledger.sql, где это значение enum уже было зарезервировано, но
-- никогда не использовалось) + wms.stock_balances растут как при обычной
-- приёмке. Если disposition='writeoff' — остатки НЕ трогаем, это просто факт
-- для отчётности (сколько списано брака), сам товар физически на склад как
-- проданный уже не возвращается.
--
-- Начисление клиенту за обработку возврата переиспользует уже существующий
-- billing.service_type='returns' (он был заведён в 009_analytics_audit_billing.sql
-- как значение enum "про запас", но ни разу не начислялся) — здесь просто
-- начинаем реально его использовать через billing.service.js:chargeForOperation.
-- =============================================================================

BEGIN;

CREATE TABLE wms.returns (
  id                    BIGSERIAL PRIMARY KEY,
  tenant_id             INT     NOT NULL REFERENCES platform.tenants(id),
  warehouse_id          INT     NOT NULL REFERENCES wms.warehouses(id),
  client_id             INT     NOT NULL REFERENCES wms.clients(id),
  item_id               INT     REFERENCES wms.items(id),
  barcode               TEXT    NOT NULL,
  qty                   NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  disposition           TEXT    NOT NULL CHECK (disposition IN ('resale', 'writeoff')),
  marketplace_order_no  TEXT,                          -- номер заказа WB/Ozon, если известен
  location_id           INT     REFERENCES wms.locations(id),   -- куда положили при disposition='resale'
  location_code         TEXT,
  charge_id             BIGINT  REFERENCES billing.service_charges(id),  -- начисление клиенту за обработку
  received_by           INT     REFERENCES wms.users(id),
  comment               TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_returns_tenant_created ON wms.returns(tenant_id, created_at DESC);
CREATE INDEX idx_returns_client         ON wms.returns(tenant_id, client_id, created_at DESC);

INSERT INTO platform.modules (module_code, module_name, description, is_core) VALUES
  ('returns', 'Returns', 'Учёт возвратов товара (приёмка на складе, решение продажа/утиль)', FALSE)
ON CONFLICT (module_code) DO NOTHING;

INSERT INTO platform.tenant_modules (tenant_id, module_code)
SELECT id, 'returns' FROM platform.tenants
ON CONFLICT (tenant_id, module_code) DO NOTHING;

COMMIT;
