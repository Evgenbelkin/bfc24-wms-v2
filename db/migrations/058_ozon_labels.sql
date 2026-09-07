-- =============================================================================
-- BFC24 WMS v2 — Migration 058: Ozon labels (задача #74, печать этикеток)
--
-- Живым тестом 07.09.2026 подтверждена реальная последовательность у Ozon:
--   1) POST /v4/posting/fbs/ship — переводит отправление в статус
--      awaiting_deliver ("Ожидает отгрузки"). Тело: packages[].products[]
--      с product_id = ТОТ ЖЕ sku, что уже лежит в wms.ozon_posting_items.sku
--      (не ozon_items.ozon_product_id — с ним Ozon вернул UNKNOWN_PRODUCT_DEFINED).
--   2) Ozon просит подождать 45–60 секунд после сборки, прежде чем запрашивать
--      этикетку — иначе POST /v2/posting/fbs/package-label отвечает ошибкой
--      "next postings aren't ready". Поэтому получение PDF не может быть
--      частью того же запроса, что и сборка — нужен отдельный фоновый шаг
--      (см. server/src/jobs/ozonLabelSync.js), который опрашивает отправления
--      не раньше чем через ~55с после shipped_at.
--
-- shipped_at   — когда мы вызвали /v4/posting/fbs/ship (ставится из
--                ozon.service.js::shipPostingForShipment, дёргается из
--                packing.service.js::confirmPacking при упаковке Ozon-отгрузки).
-- label_fetched_at — когда PDF успешно получен и положен в wms.print_jobs
--                (doc_type='ozon_label'). NULL — ещё не готово/не пытались.
-- label_attempts   — счётчик попыток, чтобы не долбить Ozon бесконечно по
--                постоянно неудачным отправлениям (джоба останавливается
--                после 5 попыток и оставляет запись как есть для ручного
--                разбора).
-- =============================================================================
BEGIN;

ALTER TABLE wms.ozon_postings
  ADD COLUMN shipped_at       TIMESTAMPTZ,
  ADD COLUMN label_fetched_at TIMESTAMPTZ,
  ADD COLUMN label_attempts   SMALLINT NOT NULL DEFAULT 0;

CREATE INDEX idx_ozon_postings_label_due
  ON wms.ozon_postings(shipped_at)
  WHERE shipped_at IS NOT NULL AND label_fetched_at IS NULL;

COMMIT;
