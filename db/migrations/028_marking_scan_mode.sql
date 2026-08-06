-- =============================================================================
-- BFC24 WMS v2 — Migration 028: Честный знак — режим "клиент маркирует сам"
-- =============================================================================
-- Контекст (обсуждено с пользователем): часть клиентов переходит с FBO на FBS
-- и сами клеят DataMatrix на товар ещё на производстве, до отправки на ФФ.
-- Для таких товаров ФФ не печатает и не выделяет коды из своего пула — вместо
-- этого:
--   - на приёмке сканируется УЖЕ существующий на товаре код DataMatrix и
--     регистрируется в пул как 'available' (жёсткая блокировка приёмки без
--     скана — как и раньше для печатного режима);
--   - на сборке FBS-заказа упаковщик сканирует ШК товара И DataMatrix именно
--     той физической единицы, что кладёт в заказ — код сверяется с пулом,
--     помечается 'used' и ОТПРАВЛЯЕТСЯ В WB через PUT /api/v3/orders/{orderId}
--     /meta/sgtin (замена ручного ввода кода в кабинете WB на сборке).
--
-- wms.items.marking_mode различает эти два режима на уровне товара:
--   'print' — как раньше: ФФ печатает стикер из своего пула кодов.
--   'scan'  — новый: код уже на товаре, ФФ только сканирует и отправляет в WB.
--
-- wms.marking_codes расширяется полями отправки в WB и аварийного обхода
-- (супервайзер может провести упаковку без успешной отправки в WB, если API
-- недоступен — жёсткая блокировка иначе может подвесить всю волну сборки).
-- =============================================================================

BEGIN;

ALTER TABLE wms.items
  ADD COLUMN marking_mode TEXT NOT NULL DEFAULT 'print'
    CHECK (marking_mode IN ('print', 'scan'));

ALTER TABLE wms.marking_codes
  ADD COLUMN source TEXT NOT NULL DEFAULT 'import'
    CHECK (source IN ('import', 'scanned')),
  ADD COLUMN wb_order_id BIGINT,
  ADD COLUMN wb_submit_status TEXT
    CHECK (wb_submit_status IN ('sent', 'manual_override')),
  ADD COLUMN wb_submitted_at TIMESTAMPTZ,
  ADD COLUMN wb_override_reason TEXT,
  ADD COLUMN wb_override_by INT REFERENCES wms.users(id);

-- Список "требует ручной привязки КИЗ в кабинете WB" — коды, упакованные в
-- обход отправки супервайзером из-за недоступности WB API.
CREATE INDEX idx_marking_codes_manual_override ON wms.marking_codes(tenant_id, item_id, used_at)
  WHERE wb_submit_status = 'manual_override';

COMMIT;
