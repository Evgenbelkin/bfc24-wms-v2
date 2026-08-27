'use strict';

require('dotenv').config();

const { query, pool } = require('../src/config/database');

// =============================================================================
// Разовая диагностика по ОДНОМУ штрихкоду - прогоняем те же шаги, что и
// distributeStockForAccount, чтобы увидеть, где именно теряются недостающие
// единицы. Запуск: node scripts/diag-barcode-detail.js <barcode>
// =============================================================================

async function main() {
  const barcode = process.argv[2];
  if (!barcode) { console.error('Usage: node diag-barcode-detail.js <barcode>'); process.exit(1); }

  const itemRes = await query(
    `SELECT wib.mp_account_id, wib.nm_id, wib.chrt_id, ma.tenant_id, ma.client_id, ma.account_name
     FROM wms.wb_item_barcodes wib
     JOIN wms.mp_accounts ma ON ma.id = wib.mp_account_id
     WHERE wib.barcode=$1`,
    [barcode]
  );
  console.log('=== wb_item_barcodes / mp_account ===');
  console.log(itemRes.rows);
  if (itemRes.rowCount === 0) { await pool.end(); return; }
  const { tenant_id: tenantId, client_id: clientId, mp_account_id: mpAccountId } = itemRes.rows[0];

  console.log('\n=== stock_balances по ячейкам ===');
  const sb = await query(
    `SELECT sb.qty_on_hand, sb.qty_reserved, sb.qty_available, l.location_code, l.is_pick_location, l.is_active
     FROM wms.stock_balances sb
     JOIN wms.locations l ON l.id = sb.location_id
     WHERE sb.tenant_id=$1 AND sb.client_id=$2 AND sb.barcode=$3`,
    [tenantId, clientId, barcode]
  );
  console.log(sb.rows);
  const pickQty = sb.rows.filter(r => r.is_pick_location).reduce((s, r) => s + Number(r.qty_available), 0);
  console.log(`Сумма qty_available по pick-ячейкам: ${pickQty}`);

  console.log('\n=== wb_orders (все статусы) по этому штрихкоду ===');
  const wo = await query(
    `SELECT wo.wb_order_id, wo.status, wo.wb_supply_id, wo.created_at, wo.fetched_at, s.status AS shipment_status
     FROM wms.wb_orders wo
     LEFT JOIN wms.shipments s ON s.tenant_id=wo.tenant_id AND s.external_id=wo.wb_supply_id
     WHERE wo.tenant_id=$1 AND wo.mp_account_id=$2 AND wo.barcode=$3
     ORDER BY wo.status, wo.created_at DESC`,
    [tenantId, mpAccountId, barcode]
  );
  console.log(wo.rows);
  const openOrders = wo.rows.filter(r => ['new', 'confirm'].includes(r.status));
  console.log(`Открытых заказов (new+confirm), вычитаются при пересчёте: ${openOrders.length}`);

  console.log('\n=== wms.wb_stock_distribution (что мы в последний раз посчитали и отправили) ===');
  const dist = await query(
    `SELECT warehouse_code, qty, calculated_at, updated_at
     FROM wms.wb_stock_distribution
     WHERE tenant_id=$1 AND mp_account_id=$2 AND barcode=$3
     ORDER BY warehouse_code`,
    [tenantId, mpAccountId, barcode]
  );
  console.log(dist.rows);
  const distTotal = dist.rows.reduce((s, r) => s + Number(r.qty), 0);
  console.log(`Сумма по последнему расчёту (то, что должны были отправить в WB): ${distTotal}`);

  console.log('\n=== Резервный %, склады аккаунта ===');
  const acc = await query(`SELECT settings FROM wms.mp_accounts WHERE id=$1`, [mpAccountId]);
  console.log(acc.rows[0]);
  const wh = await query(
    `SELECT warehouse_code, weight, is_enabled_for_dist, is_active FROM wms.wb_seller_warehouses WHERE mp_account_id=$1`,
    [mpAccountId]
  );
  console.log(wh.rows);

  await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
