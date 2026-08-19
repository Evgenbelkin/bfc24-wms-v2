-- =============================================================================
-- BFC24 WMS v2 — Migration 040: покрытие приёмки актом + управляемая передача
-- клиенту.
-- =============================================================================
-- Два независимых, но связанных изменения:
--
-- 1) wms.receiving_tasks.act_id — раньше акт был просто "снимком" строк на
--    момент формирования (см. 032), без обратной связи на конкретные строки
--    приёмки. Из-за этого нельзя было программно проверить "все ли фактически
--    принятые позиции уже покрыты актом" - приёмщик мог забыть сформировать
--    акт, и это никак не всплывало. Теперь при создании акта помечаем
--    покрытые им receiving_tasks, и дальше можно спросить "есть ли непокрытые
--    приёмки по этому клиенту" одним запросом.
--
-- 2) wms.acceptance_acts.shared_with_client_at/by — акты формируются
--    исключительно для внутреннего использования склада, клиент их видеть по
--    умолчанию не должен. Сотрудник склада явно нажимает "Передать клиенту" -
--    только тогда акт становится виден в личном кабинете (см.
--    server/src/modules/seller/seller.router.js).
-- =============================================================================

BEGIN;

ALTER TABLE wms.receiving_tasks
  ADD COLUMN IF NOT EXISTS act_id BIGINT REFERENCES wms.acceptance_acts(id);

CREATE INDEX IF NOT EXISTS idx_receiving_tasks_uncovered
  ON wms.receiving_tasks(tenant_id, client_id)
  WHERE act_id IS NULL;

ALTER TABLE wms.acceptance_acts
  ADD COLUMN IF NOT EXISTS shared_with_client_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS shared_with_client_by INT REFERENCES wms.users(id);

COMMIT;
