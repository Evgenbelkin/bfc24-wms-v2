#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const wbClient = require('../src/modules/wb/wb.client');

// =============================================================================
// Диагностика (только чтение, ничего не меняет): проверка, что WB API
// GET /api/v3/supplies/{supplyId} реально отдаёт scanDt (момент скана QR
// поставки на приёмке) и что он совпадает с тем, что видно в личном кабинете
// продавца на WB (пользователь сверял вручную по скриншоту 14.09.2026 -
// реальный скан WB-GI-277801168 был в 00:14 МСК 14.09.2026).
//
// Наш текущий wms.shipments.wb_accepted_at ВЫВЕДЕН косвенно - опросом
// статусов ВСЕХ заказов поставки (ждёт самого медленного), а не взят из
// прямого поля WB. Если scanDt окажется надёжным и точным - есть смысл
// заменить/дополнить им wb_accepted_at (отдельная задача, после этой сверки).
//
// Использование:
//   cd server && node scripts/check-supply-scan-dt.js WB-GI-XXXXXXX
// =============================================================================

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME     || 'bfc24_v2',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

async function main() {
  const code = process.argv[2];
  if (!code) {
    console.log('Использование: node scripts/check-supply-scan-dt.js WB-GI-XXXXXXX');
    process.exit(1);
  }
  const client = await pool.connect();
  try {
    const sRes = await client.query(
      `SELECT id, external_id, status, created_at, shipped_at, wb_accepted_at
       FROM wms.shipments WHERE external_id=$1`,
      [code]
    );
    if (sRes.rowCount === 0) {
      console.log(`Поставка ${code} не найдена в wms.shipments.`);
      return;
    }
    const s = sRes.rows[0];

    const tokenRes = await client.query(
      `SELECT ma.api_token
       FROM wms.wb_orders wo
       JOIN wms.mp_accounts ma ON ma.id = wo.mp_account_id
       WHERE wo.wb_supply_id=$1 AND ma.api_token IS NOT NULL
       LIMIT 1`,
      [code]
    );
    if (tokenRes.rowCount === 0) {
      console.log(`Не нашёл токен WB-аккаунта для поставки ${code} (нет заказов с сопоставленным mp_account).`);
      return;
    }
    const token = tokenRes.rows[0].api_token;

    console.log('=== НАША БАЗА (wms.shipments) ===');
    console.log(s);
    console.log('');

    console.log('=== ЗАПРОС К WB: GET /api/v3/supplies/' + code + ' ===');
    const details = await wbClient.getSupplyDetails(token, code);
    console.log(details);
    console.log('');

    if (details && details.scanDt) {
      const scanDt = new Date(details.scanDt);
      console.log(`scanDt (WB, UTC):  ${scanDt.toISOString()}`);
      console.log(`scanDt (МСК, UTC+3): ${new Date(scanDt.getTime() + 3 * 3600000).toISOString().replace('T', ' ').slice(0, 16)}`);
    } else {
      console.log('scanDt отсутствует в ответе WB (возможно, поставка ещё не отсканирована на приёмке).');
    }
    if (s.wb_accepted_at) {
      console.log(`Наш wb_accepted_at (UTC):    ${new Date(s.wb_accepted_at).toISOString()}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => {
  console.error('Ошибка:', e.message);
  process.exit(1);
});
