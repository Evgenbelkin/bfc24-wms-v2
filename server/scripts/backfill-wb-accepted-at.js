#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const wbClient = require('../src/modules/wb/wb.client');

// =============================================================================
// Разовый пересчёт: wms.shipments.wb_accepted_at для уже ЗАКРЫТЫХ поставок за
// последние N дней заменяется на честный scanDt от WB (GET
// /api/v3/supplies/{supplyId}) вместо старого косвенного значения (момент,
// когда опрос статусов ВСЕХ заказов поставки наконец подтвердил, что все
// вышли из 'waiting' - обычно на 10-20 минут позже реального скана QR, но
// иногда и сильнее, если в поставке был "тормозящий" заказ).
//
// Сама логика сбора для НОВЫХ поставок уже переключена на scanDt (см.
// wb.service.js::syncDeliveryStatusForTenant, правка 14.09.2026) - этот
// скрипт только подтягивает историю, ничего в логике не меняет. Только
// ЧТЕНИЕ из WB + точечный UPDATE одного поля wb_accepted_at (ничего другого
// не трогает - ни статусы, ни остатки, ни начисления).
//
// Использование:
//   cd server && node scripts/backfill-wb-accepted-at.js [дней_назад=30]
// =============================================================================

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME     || 'bfc24_v2',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const days = Number(process.argv[2]) || 30;
  const client = await pool.connect();
  try {
    const res = await client.query(
      `SELECT s.id, s.tenant_id, s.external_id, s.wb_accepted_at,
              (SELECT ma.api_token
               FROM wms.wb_orders wo
               JOIN wms.mp_accounts ma ON ma.id = wo.mp_account_id
               WHERE wo.tenant_id = s.tenant_id AND wo.wb_supply_id = s.external_id
                 AND ma.api_token IS NOT NULL
               LIMIT 1) AS api_token
       FROM wms.shipments s
       WHERE s.status = 'done' AND s.wb_accepted_at IS NOT NULL
         AND s.wb_accepted_at >= NOW() - ($1 || ' days')::interval
       ORDER BY s.wb_accepted_at DESC`,
      [days]
    );

    console.log(`Поставок за последние ${days} дн. для проверки: ${res.rowCount}\n`);

    let checked = 0, updated = 0, unchanged = 0, noToken = 0, noScanDt = 0, errors = 0;

    for (const row of res.rows) {
      checked++;
      if (!row.api_token) {
        noToken++;
        continue;
      }
      try {
        const details = await wbClient.getSupplyDetails(row.api_token, row.external_id);
        if (!details || !details.scanDt) {
          noScanDt++;
          continue;
        }
        const scanDt = new Date(details.scanDt);
        const oldVal = new Date(row.wb_accepted_at);
        const diffMs = Math.abs(scanDt.getTime() - oldVal.getTime());

        if (diffMs < 60000) {
          unchanged++; // уже и так точно (разница меньше минуты) - не трогаем
        } else {
          await client.query(
            `UPDATE wms.shipments SET wb_accepted_at=$2, updated_at=NOW() WHERE id=$1`,
            [row.id, scanDt]
          );
          updated++;
          console.log(
            `${row.external_id}: было ${oldVal.toISOString()} -> стало ${scanDt.toISOString()} ` +
            `(разница ${Math.round(diffMs / 60000)} мин)`
          );
        }
      } catch (e) {
        errors++;
        console.log(`${row.external_id}: ошибка запроса к WB - ${e.message}`);
      }
      await sleep(150); // не долбим WB API слишком часто
    }

    console.log('');
    console.log('=== ИТОГО ===');
    console.log(`Проверено: ${checked}`);
    console.log(`Обновлено (было заметное расхождение): ${updated}`);
    console.log(`Без изменений (разница <1 мин): ${unchanged}`);
    console.log(`Без токена WB-аккаунта: ${noToken}`);
    console.log(`Без scanDt в ответе WB (например, отклонённая поставка): ${noScanDt}`);
    console.log(`Ошибок запроса: ${errors}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => {
  console.error('Ошибка:', e.message);
  process.exit(1);
});
