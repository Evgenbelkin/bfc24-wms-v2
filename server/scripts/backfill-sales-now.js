#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const wbService = require('../src/modules/wb/wb.service');

// =============================================================================
// Разовый ручной запуск syncSalesForAccount ДЛЯ ОДНОГО аккаунта, не дожидаясь
// его очереди в джобе wbSalesSync (курсор там - "самый давно не синканный
// аккаунт", см. комментарий в самой джобе; новый аккаунт/первый прогон после
// деплоя миграции 070 может ждать своей очереди до нескольких тиков).
//
// Statistics API /api/v1/supplier/sales - жёсткий лимит WB 1 запрос/минуту,
// поэтому скрипт ждёт 61с между попытками и не гонится вычерпать всю
// 90-дневную историю за один запуск - на практике достаточно 1-3 проходов,
// т.к. интересны только заказы, ещё не выгруженные "из оборота" (обычно
// последние несколько дней, не вся глубина).
//
// Использование (на VPS, из папки server/):
//   node scripts/backfill-sales-now.js <mp_account_id>
// =============================================================================

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME     || 'bfc24_v2',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

const MAX_ROUNDS = 10;

async function main() {
  const accountId = process.argv[2];
  if (!accountId) {
    console.error('Использование: node scripts/backfill-sales-now.js <mp_account_id>');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    const accRes = await client.query(
      `SELECT id, tenant_id, account_name, api_token, api_token_stats, settings
       FROM wms.mp_accounts WHERE id=$1`,
      [accountId]
    );
    if (accRes.rowCount === 0) {
      console.log(`Аккаунт #${accountId} не найден.`);
      return;
    }
    const acc = accRes.rows[0];
    const token = acc.api_token_stats || acc.api_token;
    if (!token) {
      console.log(`У аккаунта #${accountId} ("${acc.account_name}") нет токена.`);
      return;
    }
    console.log(`Запускаю синхронизацию реального времени продажи для аккаунта #${acc.id} "${acc.account_name}" (tenant_id=${acc.tenant_id})...`);

    let settings = acc.settings || {};
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      console.log(`\n--- Проход ${round}/${MAX_ROUNDS} ---`);
      const result = await wbService.syncSalesForAccount({
        tenantId: acc.tenant_id,
        accountId: acc.id,
        apiToken: token,
        settings,
      });
      console.log(JSON.stringify(result, null, 2));

      if (!result.fetched) {
        console.log('\nНовых строк нет — история докачана полностью.');
        break;
      }

      // Перечитываем settings из БД (syncSalesForAccount сам обновил курсор там)
      const freshRes = await client.query(`SELECT settings FROM wms.mp_accounts WHERE id=$1`, [accountId]);
      settings = freshRes.rows[0]?.settings || settings;

      if (round < MAX_ROUNDS) {
        console.log('Жду 61с (лимит WB Statistics API - 1 запрос/минуту)...');
        await sleep(61_000);
      }
    }

    console.log('\nГотово.');
  } finally {
    client.release();
    await pool.end();
  }
}

main()
  .then(() => process.exit(0)) // wb.service.js держит открытым свой (общий) пул к БД -
  .catch((e) => {              // без явного exit() процесс никогда бы сам не завершился
    console.error('Ошибка:', e);
    process.exit(1);
  });
