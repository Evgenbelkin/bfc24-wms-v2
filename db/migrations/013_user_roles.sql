-- =============================================================================
-- BFC24 WMS v2 — Migration 013: Дополнительные роли пользователя
-- =============================================================================
-- Запрос: "надо сделать возможным давать права на несколько модулей, ведь
-- сейчас на сборке есть работа он работает а если закончилась он пойдет в
-- отдел где есть работа." — сотрудник должен иметь доступ сразу к нескольким
-- рабочим экранам (например Сборка + Упаковка), чтобы переключаться туда,
-- где сейчас есть работа, не дожидаясь смены роли админом.
--
-- Дизайн: wms.users.role остаётся ОСНОВНОЙ ролью (обязательное поле, как и
-- было — ничего не ломаем в существующей логике). Эта таблица хранит ТОЛЬКО
-- дополнительные роли поверх основной. Эффективный набор прав пользователя =
-- {users.role} ∪ {wms.user_roles для этого user_id}.
-- =============================================================================

BEGIN;

CREATE TABLE wms.user_roles (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   INT         NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  user_id     INT         NOT NULL REFERENCES wms.users(id) ON DELETE CASCADE,
  role        wms.user_role NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  INT         REFERENCES wms.users(id),
  UNIQUE (user_id, role)
);

CREATE INDEX idx_user_roles_user   ON wms.user_roles(user_id);
CREATE INDEX idx_user_roles_tenant ON wms.user_roles(tenant_id);

COMMIT;
