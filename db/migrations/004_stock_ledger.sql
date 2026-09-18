-- =============================================================================
-- BFC24 WMS v2 — Migration 004: Stock Ledger
-- =============================================================================
-- Ключевая архитектура: движения (stock_movements) — источник истины.
-- stock_balances — материализованный агрегат для быстрых запросов.
-- Reservation layer заложен сразу.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Типы движений
-- ---------------------------------------------------------------------------
CREATE TYPE wms.movement_type AS ENUM (
  'receiving',     -- приёмка (приход с улицы)
  'inbound',       -- приёмка по заявке на поставку
  'placement',     -- размещение (перемещение из зоны приёмки на МХ)
  'move',          -- перемещение между МХ
  'picking',       -- списание при сборке
  'packing',       -- регистрация при упаковке
  'shipping',      -- списание при отгрузке
  'return',        -- возврат товара
  'inventory',     -- корректировка при инвентаризации
  'writeoff',      -- списание (брак, потеря)
  'adjust'         -- ручная корректировка
);

-- ---------------------------------------------------------------------------
-- STOCK MOVEMENTS (ledger — источник истины)
-- Каждая запись — неизменяемое событие движения товара
-- ---------------------------------------------------------------------------
CREATE TABLE wms.stock_movements (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       INT         NOT NULL REFERENCES platform.tenants(id),
  warehouse_id    INT         NOT NULL REFERENCES wms.warehouses(id),
  client_id       INT         NOT NULL REFERENCES wms.clients(id),
  item_id         INT         NOT NULL REFERENCES wms.items(id),
  barcode         TEXT        NOT NULL,  -- денормализация для скорости

  movement_type   wms.movement_type NOT NULL,
  qty             INT         NOT NULL,
  -- qty > 0 = приход, qty < 0 = расход
  -- Это важное решение: один тип с знаковым qty вместо in/out

  from_location_id INT        REFERENCES wms.locations(id),
  to_location_id   INT        REFERENCES wms.locations(id),
  from_location_code TEXT,    -- денормализация
  to_location_code   TEXT,    -- денормализация

  -- Ссылка на документ-источник
  ref_type        TEXT,       -- inbound_order | picking_task | shipment | inventory_task | manual
  ref_id          BIGINT,     -- ID документа

  unit_cost       NUMERIC(14,4),  -- себестоимость единицы на момент движения
  total_cost      NUMERIC(14,4),  -- = qty * unit_cost (для расчётов)

  user_id         INT         REFERENCES wms.users(id),
  comment         TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT movement_qty_nonzero CHECK (qty <> 0),
  CONSTRAINT movement_has_location CHECK (
    from_location_id IS NOT NULL OR to_location_id IS NOT NULL
  )
);

-- Индексы для частых запросов
CREATE INDEX idx_movements_tenant      ON wms.stock_movements(tenant_id, created_at DESC);
CREATE INDEX idx_movements_client      ON wms.stock_movements(client_id, created_at DESC);
CREATE INDEX idx_movements_item        ON wms.stock_movements(item_id, created_at DESC);
CREATE INDEX idx_movements_barcode     ON wms.stock_movements(tenant_id, barcode, created_at DESC);
CREATE INDEX idx_movements_type        ON wms.stock_movements(tenant_id, movement_type);
CREATE INDEX idx_movements_ref        ON wms.stock_movements(ref_type, ref_id) WHERE ref_type IS NOT NULL;
CREATE INDEX idx_movements_from_loc    ON wms.stock_movements(from_location_id) WHERE from_location_id IS NOT NULL;
CREATE INDEX idx_movements_to_loc      ON wms.stock_movements(to_location_id) WHERE to_location_id IS NOT NULL;
CREATE INDEX idx_movements_user        ON wms.stock_movements(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_movements_date_range  ON wms.stock_movements(tenant_id, client_id, created_at);

-- ---------------------------------------------------------------------------
-- STOCK BALANCES (агрегат — витрина для быстрых запросов)
-- Обновляется синхронно при каждом движении через функцию
-- ---------------------------------------------------------------------------
CREATE TABLE wms.stock_balances (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       INT         NOT NULL REFERENCES platform.tenants(id),
  warehouse_id    INT         NOT NULL REFERENCES wms.warehouses(id),
  client_id       INT         NOT NULL REFERENCES wms.clients(id),
  item_id         INT         NOT NULL REFERENCES wms.items(id),
  location_id     INT         NOT NULL REFERENCES wms.locations(id),
  barcode         TEXT        NOT NULL,  -- денормализация

  qty_on_hand     INT         NOT NULL DEFAULT 0,  -- физический остаток
  qty_reserved    INT         NOT NULL DEFAULT 0,  -- зарезервировано под заказы
  qty_available   INT         NOT NULL GENERATED ALWAYS AS (qty_on_hand - qty_reserved) STORED,

  avg_cost        NUMERIC(14,4),  -- средневзвешенная себестоимость

  last_movement_at TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, warehouse_id, client_id, item_id, location_id),
  CONSTRAINT balance_qty_nonnegative CHECK (qty_on_hand >= 0),
  CONSTRAINT balance_reserved_nonnegative CHECK (qty_reserved >= 0),
  CONSTRAINT balance_reserved_le_on_hand CHECK (qty_reserved <= qty_on_hand)
);

CREATE INDEX idx_balances_tenant      ON wms.stock_balances(tenant_id);
CREATE INDEX idx_balances_client      ON wms.stock_balances(client_id);
CREATE INDEX idx_balances_item        ON wms.stock_balances(item_id);
CREATE INDEX idx_balances_location    ON wms.stock_balances(location_id);
CREATE INDEX idx_balances_barcode     ON wms.stock_balances(tenant_id, barcode);
CREATE INDEX idx_balances_available   ON wms.stock_balances(tenant_id, client_id, qty_available) WHERE qty_available > 0;
CREATE INDEX idx_balances_nonzero     ON wms.stock_balances(tenant_id, client_id, item_id) WHERE qty_on_hand > 0;

-- ---------------------------------------------------------------------------
-- Функция применения движения к балансу
-- Вызывается из бизнес-логики при каждом stock_movement.INSERT
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wms.apply_stock_movement(
  p_tenant_id     INT,
  p_warehouse_id  INT,
  p_client_id     INT,
  p_item_id       INT,
  p_location_id   INT,
  p_barcode       TEXT,
  p_qty           INT,  -- знаковое: + приход, - расход
  p_unit_cost     NUMERIC DEFAULT NULL
)
RETURNS wms.stock_balances AS $$
DECLARE
  v_balance wms.stock_balances;
BEGIN
  -- UPSERT баланса
  INSERT INTO wms.stock_balances (
    tenant_id, warehouse_id, client_id, item_id, location_id, barcode,
    qty_on_hand, avg_cost, last_movement_at, updated_at
  )
  VALUES (
    p_tenant_id, p_warehouse_id, p_client_id, p_item_id, p_location_id, p_barcode,
    p_qty,
    p_unit_cost,
    NOW(),
    NOW()
  )
  ON CONFLICT (tenant_id, warehouse_id, client_id, item_id, location_id)
  DO UPDATE SET
    qty_on_hand = wms.stock_balances.qty_on_hand + p_qty,
    avg_cost = CASE
      WHEN p_qty > 0 AND p_unit_cost IS NOT NULL THEN
        -- Пересчёт средневзвешенной при приходе
        (wms.stock_balances.qty_on_hand * COALESCE(wms.stock_balances.avg_cost, 0) + p_qty * p_unit_cost)
        / GREATEST(wms.stock_balances.qty_on_hand + p_qty, 1)
      ELSE
        wms.stock_balances.avg_cost
    END,
    last_movement_at = NOW(),
    updated_at       = NOW()
  RETURNING * INTO v_balance;

  -- Проверяем что остаток не ушёл в минус
  IF v_balance.qty_on_hand < 0 THEN
    RAISE EXCEPTION 'Insufficient stock: qty_on_hand would be %, item_id=%, location_id=%',
      v_balance.qty_on_hand, p_item_id, p_location_id
      USING ERRCODE = 'P0001';
  END IF;

  RETURN v_balance;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- RESERVATIONS (резервирование под заказы)
-- ---------------------------------------------------------------------------
CREATE TYPE wms.reservation_status AS ENUM (
  'active',    -- активное резервирование
  'fulfilled', -- выполнено (товар собран)
  'cancelled'  -- отменено
);

CREATE TABLE wms.stock_reservations (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       INT         NOT NULL REFERENCES platform.tenants(id),
  warehouse_id    INT         NOT NULL REFERENCES wms.warehouses(id),
  client_id       INT         NOT NULL REFERENCES wms.clients(id),
  item_id         INT         NOT NULL REFERENCES wms.items(id),
  location_id     INT         NOT NULL REFERENCES wms.locations(id),
  barcode         TEXT        NOT NULL,

  ref_type        TEXT        NOT NULL,  -- picking_task | shipment | inbound_order
  ref_id          BIGINT      NOT NULL,

  qty_reserved    INT         NOT NULL,
  status          wms.reservation_status NOT NULL DEFAULT 'active',

  reserved_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fulfilled_at    TIMESTAMPTZ,
  cancelled_at    TIMESTAMPTZ,

  CONSTRAINT reservation_qty_positive CHECK (qty_reserved > 0)
);

CREATE INDEX idx_reservations_tenant   ON wms.stock_reservations(tenant_id);
CREATE INDEX idx_reservations_item_loc ON wms.stock_reservations(item_id, location_id, status);
CREATE INDEX idx_reservations_ref      ON wms.stock_reservations(ref_type, ref_id);
CREATE INDEX idx_reservations_active   ON wms.stock_reservations(tenant_id, client_id, status) WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Функция резервирования
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wms.reserve_stock(
  p_tenant_id    INT,
  p_warehouse_id INT,
  p_client_id    INT,
  p_item_id      INT,
  p_location_id  INT,
  p_barcode      TEXT,
  p_qty          INT,
  p_ref_type     TEXT,
  p_ref_id       BIGINT
)
RETURNS wms.stock_reservations AS $$
DECLARE
  v_available INT;
  v_reservation wms.stock_reservations;
BEGIN
  -- Проверяем доступный остаток (с блокировкой строки)
  SELECT qty_available
  INTO v_available
  FROM wms.stock_balances
  WHERE tenant_id   = p_tenant_id
    AND warehouse_id = p_warehouse_id
    AND client_id   = p_client_id
    AND item_id     = p_item_id
    AND location_id = p_location_id
  FOR UPDATE;

  IF v_available IS NULL OR v_available < p_qty THEN
    RAISE EXCEPTION 'Insufficient available stock: available=%, required=%, item_id=%, location_id=%',
      COALESCE(v_available, 0), p_qty, p_item_id, p_location_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Создаём резервирование
  INSERT INTO wms.stock_reservations (
    tenant_id, warehouse_id, client_id, item_id, location_id, barcode,
    ref_type, ref_id, qty_reserved
  )
  VALUES (
    p_tenant_id, p_warehouse_id, p_client_id, p_item_id, p_location_id, p_barcode,
    p_ref_type, p_ref_id, p_qty
  )
  RETURNING * INTO v_reservation;

  -- Обновляем qty_reserved в балансе
  UPDATE wms.stock_balances
  SET qty_reserved = qty_reserved + p_qty,
      updated_at   = NOW()
  WHERE tenant_id   = p_tenant_id
    AND warehouse_id = p_warehouse_id
    AND client_id   = p_client_id
    AND item_id     = p_item_id
    AND location_id = p_location_id;

  RETURN v_reservation;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Функция снятия резервирования
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wms.release_reservation(
  p_reservation_id BIGINT,
  p_status         wms.reservation_status DEFAULT 'cancelled'
)
RETURNS VOID AS $$
DECLARE
  v_res wms.stock_reservations;
BEGIN
  SELECT * INTO v_res
  FROM wms.stock_reservations
  WHERE id = p_reservation_id AND status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reservation not found or not active: id=%', p_reservation_id;
  END IF;

  UPDATE wms.stock_reservations
  SET status = p_status,
      fulfilled_at = CASE WHEN p_status = 'fulfilled' THEN NOW() ELSE NULL END,
      cancelled_at = CASE WHEN p_status = 'cancelled' THEN NOW() ELSE NULL END
  WHERE id = p_reservation_id;

  UPDATE wms.stock_balances
  SET qty_reserved = GREATEST(0, qty_reserved - v_res.qty_reserved),
      updated_at   = NOW()
  WHERE tenant_id   = v_res.tenant_id
    AND warehouse_id = v_res.warehouse_id
    AND client_id   = v_res.client_id
    AND item_id     = v_res.item_id
    AND location_id = v_res.location_id;
END;
$$ LANGUAGE plpgsql;

COMMIT;
