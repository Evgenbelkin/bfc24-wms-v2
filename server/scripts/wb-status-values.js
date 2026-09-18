'use strict';

require('dotenv').config();

const { pool, query } = require('../src/config/database');

// =============================================================================
// Разовая проверка: какие РЕАЛЬНЫЕ значения wb_status у нас реально
// накопились в базе (и в wms.wb_orders, и в истории событий) - пригодится,
// если окажется, что задокументированный по блог-посту список статусов
// устарел/неполон (уже поймали 'ready_for_pickup', которого не было в
// исходном списке waiting/sorted/sold/canceled/canceled_by_client/
// declined_by_client/defect).
//
// Запуск: node scripts/wb-status-values.js <tenant_id>
// =============================================================================

async function main() {
  const tenantId = Number(process.argv[2]);
  if (!tenantId) {
    console.error('Использование: node scripts/wb-status-values.js <tenant_id>');
    process.exit(1);
  }

  const cur = await query(
    `SELECT wb_status, COUNT(*) AS qty FROM wms.wb_orders WHERE tenant_id=$1 GROUP BY wb_status ORDER BY qty DESC`,
    [tenantId]
  );
  console.log('Текущий wb_status в wms.wb_orders:');
  for (const row of cur.rows) console.log(`  ${String(row.wb_status).padEnd(24)} ${row.qty} шт`);

  const hist = await query(
    `SELECT e.wb_status, COUNT(*) AS qty FROM wms.wb_order_status_events e
     JOIN wms.wb_orders wo ON wo.mp_account_id=e.mp_account_id AND wo.wb_order_id=e.wb_order_id
     WHERE wo.tenant_id=$1 GROUP BY e.wb_status ORDER BY qty DESC`,
    [tenantId]
  );
  console.log('\nСтатусы, встречавшиеся в истории переходов (wms.wb_order_status_events):');
  for (const row of hist.rows) console.log(`  ${String(row.wb_status).padEnd(24)} ${row.qty} шт`);

  await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
