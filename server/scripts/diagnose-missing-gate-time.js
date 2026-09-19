#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { Pool } = require('pg');

// =============================================================================
// Диагностика (19.09.2026): в отчёте "Эффективность складов WB" у некоторых
// ЧУЖИХ складов клиента ИП Макаровой (Оренбург Центральная, Великий
// Новгород, Алексин, Новороссийск, Хабаровск_FBS) стоит "—" в колонке
// "До ворот ВБ", хотя докачка чужих поставок (backfill-foreign-supplies-now)
// уже завершена (newLookups=0, весь бэклог обработан).
//
// Проверяет по каждому такому складу: есть ли у его заказов wb_supply_id
// (попал ли заказ хоть в какую-то поставку), и если да - есть ли у этой
// поставки scan_dt в wms.wb_foreign_supplies (возможно WB сам не отдаёт
// scanDt для этого типа поставки/доставки).
//
// Использование (на VPS, из папки server/):
//   node scripts/diagnose-missing-gate-time.js <client_id> "<часть названия склада>"
// =============================================================================

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME     || 'bfc24_v2',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

async function main() {
  const clientId = process.argv[2];
  const whFilter = process.argv[3];
  if (!clientId || !whFilter) {
    console.error('Использование: node scripts/diagnose-missing-gate-time.js <client_id> "<часть названия склада>"');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT wo.id, wo.wb_order_id, wo.wb_supply_id, wo.created_at,
              COALESCE(sw.warehouse_name, wo.wb_sc_name) AS warehouse_name,
              fs.supply_id AS fs_supply_id, fs.scan_dt, fs.done AS fs_done, fs.orders_synced
         FROM wms.wb_orders wo
         JOIN wms.mp_accounts ma ON ma.id = wo.mp_account_id
         LEFT JOIN wms.wb_seller_warehouses sw ON sw.mp_account_id = wo.mp_account_id AND sw.wb_warehouse_id = wo.warehouse_id
         LEFT JOIN wms.wb_foreign_supplies fs ON fs.mp_account_id = wo.mp_account_id AND fs.supply_id = wo.wb_supply_id
        WHERE ma.client_id = $1
          AND COALESCE(sw.warehouse_name, wo.wb_sc_name) ILIKE '%' || $2 || '%'
        ORDER BY wo.created_at DESC
        LIMIT 20`,
      [clientId, whFilter]
    );

    if (res.rowCount === 0) {
      console.log('Заказов не найдено для этого склада/клиента.');
      return;
    }

    console.log(`Найдено заказов: ${res.rowCount}\n`);
    for (const r of res.rows) {
      console.log('-'.repeat(60));
      console.log(`order#${r.id} (wb_order_id=${r.wb_order_id})  склад: "${r.warehouse_name}"  создан: ${r.created_at?.toISOString?.() || r.created_at}`);
      console.log(`  wb_supply_id = ${r.wb_supply_id || 'NULL (заказ ещё НЕ попал ни в одну поставку по данным order-ids)'}`);
      if (r.wb_supply_id) {
        if (!r.fs_supply_id) {
          console.log(`  -> В wms.wb_foreign_supplies записи НЕТ (странно, раз wb_supply_id заполнен - возможно supply ещё не done или не была просканена джобой)`);
        } else {
          console.log(`  -> wms.wb_foreign_supplies: done=${r.fs_done}, orders_synced=${r.orders_synced}, scan_dt=${r.scan_dt || 'NULL (WB сам не вернул scanDt для этой поставки!)'}`);
        }
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('Ошибка:', e);
  process.exit(1);
});
