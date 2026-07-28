-- =============================================================================
-- BFC24 WMS v2 — Migration 023: Чек-ин сотрудников по QR на складе
-- =============================================================================
-- Идея: складские роли (receiver/picker/packer/shipper/inventory_manager)
-- обязаны "отметиться" сканом QR-кода, который показывается на экране у
-- старшего смены и меняется каждые ~90 секунд. Отметка действует ограниченное
-- время (см. CHECKIN_VALID_HOURS в server/src/middleware/requireCheckedIn.js),
-- после чего сотруднику снова нужно отсканировать код, чтобы продолжить
-- работать с приёмкой/сборкой/упаковкой/отгрузкой/перемещением/инвентаризацией.
--
-- Сам QR-токен НЕ хранится в БД вообще (см. server/src/utils/checkinToken.js —
-- HMAC-подпись с истечением по времени, тот же принцип, что и agentKey.js для
-- printer-agent) — здесь хранится только ФАКТ последней успешной отметки,
-- по одной строке на сотрудника, ровно как wms.employee_active_station для
-- рабочих мест (миграция 017) — та же зарекомендовавшая себя схема.
-- =============================================================================

BEGIN;

CREATE TABLE wms.employee_checkins (
  employee_id   INT NOT NULL PRIMARY KEY REFERENCES wms.users(id),
  tenant_id     INT NOT NULL REFERENCES platform.tenants(id),
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_employee_checkins_tenant ON wms.employee_checkins(tenant_id);

COMMIT;
