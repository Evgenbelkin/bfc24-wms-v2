#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { Pool } = require('pg');

// =============================================================================
// Диагностика (19.09.2026): почему аккаунт клиента "ИП Макарова С. И." не
// попадает в выборку listAllWbAccountsForForeignSupplySync() (джоба
// wbForeignSupplySync), хотя на карточке аккаунта всё выглядит валидно
// (Активен ✓, API-токен заполнен, marketplace = WB). В логах джобы за
// проход по всем аккаунтам (id 1,2,3,6,7,9) её аккаунта нет.
//
// Скрипт проверяет её аккаунт(ы) по КАЖДОМУ условию WHERE/JOIN из
// listAllWbAccountsForForeignSupplySync по отдельности, чтобы точно найти,
// на каком условии отсеивается:
//   ma.marketplace='wb' AND ma.is_active=TRUE AND ma.api_token IS NOT NULL
//   JOIN platform.tenants t ON t.id=ma.tenant_id AND t.status IN ('trial','active')
//   JOIN platform.tenant_modules tm ON tm.tenant_id=t.id AND tm.module_code='warehouse_insights'
//
// Использование (на VPS, из папки server/):
//   node scripts/diagnose-foreign-supply-account.js "Макарова"
// (передайте часть названия аккаунта — поиск через ILIKE)
// =============================================================================

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME     || 'bfc24_v2',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

async function main() {
  const nameFilter = process.argv[2] || 'Макаров';

  const client = await pool.connect();
  try {
    const accRes = await client.query(
      `SELECT id, tenant_id, client_id, account_name, marketplace, is_active,
              api_token IS NOT NULL AS has_token,
              length(trim(coalesce(api_token,''))) AS token_len
         FROM wms.mp_accounts
        WHERE account_name ILIKE '%' || $1 || '%'
        ORDER BY id`,
      [nameFilter]
    );

    if (accRes.rowCount === 0) {
      console.log(`Не найдено ни одного аккаунта с названием, содержащим "${nameFilter}".`);
      return;
    }

    console.log(`Найдено аккаунтов: ${accRes.rowCount}\n`);

    for (const acc of accRes.rows) {
      console.log('='.repeat(70));
      console.log(`Аккаунт #${acc.id} "${acc.account_name}"`);
      console.log(`  tenant_id=${acc.tenant_id}  client_id=${acc.client_id}`);
      console.log(`  marketplace='${acc.marketplace}'  is_active=${acc.is_active}`);
      console.log(`  has_token=${acc.has_token}  token_len=${acc.token_len}`);

      // Условие 1: базовые поля на самом mp_accounts
      const cond1 =
        acc.marketplace === 'wb' && acc.is_active === true && acc.has_token === true;
      console.log(`  [1] marketplace='wb' AND is_active=TRUE AND api_token IS NOT NULL -> ${cond1 ? 'OK' : 'FAIL <-- ПРИЧИНА'}`);

      // Условие 2: platform.tenants статус
      const tenantRes = await client.query(
        `SELECT id, name, status FROM platform.tenants WHERE id=$1`,
        [acc.tenant_id]
      );
      if (tenantRes.rowCount === 0) {
        console.log(`  [2] platform.tenants WHERE id=${acc.tenant_id} -> НЕ НАЙДЕН tenant! <-- ПРИЧИНА`);
      } else {
        const t = tenantRes.rows[0];
        const cond2 = ['trial', 'active'].includes(t.status);
        console.log(`  [2] tenant "${t.name}" status='${t.status}' IN (trial,active) -> ${cond2 ? 'OK' : 'FAIL <-- ПРИЧИНА'}`);
      }

      // Условие 3: platform.tenant_modules содержит warehouse_insights
      const modRes = await client.query(
        `SELECT module_code FROM platform.tenant_modules WHERE tenant_id=$1`,
        [acc.tenant_id]
      );
      const modules = modRes.rows.map(r => r.module_code);
      const cond3 = modules.includes('warehouse_insights');
      console.log(`  [3] platform.tenant_modules для tenant_id=${acc.tenant_id}: [${modules.join(', ')}]`);
      console.log(`      содержит 'warehouse_insights' -> ${cond3 ? 'OK' : 'FAIL <-- ПРИЧИНА'}`);

      // Условие 4: воспроизводим точный запрос джобы и проверяем, попадает
      // ли именно эта строка в итоговую выборку
      const exactRes = await client.query(
        `SELECT ma.id
           FROM wms.mp_accounts ma
           JOIN platform.tenants t ON t.id=ma.tenant_id AND t.status IN ('trial','active')
           JOIN platform.tenant_modules tm ON tm.tenant_id=t.id AND tm.module_code='warehouse_insights'
          WHERE ma.marketplace='wb' AND ma.is_active=TRUE AND ma.api_token IS NOT NULL
            AND ma.id=$1`,
        [acc.id]
      );
      const inJob = exactRes.rowCount > 0;
      console.log(`  [ИТОГ] Точный запрос джобы возвращает этот аккаунт -> ${inJob ? 'ДА (должен обрабатываться)' : 'НЕТ, ИСКЛЮЧЁН'}`);
      console.log('');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error('Ошибка:', e);
  process.exit(1);
});
