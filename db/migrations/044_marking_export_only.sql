-- =============================================================================
-- BFC24 WMS v2 — Migration 044: Честный знак — режим "выгрузка вместо отправки в WB"
-- =============================================================================
-- Контекст (обсуждено с пользователем): у клиента-производителя один общий
-- пул товаров и кодов "Честный знак", но продажи идут через несколько разных
-- ИП на Wildberries. Право собственности на код в самом "Честном знаке"
-- передаётся с производителя на нужное ИП ОТДЕЛЬНЫМ процессом (обычно через
-- ЭДО-инструмент вроде "Тотал Марк"), а не автоматически. Если WMS в момент
-- упаковки сразу шлёт код в WB (см. marking.consumeScannedCodeAtPacking →
-- PUT .../orders/{orderId}/meta/sgtin), а передача права ещё не прошла —
-- WB может не принять код (проверка занимает от секунд до нескольких минут).
--
-- Решение: рубильник на клиенте (settings.marking_wb_submit_disabled, JSONB —
-- миграция не нужна, колонка уже есть) — при включённом рубильнике код всё
-- равно ОБЯЗАТЕЛЬНО сканируется на упаковке (для привязки физической единицы
-- к заказу), но НЕ отправляется в WB API. Такие коды помечаются новым
-- статусом 'export_only' вместо 'sent' — дальше по ним делается выгрузка по
-- конкретной поставке (см. marking.router.js GET /export), которую клиент
-- сам заводит в Тотал Марк/Честный знак, а после этого может (при желании)
-- вручную привязать код в кабинете WB как обычно.
-- =============================================================================

BEGIN;

-- CHECK был добавлен инлайново в 028_marking_scan_mode.sql без явного имени
-- constraint'а — Postgres в этом случае сам называет его по конвенции
-- "<table>_<column>_check". Находим и пересоздаём динамически, а не по
-- жёстко зашитому имени, чтобы не сломаться, если имя вдруг окажется другим.
DO $$
DECLARE
  con_name text;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'wms.marking_codes'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%wb_submit_status%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE wms.marking_codes DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

ALTER TABLE wms.marking_codes
  ADD CONSTRAINT marking_codes_wb_submit_status_check
  CHECK (wb_submit_status IN ('sent', 'manual_override', 'export_only'));

-- Быстрый поиск "коды, готовые к выгрузке по поставке" (used_ref_type='packing',
-- используется в GET /marking/export).
CREATE INDEX IF NOT EXISTS idx_marking_codes_export_only
  ON wms.marking_codes(tenant_id, used_ref_type, used_ref_id)
  WHERE wb_submit_status = 'export_only';

COMMIT;
