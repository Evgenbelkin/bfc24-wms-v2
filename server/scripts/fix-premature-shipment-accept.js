#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const wbClient = require('../src/modules/wb/wb.client');

// =============================================================================
// Разовое исправление бага (найден пользователем 14.09.2026 на реальных
// поставках): syncDeliveryStatusForTenant закрывал поставку (status='done',
// wb_accepted_at) по полю details.done из GET /api/v3/supplies/{id} - но
// done=true НЕ означает "WB принял поставку на складе", оно становится true и
// когда поставка просто ЗАКРЫТА для сборки/сдана в доставку (см. доку WB:
// "scanning its QR code OR accepting the first product... will automatically
// close the supply" - то есть может произойти от НАШЕГО собственного
// действия). Из-за этого свежие поставки, которые ФИЗИЧЕСКИ ещё едут к WB,
// помечались как принятые с wb_accepted_at=NOW() (момент опроса, не приёмки).
// Код уже исправлен (см. wb.service.js, коммит после e50cc9d) - использует
// scanDt, а не done. Этот скрипт чинит данные, накопленные ПОКА баг был жив.
//
// Только shipments, у которых wb_accepted_at попадает в последние N часов
// (по умолчанию 12ч - с запасом покрывает окно между деплоем e50cc9d и
// деплоем фикса) - НЕ трогаем старые поставки, закрытые до этого бага по
// прежней (рабочей) логике.
//
// Для каждой такой поставки:
//  - если scanDt у WB реально уже есть - поставка правда принята, просто
//    поправляем wb_accepted_at на точное значение (та же логика, что в
//    backfill-wb-accepted-at.js);
//  - если scanDt всё ещё нет - поставка была закрыта ПРЕЖДЕВРЕМЕННО багом,
//    физически она ещё в пути - откатываем status='in_transit',
//    wb_accepted_at=NULL, чтобы уже исправленный синк подхватил её заново и
//    закрыл только когда WB реально отсканирует.
//
// Статус заказов (wb_orders.status='shipped') НЕ трогаем - он отражает факт
// "товар физически покинул наш склад", это по-прежнему правда независимо от
// того, принял ли уже WB поставку.
//
// Использование:
//   cd server && node scripts/fix-premature-shipment-accept.js [часов_назад=12]
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
  const hours = Number(process.argv[2]) || 12;
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
         AND s.wb_accepted_at >= NOW() - ($1 || ' hours')::interval
       ORDER BY s.wb_accepted_at DESC`,
      [hours]
    );

    console.log(`Поставок за последние ${hours} ч. для проверки: ${res.rowCount}\n`);

    let reverted = 0, corrected = 0, confirmedOk = 0, noToken = 0, errors = 0;

    for (const row of res.rows) {
      if (!row.api_token) { noToken++; continue; }
      try {
        const details = await wbClient.getSupplyDetails(row.api_token, row.external_id);

        if (details && details.scanDt) {
          const scanDt = new Date(details.scanDt);
          const oldVal = new Date(row.wb_accepted_at);
          if (Math.abs(scanDt.getTime() - oldVal.getTime()) < 60000) {
            confirmedOk++;
          } else {
            await client.query(`UPDATE wms.shipments SET wb_accepted_at=$2, updated_at=NOW() WHERE id=$1`, [row.id, scanDt]);
            corrected++;
            console.log(`${row.external_id}: scanDt есть, поправлен wb_accepted_at -> ${scanDt.toISOString()}`);
          }
        } else {
          await client.query(
            `UPDATE wms.shipments SET status='in_transit', wb_accepted_at=NULL, updated_at=NOW() WHERE id=$1`,
            [row.id]
          );
          reverted++;
          console.log(`${row.external_id}: scanDt ещё нет у WB - откатил в 'in_transit' (был преждевременно закрыт багом)`);
        }
      } catch (e) {
        errors++;
        console.log(`${row.external_id}: ошибка запроса к WB - ${e.message}`);
      }
      await sleep(150);
    }

    console.log('');
    console.log('=== ИТОГО ===');
    console.log(`Проверено: ${res.rowCount}`);
    console.log(`Откачено в 'in_transit' (были закрыты преждевременно): ${reverted}`);
    console.log(`Поправлен wb_accepted_at (scanDt отличался): ${corrected}`);
    console.log(`Уже были верны: ${confirmedOk}`);
    console.log(`Без токена: ${noToken}`);
    console.log(`Ошибок: ${errors}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => {
  console.error('Ошибка:', e.message);
  process.exit(1);
});
