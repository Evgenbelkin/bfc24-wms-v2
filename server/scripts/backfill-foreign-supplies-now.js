#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const wbService = require('../src/modules/wb/wb.service');

// =============================================================================
// Разовый ручной запуск syncForeignSuppliesForAccount ДЛЯ ОДНОГО аккаунта,
// не дожидаясь его очереди в round-robin джобе wbForeignSupplySync (владелец,
// 19.09.2026: аккаунт "ИП Макарова С. И" (#10) проходит все условия выборки,
// но не был обработан из-за частых рестартов сервера, сбрасывающих
// in-memory курсор джобы на 0).
//
// Использование (на VPS, из папки server/):
//   node scripts/backfill-foreign-supplies-now.js <mp_account_id>
// =============================================================================

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME     || 'bfc24_v2',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

async function main() {
  const accountId = process.argv[2];
  if (!accountId) {
    console.error('Использование: node scripts/backfill-foreign-supplies-now.js <mp_account_id>');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    const accRes = await client.query(
      `SELECT id, tenant_id, account_name, api_token FROM wms.mp_accounts WHERE id=$1`,
      [accountId]
    );
    if (accRes.rowCount === 0) {
      console.log(`Аккаунт #${accountId} не найден.`);
      return;
    }
    const acc = accRes.rows[0];
    if (!acc.api_token) {
      console.log(`У аккаунта #${accountId} ("${acc.account_name}") нет токена.`);
      return;
    }
    console.log(`Запускаю синхронизацию чужих поставок для аккаунта #${acc.id} "${acc.account_name}" (tenant_id=${acc.tenant_id})...`);

    const result = await wbService.syncForeignSuppliesForAccount({
      tenantId: acc.tenant_id,
      accountId: acc.id,
      apiToken: acc.api_token,
    });

    console.log('\nГотово. Результат:');
    console.log(JSON.stringify(result, null, 2));
    console.log('\nЕсли newLookups достиг лимита (30) - значит, за один запуск докачали не всё,');
    console.log('запустите скрипт ещё раз через минуту-другую, чтобы докачать остаток.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('Ошибка:', e);
  process.exit(1);
});
