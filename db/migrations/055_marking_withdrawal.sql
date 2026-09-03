-- =============================================================================
-- BFC24 WMS v2 — Migration 055: Вывод из оборота "Честный знак" (проданные товары)
-- =============================================================================
-- Контекст (обсуждено с пользователем 04.09.2026): у селлеров большая проблема
-- с выводом из оборота КИЗ на реально проданные (выкупленные) товары. Нужен
-- отчёт "код КИЗ + штрихкод товара + дата продажи" для передачи в Total Mark
-- (сначала выгрузкой файла, позже — по API).
--
-- Два новых требования, которые определили схему:
--   1. "Только реально выкупленное" — не просто отгруженное. Признак —
--      wms.wb_order_status_events.wb_status='sold' (тот же источник, что уже
--      используется для % выкупа в FBS-аналитике, см. fbsAnalytics.service.js).
--   2. Явный журнал: "что уже выводили, а что нет" — БЕЗ возможности
--      редактирования задним числом. Поэтому не просто статус на коде, а
--      отдельная неизменяемая таблица "шапка выгрузки" + "снимок строк"
--      (снимок - потому что если товар потом переименуют в справочнике,
--      исторический файл выгрузки должен остаться таким, каким был отправлен
--      реально, а не "поехать" вслед за текущими данными).
--
-- Нагрузка: у некоторых клиентов до ~20 000 заказов/сутки, миллионы кодов за
-- историю (см. комментарий в 047_marking_codes_report_indexes.sql). Кода,
-- уже помеченного withdrawal_status='exported', ежедневная выборка больше
-- никогда не касается - частичный индекс ниже держит рабочий набор маленьким
-- независимо от объёма истории.
-- =============================================================================

BEGIN;

-- "Шапка" выгрузки — одна запись = один клик "Выгрузить" или один прогон
-- ночного крона.
CREATE TABLE wms.marking_withdrawal_exports (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   INT NOT NULL REFERENCES platform.tenants(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  INT REFERENCES wms.users(id),      -- NULL = сформировано ночным кроном, не человеком
  source      TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'cron')),
  row_count   INT NOT NULL DEFAULT 0
);

CREATE INDEX idx_marking_withdrawal_exports_tenant
  ON wms.marking_withdrawal_exports(tenant_id, created_at DESC);

-- Строки конкретной выгрузки — ЗАСТЫВШИЙ снимок данных на момент выгрузки
-- (не ссылка на текущие marking_codes/items/wb_orders), плюс marking_code_id
-- для обратной трассировки "в какой выгрузке ушёл этот код". Ничего в этой
-- таблице не апдейтится и не удаляется после вставки - только INSERT.
CREATE TABLE wms.marking_withdrawal_export_items (
  id               BIGSERIAL PRIMARY KEY,
  export_id        BIGINT NOT NULL REFERENCES wms.marking_withdrawal_exports(id),
  tenant_id        INT NOT NULL REFERENCES platform.tenants(id),
  marking_code_id  BIGINT NOT NULL REFERENCES wms.marking_codes(id),
  code             TEXT NOT NULL,
  item_barcode     TEXT,
  item_name        TEXT,
  vendor_code      TEXT,
  size             TEXT,
  sold_at          TIMESTAMPTZ,
  wb_order_id      BIGINT,
  shipment_code    TEXT,
  client_name      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_marking_withdrawal_export_items_export
  ON wms.marking_withdrawal_export_items(export_id);

-- Обратная трассировка "по коду - в какую выгрузку он ушёл" (для журнала/поиска).
CREATE INDEX idx_marking_withdrawal_export_items_code
  ON wms.marking_withdrawal_export_items(marking_code_id);

-- Флаг на самом коде — быстрый способ отфильтровать "ещё не выводили" без
-- обращения к таблицам выгрузок. Единственное допустимое значение сейчас -
-- 'exported' (просто факт "попал хотя бы в одну выгрузку"); 'confirmed'
-- (реальное подтверждение от Total Mark по API) сознательно не заводим
-- сейчас - взять неоткуда, кроме как руками, добавим отдельной миграцией
-- вместе с самой API-интеграцией.
ALTER TABLE wms.marking_codes
  ADD COLUMN withdrawal_status TEXT CHECK (withdrawal_status IN ('exported')),
  ADD COLUMN withdrawal_exported_at TIMESTAMPTZ,
  ADD COLUMN withdrawal_export_id BIGINT REFERENCES wms.marking_withdrawal_exports(id);

-- Горячий путь: "код использован (used), привязан к заказу WB, ещё не
-- выводили" - именно эту выборку каждый день (руками или кроном) должен
-- быстро находить сервис, независимо от объёма истории в таблице.
CREATE INDEX idx_marking_codes_withdrawal_pending
  ON wms.marking_codes(tenant_id, id)
  WHERE status = 'used' AND withdrawal_status IS NULL AND wb_order_id IS NOT NULL;

COMMIT;
