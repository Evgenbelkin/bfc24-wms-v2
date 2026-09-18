-- =============================================================================
-- BFC24 WMS v2 — Migration 010: Fix wms.apply_stock_movement upsert bug
-- =============================================================================
-- Баг (обнаружен вживую 2026-07-23 при первой попытке списать уже принятый
-- товар на сборке): исходная реализация делала
--   INSERT INTO stock_balances (..., qty_on_hand, ...) VALUES (..., p_qty, ...)
--   ON CONFLICT (...) DO UPDATE SET qty_on_hand = stock_balances.qty_on_hand + p_qty
-- PostgreSQL проверяет CHECK-ограничения на кандидате строки для INSERT
-- (VALUES(...) + дефолты) ДО того, как понимает, что это конфликт и нужно
-- идти по ветке DO UPDATE. Если p_qty отрицательный (списание — picking,
-- shipping, writeoff, move-FROM), кандидат qty_on_hand=p_qty (например, -1)
-- ВСЕГДА нарушает CHECK(qty_on_hand >= 0), даже когда на ячейке реально
-- достаточно остатка и итоговое значение после UPDATE было бы положительным.
-- Это существовало с самой миграции 004, но не проявлялось раньше, потому
-- что до сих пор тестировалась только приёмка (положительные движения,
-- которые проходят как первая вставка без конфликта).
--
-- Фикс: разбиваем на два шага. Сначала гарантируем существование строки
-- через INSERT ... ON CONFLICT DO NOTHING с qty_on_hand=0 (кандидат всегда
-- проходит CHECK, независимо от знака p_qty). Затем обычным UPDATE применяем
-- дельту — обычный UPDATE проверяет CHECK только на итоговом значении строки,
-- без этой ловушки с "кандидатом", поэтому работает корректно и для приходов,
-- и для расходов.
-- =============================================================================

BEGIN;

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
  -- Шаг 1: гарантируем, что строка баланса существует. Кандидат всегда
  -- qty_on_hand=0 — не зависит от p_qty, поэтому CHECK-ограничения никогда
  -- не мешают этой вставке, даже при отрицательном p_qty.
  INSERT INTO wms.stock_balances (
    tenant_id, warehouse_id, client_id, item_id, location_id, barcode,
    qty_on_hand, last_movement_at, updated_at
  )
  VALUES (
    p_tenant_id, p_warehouse_id, p_client_id, p_item_id, p_location_id, p_barcode,
    0, NOW(), NOW()
  )
  ON CONFLICT (tenant_id, warehouse_id, client_id, item_id, location_id) DO NOTHING;

  -- Шаг 2: обычный UPDATE применяет дельту к РЕАЛЬНОМУ текущему значению.
  -- Здесь нет "кандидата" — CHECK проверяется на итоговой строке, как и должно быть.
  UPDATE wms.stock_balances
  SET
    qty_on_hand = wms.stock_balances.qty_on_hand + p_qty,
    avg_cost = CASE
      WHEN p_qty > 0 AND p_unit_cost IS NOT NULL THEN
        (wms.stock_balances.qty_on_hand * COALESCE(wms.stock_balances.avg_cost, 0) + p_qty * p_unit_cost)
        / GREATEST(wms.stock_balances.qty_on_hand + p_qty, 1)
      ELSE
        wms.stock_balances.avg_cost
    END,
    last_movement_at = NOW(),
    updated_at       = NOW()
  WHERE tenant_id=p_tenant_id AND warehouse_id=p_warehouse_id AND client_id=p_client_id
    AND item_id=p_item_id AND location_id=p_location_id
  RETURNING * INTO v_balance;

  -- Проверяем что остаток не ушёл в минус (этот явный чек и раньше был
  -- единственной содержательной защитой — теперь он наконец-то видит
  -- правильное, а не преждевременно проверенное значение)
  IF v_balance.qty_on_hand < 0 THEN
    RAISE EXCEPTION 'Insufficient stock: qty_on_hand would be %, item_id=%, location_id=%',
      v_balance.qty_on_hand, p_item_id, p_location_id
      USING ERRCODE = 'P0001';
  END IF;

  RETURN v_balance;
END;
$$ LANGUAGE plpgsql;

COMMIT;
