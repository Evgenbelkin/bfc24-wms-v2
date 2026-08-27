'use strict';

require('dotenv').config();

const { query, pool } = require('../src/config/database');
const wbClient = require('../src/modules/wb/wb.client');

// =============================================================================
// Разовая сверка: реальные остатки на WB (живой запрос к WB API по каждому
// складу продавца) против фактических остатков в WMS (wms.stock_balances).
//
// НЕ использует wms.wb_stock_distribution - та таблица хранит только то, что
// МЫ САМИ в последний раз посчитали и попытались отправить, и может быть
// устаревшей (ровно это и стало причиной инцидента с оверселлом). Здесь же
// спрашиваем напрямую у WB, что у него сейчас записано по каждому SKU на
// каждом складе - это единственный способ увидеть реальное расхождение, а не
// ещё раз довериться собственным расчётам.
//
// Запуск (с сервера, где лежит server/.env):
//   cd server && node scripts/wb-stock-reconcile.js
//
// Печатает по каждому активному WB-аккаунту товары, где остаток в WB не
// совпадает с WMS в любую сторону: WB больше (кандидаты на оверселл, как
// было с 2006784216833) или WB меньше/ноль при ненулевом остатке в WMS
// (остаток не ушёл в WB - недопродажа/сбой push'а, инцидент 27.08.2026).
// =============================================================================

const SKU_CHUNK = 1000; // лимит WB на кол-во skus в одном запросе
const PAUSE_MS = 350;   // пауза между запросами к WB, чтобы не словить 429

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const accountsRes = await query(`
    SELECT ma.id, ma.tenant_id, ma.client_id, ma.api_token, ma.account_name, c.client_name
    FROM wms.mp_accounts ma
    JOIN wms.clients c ON c.id = ma.client_id
    WHERE ma.marketplace='wb' AND ma.is_active=TRUE AND ma.api_token IS NOT NULL
    ORDER BY ma.id
  `);

  if (accountsRes.rowCount === 0) {
    console.log('Нет активных WB-аккаунтов с токеном.');
    await pool.end();
    return;
  }

  let totalMismatches = 0;

  for (const acc of accountsRes.rows) {
    console.log(`\n=== Аккаунт #${acc.id} "${acc.account_name || ''}" - клиент "${acc.client_name}" (client_id=${acc.client_id}) ===`);

    const whRes = await query(`
      SELECT wb_warehouse_id, warehouse_code, warehouse_name
      FROM wms.wb_seller_warehouses
      WHERE mp_account_id=$1 AND is_active=TRUE
      ORDER BY warehouse_name
    `, [acc.id]);

    if (whRes.rowCount === 0) {
      console.log('  Нет складов WB для этого аккаунта, пропуск.');
      continue;
    }

    // Штрихкоды, зарегистрированные в WB под этим аккаунтом - только их и
    // имеет смысл спрашивать (см. комментарий в distributeStockForAccount про
    // "не пушим то, чего у WB вообще нет в карточках").
    const barcodesRes = await query(`
      SELECT DISTINCT barcode FROM wms.wb_item_barcodes WHERE mp_account_id=$1
    `, [acc.id]);
    const skus = barcodesRes.rows.map(r => r.barcode).filter(Boolean);
    if (skus.length === 0) {
      console.log('  Нет зарегистрированных штрихкодов WB, пропуск.');
      continue;
    }
    const skuChunks = chunk(skus, SKU_CHUNK);

    // 1) Реальные остатки WB - суммируем по всем складам аккаунта -> barcode -> qty
    const wbTotals = new Map();
    for (const w of whRes.rows) {
      for (const c of skuChunks) {
        let stocks;
        try {
          stocks = await wbClient.fetchFbsStocks(acc.api_token, w.wb_warehouse_id, c);
        } catch (e) {
          console.error(`  ! ошибка запроса склада "${w.warehouse_name}" (${w.wb_warehouse_id}): ${e.message}`);
          continue;
        }
        for (const s of stocks) {
          const barcode = s.sku;
          if (!barcode) continue;
          const qty = Number(s.amount || 0);
          // Не пропускаем qty<=0 - явный ноль от WB тоже должен попасть в
          // wbTotals, иначе (см. правку сравнения ниже) случай "в WMS есть,
          // в WB реально 0" никогда не будет замечен.
          wbTotals.set(barcode, (wbTotals.get(barcode) || 0) + qty);
        }
        await sleep(PAUSE_MS);
      }
    }

    // 2) Реальные остатки WMS сейчас, по тем же штрихкодам этого клиента
    const wmsRes = await query(`
      SELECT sb.barcode, SUM(sb.qty_available)::int AS qty, MAX(i.item_name) AS item_name
      FROM wms.stock_balances sb
      JOIN wms.items i ON i.id = sb.item_id
      WHERE sb.client_id=$1
      GROUP BY sb.barcode
    `, [acc.client_id]);
    const wmsMap = new Map(wmsRes.rows.map(r => [r.barcode, { qty: Number(r.qty), name: r.item_name }]));

    // 3) Сравнение - идём по ПОЛНОМУ списку зарегистрированных штрихкодов
    // (skus), а не только по тем, что вернул WB - иначе штрихкод, по которому
    // WB вообще не прислал строку (или прислал 0, раньше отфильтровывалось
    // выше), просто не участвовал бы в сравнении. Сравниваем в обе стороны:
    // diff>0 - WB показывает больше, чем есть (риск оверселла); diff<0 - в
    // WMS остаток есть, а в WB меньше/ноль (не ушло в WB - тоже проблема,
    // раньше именно этот случай был не виден вообще).
    let anyMismatch = false;
    const rows = [];
    for (const barcode of skus) {
      const wbQty = wbTotals.get(barcode) || 0;
      const wms = wmsMap.get(barcode) || { qty: 0, name: '(нет остатка в WMS)' };
      const diff = wbQty - wms.qty;
      if (diff !== 0) {
        anyMismatch = true;
        rows.push({ barcode, name: wms.name, wbQty, wmsQty: wms.qty, diff });
      }
    }
    rows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

    if (!anyMismatch) {
      console.log('  OK: WB и WMS совпадают, расхождений нет.');
    } else {
      console.log('  barcode           | diff  | WB итого | WMS сейчас | товар');
      for (const r of rows) {
        const sign = r.diff > 0 ? '+' : '';
        const tag = r.diff > 0 ? 'оверселл' : 'не ушло в WB';
        console.log(
          `  ${r.barcode.padEnd(17)} | ${(sign + r.diff).padEnd(5)} | ${String(r.wbQty).padEnd(8)} | ${String(r.wmsQty).padEnd(10)} | ${r.name}  [${tag}]`
        );
        totalMismatches++;
      }
    }
  }

  console.log(`\n=== Итого товаров с расхождением (в любую сторону) по всем аккаунтам: ${totalMismatches} ===`);
  await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
