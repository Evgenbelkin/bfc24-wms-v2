-- =============================================================================
-- BFC24 WMS v2 — Migration 002: Auth, Users, Roles
-- =============================================================================
-- Пользователи в разрезе tenant'а, роли, сессии, refresh tokens
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Роли системы (фиксированный enum)
-- ---------------------------------------------------------------------------
CREATE TYPE wms.user_role AS ENUM (
  'tenant_admin',       -- администратор фулфилмента
  'supervisor',         -- старший смены
  'receiver',           -- приёмщик
  'picker',             -- сборщик
  'packer',             -- упаковщик
  'shipper',            -- отгрузчик
  'inventory_manager',  -- инвентаризатор
  'analyst',            -- только просмотр отчётов
  'seller'              -- клиент-селлер (отдельный контур)
);

-- ---------------------------------------------------------------------------
-- Пользователи tenant'а
-- ---------------------------------------------------------------------------
CREATE TABLE wms.users (
  id              SERIAL PRIMARY KEY,
  tenant_id       INT         NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  client_id       INT,        -- заполняется только для роли seller (FK добавим в migration 003)
  username        TEXT        NOT NULL,
  email           TEXT,
  password_hash   TEXT        NOT NULL,
  full_name       TEXT,
  role            wms.user_role NOT NULL,
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  last_login_at   TIMESTAMPTZ,
  settings        JSONB       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by      INT         REFERENCES wms.users(id),
  UNIQUE (tenant_id, username)
);

CREATE INDEX idx_users_tenant     ON wms.users(tenant_id);
CREATE INDEX idx_users_role       ON wms.users(tenant_id, role);
CREATE INDEX idx_users_client     ON wms.users(client_id) WHERE client_id IS NOT NULL;
CREATE INDEX idx_users_active     ON wms.users(tenant_id, is_active);

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON wms.users
  FOR EACH ROW EXECUTE FUNCTION platform.update_updated_at();

-- ---------------------------------------------------------------------------
-- Refresh tokens (JWT refresh flow)
-- ---------------------------------------------------------------------------
CREATE TABLE wms.refresh_tokens (
  id          SERIAL PRIMARY KEY,
  user_id     INT         NOT NULL REFERENCES wms.users(id) ON DELETE CASCADE,
  tenant_id   INT         NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL UNIQUE,  -- bcrypt hash токена
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  user_agent  TEXT,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_user   ON wms.refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_token  ON wms.refresh_tokens(token_hash);
CREATE INDEX idx_refresh_tokens_expiry ON wms.refresh_tokens(expires_at) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Права на уровне роли (какие действия разрешены)
-- Это дополнение к role-based access, позволяет точечно управлять правами
-- ---------------------------------------------------------------------------
CREATE TABLE wms.role_permissions (
  id          SERIAL PRIMARY KEY,
  tenant_id   INT         NOT NULL REFERENCES platform.tenants(id) ON DELETE CASCADE,
  role        wms.user_role NOT NULL,
  permission  TEXT        NOT NULL,  -- например: 'receiving.accept', 'stock.adjust'
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, role, permission)
);

CREATE INDEX idx_role_permissions_tenant ON wms.role_permissions(tenant_id, role);

-- ---------------------------------------------------------------------------
-- Дефолтные разрешения по ролям
-- Используются как fallback если tenant не настроил кастомные
-- ---------------------------------------------------------------------------
CREATE TABLE platform.default_role_permissions (
  role        wms.user_role NOT NULL,
  permission  TEXT        NOT NULL,
  PRIMARY KEY (role, permission)
);

INSERT INTO platform.default_role_permissions (role, permission) VALUES
  -- tenant_admin — всё
  ('tenant_admin', '*'),

  -- supervisor — всё кроме управления пользователями
  ('supervisor', 'masterdata.*'),
  ('supervisor', 'stock.*'),
  ('supervisor', 'receiving.*'),
  ('supervisor', 'placement.*'),
  ('supervisor', 'movement.*'),
  ('supervisor', 'picking.*'),
  ('supervisor', 'packing.*'),
  ('supervisor', 'shipping.*'),
  ('supervisor', 'inventory.*'),
  ('supervisor', 'reports.*'),
  ('supervisor', 'printing.*'),
  ('supervisor', 'inbound.*'),

  -- receiver
  ('receiver', 'receiving.*'),
  ('receiver', 'placement.*'),
  ('receiver', 'inbound.view'),
  ('receiver', 'stock.view'),

  -- picker
  ('picker', 'picking.*'),
  ('picker', 'stock.view'),
  ('picker', 'inventory.create'),

  -- packer
  ('packer', 'packing.*'),
  ('packer', 'stock.view'),
  ('packer', 'printing.view'),

  -- shipper
  ('shipper', 'shipping.*'),
  ('shipper', 'packing.view'),
  ('shipper', 'printing.view'),
  ('shipper', 'stock.view'),

  -- inventory_manager
  ('inventory_manager', 'inventory.*'),
  ('inventory_manager', 'stock.*'),
  ('inventory_manager', 'movement.*'),

  -- analyst
  ('analyst', 'reports.*'),
  ('analyst', 'stock.view'),
  ('analyst', 'analytics.*'),

  -- seller — только свой кабинет
  ('seller', 'seller.*');

COMMIT;
