#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { Pool } = require('pg');

// =============================================================================
// Диагностика: "хождение туда-обратно" при сборке волны — сборщик уходит от
// ячейки дальше по маршруту, а потом его снова отправляют в УЖЕ посещённую
// ячейку за другим товаром той же волны. Только ЧТЕНИЕ, ничего не меняет.
//
// Логика: берём задачи picking_tasks в статусе 'done' за указанную дату,
// группируем по wave_id, сортируем по started_at (реальный порядок, в котором
// сборщик физически брался за задачи), и ищем паттерн A...B...A — ячейка
// повторяется НЕ подряд (между двумя визитами в неё был визит в другую ячейку).
//
// Использование:
//   cd server && node scripts/find-picking-backtrack.js [YYYY-MM-DD]
//   (без даты — берёт сегодня, по времени сервера)
// =============================================================================

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME     || 'bfc24_v2',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

async function main() {
  const date = process.argv[2] || new Date().toISOString().slice(0, 10);
  const client = await pool.connect();
  try {
    console.log(`Дата: ${date}\n`);

    const res = await client.query(
      `SELECT pt.id, pt.wave_id, pt.shipment_code, pt.wb_order_id, pt.item_id,
              pt.barcode, pt.location_code, pt.started_at, pt.completed_at,
              i.item_name
       FROM wms.picking_tasks pt
       LEFT JOIN wms.items i ON i.id = pt.item_id
       WHERE pt.status='done' AND pt.wave_id IS NOT NULL
         AND pt.started_at >= $1::date AND pt.started_at < ($1::date + INTERVAL '1 day')
       ORDER BY pt.wave_id, pt.started_at ASC, pt.id ASC`,
      [date]
    );

    if (res.rowCount === 0) {
      console.log('За эту дату завершённых задач сборки в волнах не найдено.');
      return;
    }

    // Группируем по wave_id
    const byWave = new Map();
    for (const row of res.rows) {
      if (!byWave.has(row.wave_id)) byWave.set(row.wave_id, []);
      byWave.get(row.wave_id).push(row);
    }

    let totalBacktracks = 0;
    let wavesAffected = 0;

    for (const [waveId, tasks] of byWave) {
      // Идём по фактическому порядку выполнения (started_at) и ищем: ячейка X
      // встречалась раньше, потом была ХОТЯ БЫ ОДНА другая ячейка, и вот снова X.
      const seenAt = new Map(); // location_code -> индекс последнего визита
      const backtracks = [];
      let lastLocation = null;

      tasks.forEach((t, idx) => {
        const loc = t.location_code;
        if (!loc) return; // ячейка не резолвилась - пропускаем, не наш кейс
        if (loc !== lastLocation && seenAt.has(loc)) {
          const prevIdx = seenAt.get(loc);
          backtracks.push({
            location: loc,
            firstVisitTask: tasks[prevIdx],
            returnTask: t,
            stepsBetween: idx - prevIdx,
          });
        }
        seenAt.set(loc, idx);
        lastLocation = loc;
      });

      if (backtracks.length > 0) {
        wavesAffected++;
        totalBacktracks += backtracks.length;
        const shipmentCode = tasks[0].shipment_code;
        console.log(`--- wave_id=${waveId} shipment=${shipmentCode} (${tasks.length} задач) ---`);
        for (const b of backtracks) {
          console.log(
            `  Возврат в ${b.location}: ` +
            `сначала task_id=${b.firstVisitTask.id} (${b.firstVisitTask.item_name || '—'}, ` +
            `wb_order_id=${b.firstVisitTask.wb_order_id}, ${b.firstVisitTask.started_at?.toISOString()}), ` +
            `потом ${b.stepsBetween} др. задач(и), затем СНОВА task_id=${b.returnTask.id} ` +
            `(${b.returnTask.item_name || '—'}, wb_order_id=${b.returnTask.wb_order_id}, ` +
            `${b.returnTask.started_at?.toISOString()}) — ` +
            `${b.firstVisitTask.item_id === b.returnTask.item_id ? 'ОДИН И ТОТ ЖЕ товар' : 'РАЗНЫЕ товары в одной ячейке'}`
          );
        }
        console.log('');
      }
    }

    console.log(`\nИтого волн с "хождением туда-обратно": ${wavesAffected} из ${byWave.size}, всего случаев возврата: ${totalBacktracks}.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});
