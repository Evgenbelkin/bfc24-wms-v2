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

  await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
