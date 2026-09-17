#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { Pool } = require('pg');

// =============================================================================
// Диагностика (только чтение, ничего не меняет): проверка на РЕАЛЬНОЙ поставке
// данных, на которых строится отчёт "Скорость обработки" (Аналитика FBS,
// getProcessingSpeed/getProcessingSpeedByClient в fbsAnalytics.service.js) —
// заказ создан → поставка отгружена (shipped_at, скан QR на отгрузке) →
// WB подтвердил приёмку (wb_accepted_at) → плюс полная история wbStatus по
// каждому заказу поставки (включая 'sorted', если такой статус вообще
// когда-либо приходил от WB для этого тенанта — проверяем предположение
// 14.09.2026, что отдельная метрика "до сортировки" была бы ненадёжна).
//
// Использование:
//   cd server && node scripts/check-shipment-speed.js WB-GI-XXXXXXX
// =============================================================================

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME     || 'bfc24_v2',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

function hours(a, b) {
  if (!a || !b) return null;
  return ((new Date(b) - new Date(a)) / 3600000).toFixed(1);
}

async function main() {
  const code = process.argv[2];
  if (!code) {
    console.log('Использование: node scripts/check-shipment-speed.js WB-GI-XXXXXXX');
    process.exit(1);
  }
  const client = await pool.connect();
  try {
    const sRes = await client.query(
      `SELECT id, external_id, client_id, status, created_at, packing_finished_at, shipped_at, wb_accepted_at
       FROM wms.shipments WHERE external_id=$1`,
      [code]
    );
    if (sRes.rowCount === 0) {
      console.log(`Поставка ${code} не найдена в wms.shipments.`);
      return;
    }
    const s = sRes.rows[0];
    console.log('=== ПОСТАВКА ===');
    console.log(s);
    console.log('');
    console.log(`Упаковано -> отгружено (скан QR):     ${hours(s.packing_finished_at, s.shipped_at)} ч`);
    console.log(`Отгружено -> WB подтвердил приёмку:    ${hours(s.shipped_at, s.wb_accepted_at)} ч`);
    console.log('');

    const oRes2 = await client.query(
      `SELECT wo.wb_order_id, wo.created_at, wo.wb_status, wo.wb_status_updated_at
       FROM wms.wb_orders wo
       WHERE wo.wb_supply_id=$1
       ORDER BY wo.wb_order_id`,
      [code]
    );
    console.log(`=== ЗАКАЗЫ ПОСТАВКИ (${oRes2.rowCount}) ===`);
    for (const o of oRes2.rows) {
      console.log(`  order ${o.wb_order_id}: created_at=${o.created_at ? o.created_at.toISOString() : '—'}  wb_status=${o.wb_status || '—'}  заказ->приёмка=${hours(o.created_at, s.wb_accepted_at)} ч`);
    }
    console.log('');

    const eRes = await client.query(
      `SELECT wo.wb_order_id, e.wb_status, e.observed_at
       FROM wms.wb_orders wo
       JOIN wms.wb_order_status_events e
         ON e.mp_account_id = wo.mp_account_id AND e.wb_order_id = wo.wb_order_id
       WHERE wo.wb_supply_id=$1
       ORDER BY wo.wb_order_id, e.observed_at`,
      [code]
    );
    console.log(`=== ИСТОРИЯ СТАТУСОВ (wb_order_status_events), всего ${eRes.rowCount} ===`);
    for (const e of eRes.rows) {
      console.log(`  order ${e.wb_order_id}: ${e.wb_status} @ ${e.observed_at.toISOString()}`);
    }
    const sortedCount = eRes.rows.filter(r => r.wb_status === 'sorted').length;
    console.log('');
    console.log(`Событий со статусом 'sorted': ${sortedCount} из ${eRes.rowCount}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => {
  console.error('Ошибка:', e.message);
  process.exit(1);
});
