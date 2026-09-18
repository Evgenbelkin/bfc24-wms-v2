-- =============================================================================
-- BFC24 WMS v2 — Migration 047: индексы под отчёты по "Честному знаку" на больших объёмах
-- =============================================================================
-- Контекст: у некоторых клиентов ожидается до ~20 000 заказов/сутки - значит
-- millions строк в wms.marking_codes в перспективе месяцев. Новые отчёты
-- (getCodesJournal, getShippedReport - см. marking.service.js) фильтруют по
-- tenant_id + created_at/used_at и сортируют по ним же - раньше у таблицы был
-- только партиционный индекс под "доступные коды на товар" (миграция 026) и
-- пара под конкретные wb_submit_status (миграция 028/044), под общую выборку
-- "по дате, по всему тенанту" индекса не было - на большом объёме это был бы
-- последовательный скан.
-- =============================================================================

BEGIN;

CREATE INDEX IF NOT EXISTS idx_marking_codes_tenant_created
  ON wms.marking_codes(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_marking_codes_tenant_used_at
  ON wms.marking_codes(tenant_id, used_at DESC)
  WHERE used_at IS NOT NULL;

COMMIT;
