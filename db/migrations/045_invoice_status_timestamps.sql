BEGIN;

-- Метки времени переходов статуса счёта — нужны для графика динамики
-- "выставлено / оплачено / неоплачено" (billing.html). Раньше единственная
-- временная метка была updated_at, которая перезатирается любым изменением
-- статуса, так что нельзя было отдельно узнать "когда выставили" и "когда
-- оплатили" для уже давно созданных инвойсов.
ALTER TABLE billing.invoices
  ADD COLUMN sent_at TIMESTAMPTZ,
  ADD COLUMN paid_at TIMESTAMPTZ;

-- Backfill для уже существующих счетов: точных дат переходов у нас нет,
-- используем updated_at как лучшее доступное приближение (для большинства
-- счетов статус меняется вручную почти сразу после создания/оплаты, так что
-- искажение небольшое, а график не будет пустым для старых данных).
UPDATE billing.invoices SET sent_at = updated_at WHERE status IN ('sent','paid') AND sent_at IS NULL;
UPDATE billing.invoices SET paid_at = updated_at WHERE status = 'paid' AND paid_at IS NULL;

CREATE INDEX idx_invoices_sent_at ON billing.invoices(tenant_id, sent_at) WHERE sent_at IS NOT NULL;
CREATE INDEX idx_invoices_paid_at ON billing.invoices(tenant_id, paid_at) WHERE paid_at IS NOT NULL;

COMMIT;
