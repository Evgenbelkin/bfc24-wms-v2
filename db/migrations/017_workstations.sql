-- =============================================================================
-- BFC24 WMS v2 — Migration 017: Рабочие места (workstations)
-- =============================================================================
-- Проблема: wms.printer_routes умеет маршрутизировать печать только по
-- (tenant_id, doc_type[, client_id]) — один "маршрут по умолчанию" на весь
-- тенант. При реальном масштабе (~50 столов упаковки, несколько зон сборки,
-- несколько зон отгрузки — у КАЖДОГО своя точка со своим принтером) этого
-- недостаточно: система не знает, где физически находится сотрудник,
-- сканирующий штрихкод с телефона, и на какой из 50 принтеров печатать.
--
-- Решение: рабочее место (workstation) — это физическая точка (стол упаковки,
-- зона сборки, зона отгрузки), у которой есть свой код (печатается как
-- QR/штрихкод-стикер и клеится на стол) и свой принтер по умолчанию.
-- Сотрудник сканирует код рабочего места один раз (в начале смены или при
-- смене места) — это запоминается в wms.employee_active_station. Дальше при
-- создании print_job сначала проверяется активное рабочее место сотрудника
-- (created_by), и если у него есть свой default_printer_id — печать идёт
-- туда, БЕЗ обращения к общему printer_routes. Если рабочее место не задано
-- (сотрудник ничего не сканировал, либо склад ещё не переведён на рабочие
-- места) — используется прежняя логика printer_routes как fallback, ничего
-- не ломается для складов, которым хватает одного принтера на doc_type.
--
-- employee_active_station — намеренно отдельная лёгкая таблица, а не часть
-- JWT/сессии: токен сотрудника истекает по времени и переиздаётся, а вот на
-- каком рабочем месте он стоит — довольно стабильный факт, который не должен
-- сбрасываться при каждом релогине.
-- =============================================================================
BEGIN;

CREATE TABLE wms.workstations (
  id                SERIAL PRIMARY KEY,
  tenant_id         INT         NOT NULL REFERENCES platform.tenants(id),
  warehouse_id      INT         REFERENCES wms.warehouses(id),
  station_code      TEXT        NOT NULL,  -- печатается на физическом стикере, сканируется сотрудником
  station_name      TEXT        NOT NULL,
  zone_type         TEXT        NOT NULL DEFAULT 'packing',  -- packing | picking | shipping | inbound | other
  default_printer_id INT        REFERENCES wms.printers(id),
  is_active         BOOLEAN     NOT NULL DEFAULT TRUE,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, station_code)
);

CREATE INDEX idx_workstations_tenant    ON wms.workstations(tenant_id);
CREATE INDEX idx_workstations_warehouse ON wms.workstations(warehouse_id);
CREATE INDEX idx_workstations_active    ON wms.workstations(tenant_id, is_active);

CREATE TRIGGER trg_workstations_updated_at
  BEFORE UPDATE ON wms.workstations
  FOR EACH ROW EXECUTE FUNCTION platform.update_updated_at();

-- Одна запись на сотрудника — какое рабочее место он выбрал последним.
-- set_at нужен, чтобы в UI можно было показать "выбрано N часов назад" и,
-- при желании, когда-нибудь ввести авто-сброс по истечении смены.
CREATE TABLE wms.employee_active_station (
  employee_id  INT         NOT NULL PRIMARY KEY REFERENCES wms.users(id),
  tenant_id    INT         NOT NULL REFERENCES platform.tenants(id),
  station_id   INT         NOT NULL REFERENCES wms.workstations(id),
  set_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_employee_active_station_tenant ON wms.employee_active_station(tenant_id);

COMMIT;
