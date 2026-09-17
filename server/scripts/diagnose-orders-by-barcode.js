#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { Pool } = require('pg');

// =============================================================================
// Диагностика (15.09.2026): клиент утверждает, что товары со штрихкодами
// 4640258650037 / 4650645080187 УЖЕ продаются на WB и падают в заказы -
// значит WB API их точно знает, просто, видимо, не под тем токеном/аккаунтом,
// который мы проверяли (mp_account #12 "КОСМОПРОФ", 96 карточек, этих SKU нет).
//
// Смотрим по каким заказам (wms.wb_orders) реально приходил этот штрихкод -
// это укажет напрямую, под каким mp_account_id (и значит каким токеном) WB
// отдаёт эти товары, и тогда прогоним diagnose-wb-live.js уже по правильному
// аккаунту.
//
// Использование:
//   cd server && node scripts/diagnose-orders-by-barcode.js <tenant_code> <barcode1> [barcode2 ...] [--nmids n1,n2]
// =============================================================================

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME     || 'bfc24_v2',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

async function main() {
  const tenantCode = process.argv[2];
  const rest = process.argv.slice(3);
  const barcodes = [];
  let nmids = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--nmids') {
      nmids = (rest[i + 1] || '').split(',').map(s => s.trim()).filter(Boolean);
      i++;
    } else if (rest[i]) {
      barcodes.push(rest[i]);
    }
  }
  if (!tenantCode || (!barcodes.length && !nmids.length)) {
    console.error('Использование: node scripts/diagnose-orders-by-barcode.js <tenant_code> <barcode1> [barcode2 ...] [--nmids n1,n2]');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    const tRes = await client.query(`SELECT id, company_name FROM platform.tenants WHERE tenant_code=$1`, [tenantCode]);
    if (tRes.rowCount === 0) {
      console.log(`Тенант '${tenantCode}' не найден.`);
      return;
    }
    const tenant = tRes.rows[0];
    console.log(`Тенант: ${tenant.company_name} (id=${tenant.id})\n`);

    // Общая сводка синка заказов по каждому WB-аккаунту - чтобы понять,
    // работает ли синк заказов вообще и когда он последний раз что-то принёс.
    const accSummary = await client.query(
      `SELECT ma.id, ma.account_name, COUNT(wo.id)::int AS orders_cnt,
              MIN(wo.created_at) AS first_order, MAX(wo.created_at) AS last_order,
              MAX(wo.fetched_at) AS last_fetched
       FROM wms.mp_accounts ma
       LEFT JOIN wms.wb_orders wo ON wo.mp_account_id = ma.id
       WHERE ma.tenant_id=$1 AND ma.marketplace='wb'
       GROUP BY ma.id, ma.account_name
       ORDER BY ma.id`,
      [tenant.id]
    );
    console.log('Сводка синка заказов по WB-аккаунтам:');
    for (const r of accSummary.rows) {
      console.log(`  #${r.id} "${r.account_name}": заказов=${r.orders_cnt}, первый=${r.first_order ? r.first_order.toISOString() : '—'}, последний=${r.last_order ? r.last_order.toISOString() : '—'}, последний синк=${r.last_fetched ? r.last_fetched.toISOString() : '—'}`);
    }
    console.log('');

    for (const barcode of barcodes) {
      console.log(`=== Заказы WB со штрихкодом ${barcode} ===`);
      const r = await client.query(
        `SELECT wo.id, wo.mp_account_id, ma.account_name, ma.client_id, c.client_name,
                wo.nm_id, wo.article, wo.barcode, wo.status, wo.created_at
         FROM wms.wb_orders wo
         LEFT JOIN wms.mp_accounts ma ON ma.id = wo.mp_account_id
         LEFT JOIN wms.clients c ON c.id = ma.client_id
         WHERE wo.tenant_id = $1 AND wo.barcode = $2
         ORDER BY wo.created_at DESC LIMIT 10`,
        [tenant.id, barcode]
      );
      if (r.rowCount === 0) {
        console.log('  НЕТ заказов с этим штрихкодом в wms.wb_orders для этого тенанта');
      } else {
        for (const row of r.rows) {
          console.log(`  order_id=${row.id}, mp_account_id=${row.mp_account_id} ("${row.account_name}", клиент="${row.client_name}"), nm_id=${row.nm_id}, article=${row.article}, status=${row.status}, создан=${row.created_at ? row.created_at.toISOString() : '—'}`);
        }
      }
      console.log('');
    }

    if (nmids.length) {
      for (const nmId of nmids) {
        console.log(`=== Заказы WB c nm_id ${nmId} ===`);
        const r = await client.query(
          `SELECT wo.id, wo.mp_account_id, ma.account_name, wo.nm_id, wo.article, wo.barcode, wo.status, wo.created_at
           FROM wms.wb_orders wo
           LEFT JOIN wms.mp_accounts ma ON ma.id = wo.mp_account_id
           WHERE wo.tenant_id = $1 AND wo.nm_id = $2
           ORDER BY wo.created_at DESC LIMIT 10`,
          [tenant.id, nmId]
        );
        if (r.rowCount === 0) {
          console.log('  НЕТ заказов с этим nm_id в wms.wb_orders для этого тенанта');
        } else {
          for (const row of r.rows) {
            console.log(`  order_id=${row.id}, mp_account_id=${row.mp_account_id} ("${row.account_name}"), article=${row.article}, barcode=${row.barcode}, status=${row.status}, создан=${row.created_at ? row.created_at.toISOString() : '—'}`);
          }
        }
        console.log('');
      }
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
