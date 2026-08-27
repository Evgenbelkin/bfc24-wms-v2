'use strict';

require('dotenv').config();

const { query, pool } = require('../src/config/database');

// =============================================================================
// Разовая диагностика (27.08.2026): проверяем гипотезу, почему у многих
// товаров в WMS остаток есть, а в WB - 0/меньше (см. wb-stock-reconcile.js).
//
// distributeStockForAccount считает остаток для WB ТОЛЬКО по ячейкам отбора
// (is_pick_location=TRUE) - если товар физически лежит в зоне приёмки/
// буфера/карантина (ещё не "размещён" по стеллажам), в WB он не уходит
// вообще, даже если qty_available в WMS положительный.
//
// Этот скрипт показывает, сколько остатка (по всем тенантам) сидит в
// pick-ячейках vs не-pick-ячейках - если основная масса в НЕ-pick, это и
// объясняет масштаб расхождений в реконсиле.
//
// Запуск: cd server && node scripts/diag-pick-location-breakdown.js
// =============================================================================

async function main() {
  console.log('=== Остаток (qty_available>0) по типам ячеек, все тенанты ===\n');
  const r1 = await query(`
    SELECT
      l.location_type,
      l.is_pick_location,
      COUNT(DISTINCT sb.barcode)::int AS skus,
      SUM(sb.qty_available)::int AS total_qty
    FROM wms.stock_balances sb
    JOIN wms.locations l ON l.id = sb.location_id
    WHERE sb.qty_available > 0
    GROUP BY l.location_type, l.is_pick_location
    ORDER BY total_qty DESC
  `);
  console.log('location_type | is_pick_location | skus | total_qty');
  for (const row of r1.rows) {
    console.log(`${String(row.location_type).padEnd(13)} | ${String(row.is_pick_location).padEnd(17)} | ${String(row.skus).padEnd(4)} | ${row.total_qty}`);
  }

  console.log('\n=== Топ-20 ячеек с наибольшим "застрявшим" остатком (не pick) ===\n');
  const r2 = await query(`
    SELECT l.location_code, l.location_type, l.is_pick_location, l.is_active,
           w.warehouse_name, c.client_name,
           SUM(sb.qty_available)::int AS qty, COUNT(DISTINCT sb.barcode)::int AS skus
    FROM wms.stock_balances sb
    JOIN wms.locations l ON l.id = sb.location_id
    JOIN wms.warehouses w ON w.id = l.warehouse_id
    LEFT JOIN wms.clients c ON c.id = sb.client_id
    WHERE sb.qty_available > 0 AND l.is_pick_location = FALSE
    GROUP BY l.location_code, l.location_type, l.is_pick_location, l.is_active, w.warehouse_name, c.client_name
    ORDER BY qty DESC
    LIMIT 20
  `);
  console.log('location_code | type | active | warehouse | client | qty | skus');
  for (const row of r2.rows) {
    console.log(`${row.location_code.padEnd(14)} | ${String(row.location_type).padEnd(10)} | ${String(row.is_active).padEnd(6)} | ${(row.warehouse_name||'').padEnd(14)} | ${(row.client_name||'').padEnd(18)} | ${row.qty} | ${row.skus}`);
  }

  console.log('\n=== Конкретная ячейка B-01-08 (со скриншота) ===\n');
  const r3 = await query(`
    SELECT location_code, location_type, is_pick_location, is_active, zone_code
    FROM wms.locations WHERE location_code = 'B-01-08'
  `);
  console.log(r3.rows);

  // Гипотеза №2 (28.08.2026): distributeStockForAccount вычитает из остатка
  // ВСЕ заказы со статусом 'new' ИЛИ 'confirm' (см. newOrdersByBarcode).
  // 'confirm' закрывается в 'shipped' ТОЛЬКО в момент, когда
  // syncDeliveryStatusForTenant ловит переход отгрузки 'in_transit'->'done' -
  // то есть только на САМОМ ПЕРЕХОДЕ. Если отгрузка стала 'done' ДО того, как
  // этот код вообще появился (задеплоен 26.08.2026 вечером), либо стала
  // 'done' каким-то другим путём (см. migration 020, ручное подтверждение
  // MANUAL-отгрузок) - переход 'in_transit'->'done' для неё уже никогда не
  // произойдёт повторно, и её wb_orders так и останутся в 'confirm' НАВСЕГДА,
  // продолжая вычитаться из остатка для WB - хотя WB эти заказы либо уже
  // продал, либо давно принял поставку. Проверяем, сколько таких "зависших"
  // confirm-заказов уже накопилось (это может быть весь объём проблемы).
  console.log('\n=== "Зависшие" confirm-заказы (WB) - их отгрузка уже done, но статус заказа не обновился ===\n');
  const r4 = await query(`
    SELECT wo.tenant_id, ma.account_name, COUNT(*)::int AS stuck_orders,
           COUNT(DISTINCT wo.barcode)::int AS skus, SUM(1)::int AS units
    FROM wms.wb_orders wo
    JOIN wms.mp_accounts ma ON ma.id = wo.mp_account_id
    JOIN wms.shipments s ON s.tenant_id = wo.tenant_id AND s.external_id = wo.wb_supply_id
    WHERE wo.status = 'confirm' AND s.status IN ('in_transit', 'done')
    GROUP BY wo.tenant_id, ma.account_name
    ORDER BY stuck_orders DESC
  `);
  console.log(r4.rows);

  console.log('\n=== Всего confirm-заказов (любых) и сколько из них "зависшие" ===\n');
  const r5 = await query(`
    SELECT
      COUNT(*)::int AS total_confirm,
      COUNT(*) FILTER (WHERE s.status IN ('in_transit', 'done'))::int AS stuck_confirm_shipped,
      COUNT(*) FILTER (WHERE s.status IS NULL)::int AS confirm_no_shipment_match
    FROM wms.wb_orders wo
    LEFT JOIN wms.shipments s ON s.tenant_id = wo.tenant_id AND s.external_id = wo.wb_supply_id
    WHERE wo.status = 'confirm'
  `);
  console.log(r5.rows);

  await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
