-- =============================================================================
-- BFC24 WMS v2 — Migration 059: Частичная оплата счёта
--
-- Раньше billing.invoices.status умел только 'оплачен целиком' (paid) или
-- 'не оплачен' (sent) — суммы нигде не было. Реальный случай (08.09.2026,
-- клиент оплатил счёт частями: 100 000 сейчас, остаток 15 числа) показал, что
-- этого недостаточно — отметить счёт "оплачен" рано, а оставить "выставлен"
-- значит потерять из виду уже полученные деньги в балансе клиента.
--
-- Решение: append-only журнал фактических поступлений (invoice_payments, тот
-- же паттерн, что stock_movements/print_jobs — история, а не перезаписываемое
-- поле), плюс денормализованная сумма paid_amount на самом счёте (пересчёт
-- при каждой вставке/удалении строки в invoice_payments, см.
-- billing.service.js::addInvoicePayment/deleteInvoicePayment). Статус счёта
-- (draft/sent/paid/cancelled) не расширяется новым значением "частично
-- оплачен" — вместо этого paid_amount сравнивается с total_amount, а status
-- переключается в 'paid' автоматически, когда сумма оплат достигает полной
-- суммы счёта. Так все существующие места, читающие invoices.status
-- ('paid'/'sent'), продолжают работать без изменений.
-- =============================================================================
BEGIN;

ALTER TABLE billing.invoices
  ADD COLUMN paid_amount NUMERIC(14,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN billing.invoices.paid_amount IS
  'Сумма фактически полученных оплат (может быть частичной, накапливается из billing.invoice_payments). status переключается в paid автоматически, когда paid_amount достигает total_amount.';

CREATE TABLE billing.invoice_payments (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   INT           NOT NULL REFERENCES platform.tenants(id),
  invoice_id  BIGINT        NOT NULL REFERENCES billing.invoices(id),
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  paid_at     DATE          NOT NULL,
  comment     TEXT,
  created_by  INT REFERENCES wms.users(id),
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_invoice_payments_invoice ON billing.invoice_payments(invoice_id);
CREATE INDEX idx_invoice_payments_tenant  ON billing.invoice_payments(tenant_id, paid_at);

COMMENT ON TABLE billing.invoice_payments IS
  'Журнал фактических поступлений оплат по счетам (частичная оплата, задача 08.09.2026) — append-only. billing.invoices.paid_amount пересчитывается при каждой вставке/удалении строки здесь.';

COMMIT;
