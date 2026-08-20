'use strict';

require('dotenv').config();

const { query, pool } = require('../src/config/database');
const wbService = require('../src/modules/wb/wb.service');

// =============================================================================
// Разовый принудительный пересчёт и отправка остатков в WB для ОДНОГО аккаунта -
// используется, когда wb-stock-reconcile.js нашёл расхождение (WB > WMS) и
// нужно срочно перезаписать устаревшие цифры на WB актуальными из WMS, не
// дожидаясь планового cron'а (server/src/jobs/wbStockSync.js, раз в 8ч).
//
// Запуск (с сервера, где лежит server/.env):
//   cd server && node scripts/wb-stock-fix-now.js <mp_account_id>
//
// Без аргумента - ошибка (чтобы случайно не пересчитать не тот аккаунт).
// =============================================================================

async function main() {
  const mpAccountId = Number(process.argv[2]);
  if (!mpAccountId) {
    console.error('Использование: node scripts/wb-stock-fix-now.js <mp_account_id>');
    process.exit(1);
  }

  const accRes = await query(
    `SELECT ma.id, ma.tenant_id, ma.client_id, ma.account_name, c.client_name
     FROM wms.mp_accounts ma JOIN wms.clients c ON c.id = ma.client_id
     WHERE ma.id=$1`,
    [mpAccountId]
  );
  if (accRes.rowCount === 0) {
    console.error(`Аккаунт #${mpAccountId} не найден.`);
    await pool.end();
    process.exit(1);
  }
  const acc = accRes.rows[0];
  console.log(`Пересчитываю и отправляю остатки для аккаунта #${acc.id} "${acc.account_name || ''}" (клиент "${acc.client_name}")...`);

  const result = await wbService.distributeStockForAccount({
    tenantId: acc.tenant_id,
    mpAccountId: acc.id,
  });

  console.log('Готово:', JSON.stringify(result, null, 2));
  await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
