BEGIN;

-- Гейт "нельзя выйти без акта" (миграция 040) смотрит на receiving_tasks.act_id
-- IS NULL. Но у ВСЕЙ приёмки, случившейся ДО включения этой фичи, act_id тоже
-- NULL (колонка добавлена задним числом) - и гейт требовал бы задним числом
-- сформировать акты на месяцы истории. Это не нужно: прощаем весь такой
-- "хвост" один раз при накатке миграции, дальше act_exempt по умолчанию
-- FALSE и вся новая приёмка обязана попадать в акт как обычно.
ALTER TABLE wms.receiving_tasks
  ADD COLUMN IF NOT EXISTS act_exempt BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE wms.receiving_tasks SET act_exempt = TRUE WHERE act_id IS NULL;

COMMIT;
