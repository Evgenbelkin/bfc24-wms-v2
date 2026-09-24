-- =============================================================================
-- BFC24 WMS v2 — Migration 074: marking_withdrawal_export_items.sale_price
-- =============================================================================
-- ФИКС 24.09.2026 (запрос владельца: для отчёта "вывод из оборота" Честный
-- знак для FBS требует цену, по которой был оформлен заказ в кабинете
-- маркетплейса - см. markirovka.ru). Раньше в выгрузке этой колонки не было
-- вообще. Добавляем sale_price (рубли, с копейками) - заполняется из
-- wms.wb_orders.converted_price / 100 в момент формирования выгрузки
-- (marking.service.js::getPendingWithdrawal/createWithdrawalExport).
-- =============================================================================

BEGIN;

ALTER TABLE wms.marking_withdrawal_export_items ADD COLUMN sale_price NUMERIC(14,2);

COMMIT;
