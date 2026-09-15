#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { Pool } = require('pg');

// =============================================================================
// Диагностика (срочная, 15.09.2026): клиент "ООО Эсэндди" (tenant_code
// ooo-esenddi) не может принять товар — "Товар со штрихкодом 'X' не найден
// в каталоге этого клиента". Импорт карточек нажимали, не помогло.
//
// Смотрим по каждому штрихкоду везде, где он мог бы засветиться:
//  - wms.items / wms.item_barcodes (то, что реально требует resolveExistingItem
//    при приёмке — если тут пусто, приёмка не пройдёт)
//  - wms.wb_item_barcodes + wms.wb_items (сырое зеркало каталога WB, куда
//    падает fetchItems ДО того, как из него пытаются создать wms.items —
//    если штрихкод есть тут, но не в wms.items, значит импорт карточек
//    ЗНАЕТ про товар, но по какой-то причине не завёл сам wms.items,
//    например card.title оказался пустым — см. importItemsForAccount)
//
// Использование:
//   cd server && node scripts/diagnose-missing-item.js <tenant_code> <barcode1> [barcode2 ...]
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
  const barcodes = process.argv.slice(3);
  if (!tenantCode || !barcodes.length) {
    console.error('Использование: node scripts/diagnose-missing-item.js <tenant_code> <barcode1> [barcode2 ...]');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    const tRes = await client.query(`SELECT id, company_name, tenant_code FROM platform.tenants WHERE tenant_code=$1`, [tenantCode]);
    if (tRes.rowCount === 0) {
      console.log(`Тенант с кодом '${tenantCode}' не найден. Проверьте написание (обычно нижний регистр, дефисы).`);
      return;
    }
    const tenant = tRes.rows[0];
    console.log(`Тенант: ${tenant.company_name} (id=${tenant.id}, code=${tenant.tenant_code})\n`);

    const accRes = await client.query(
      `SELECT ma.id, ma.client_id, c.client_name, ma.account_name, ma.is_active,
              (ma.api_token IS NOT NULL) AS has_token
       FROM wms.mp_accounts ma
       JOIN wms.clients c ON c.id = ma.client_id
       WHERE ma.tenant_id=$1 AND ma.marketplace='wb'
       ORDER BY ma.id`,
      [tenant.id]
    );
    console.log('WB-аккаунты тенанта:');
    for (const a of accRes.rows) {
      console.log(`  #${a.id} "${a.account_name}" -> клиент "${a.client_name}" (client_id=${a.client_id}), активен=${a.is_active}, токен=${a.has_token ? 'есть' : 'НЕТ'}`);
    }
    console.log('');

    for (const barcode of barcodes) {
      console.log(`=== Штрихкод ${barcode} ===`);

      const itemRes = await client.query(
        `SELECT i.id, i.client_id, c.client_name, i.item_name, i.is_active, i.source, i.created_at
         FROM wms.items i JOIN wms.clients c ON c.id=i.client_id
         WHERE i.tenant_id=$1 AND i.barcode=$2`,
        [tenant.id, barcode]
      );
      if (itemRes.rowCount > 0) {
        for (const r of itemRes.rows) {
          console.log(`  wms.items (основной штрихкод): id=${r.id}, клиент="${r.client_name}" (${r.client_id}), название="${r.item_name}", активен=${r.is_active}, источник=${r.source}, создан=${r.created_at.toISOString()}`);
        }
      } else {
        console.log('  wms.items (основной штрихкод): НЕТ');
      }

      const aliasRes = await client.query(
        `SELECT ib.item_id, ib.client_id, c.client_name, i.item_name, i.is_active
         FROM wms.item_barcodes ib
         JOIN wms.clients c ON c.id=ib.client_id
         JOIN wms.items i ON i.id=ib.item_id
         WHERE ib.tenant_id=$1 AND ib.barcode=$2`,
        [tenant.id, barcode]
      );
      if (aliasRes.rowCount > 0) {
        for (const r of aliasRes.rows) {
          console.log(`  wms.item_barcodes (алиас): item_id=${r.item_id}, клиент="${r.client_name}" (${r.client_id}), название="${r.item_name}", активен=${r.is_active}`);
        }
      } else {
        console.log('  wms.item_barcodes (алиас): НЕТ');
      }

      const wbRes = await client.query(
        `SELECT wib.mp_account_id, wib.nm_id, wib.chrt_id, wi.title, wi.vendor_code, wi.brand, wi.updated_at
         FROM wms.wb_item_barcodes wib
         LEFT JOIN wms.wb_items wi ON wi.tenant_id=wib.tenant_id AND wi.mp_account_id=wib.mp_account_id AND wi.nm_id=wib.nm_id
         WHERE wib.tenant_id=$1 AND wib.barcode=$2`,
        [tenant.id, barcode]
      );
      if (wbRes.rowCount > 0) {
        for (const r of wbRes.rows) {
          console.log(`  wms.wb_item_barcodes (сырой каталог WB): mp_account_id=${r.mp_account_id}, nm_id=${r.nm_id}, chrt_id=${r.chrt_id}, title="${r.title}", vendor_code="${r.vendor_code}", обновлено=${r.updated_at ? r.updated_at.toISOString() : '—'}`);
          if (!r.title) {
            console.log('    !!! title ПУСТОЙ - именно из-за этого importItemsForAccount пропускает создание wms.items (см. "if (!existing && card.title)")');
          }
        }
      } else {
        console.log('  wms.wb_item_barcodes (сырой каталог WB): НЕТ - WB вообще не отдал этот штрихкод в fetchItems для этого тенанта');
      }
      console.log('');
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
