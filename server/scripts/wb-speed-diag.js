'use strict';

require('dotenv').config();

const { pool, query } = require('../src/config/database');

// =============================================================================
// Диагностика для проверки гипотезы: "срок до WB" в аналитике FBS был
// ложно раздут для части заказов, у которых в истории (wms.wb_order_status_events,
// миграция 052) нет события wb_status='sorted' - она завелась ПОЗЖЕ, чем уже
// шёл опрос статуса (миграция 051), поэтому у заказов, переставших быть
// 'waiting' ДО появления таблицы истории, событие 'sorted' никогда не
// записалось. Раньше запрос брал "любое первое событие != waiting" - если
// единственным записанным событием оказывался, например, 'sold' (потому что
// именно ОН случился уже ПОСЛЕ появления истории), заказ засчитывался так,
// будто "ехал до WB" все дни до самого выкупа. Исправлено - теперь ищем
// именно wb_status='sorted'.
//
// Запуск: node scripts/wb-speed-diag.js <tenant_id>
// =============================================================================

async function main() {
  const tenantId = Number(process.argv[2]);
  if (!tenantId) {
    console.error('Использование: node scripts/wb-speed-diag.js <tenant_id>');
    process.exit(1);
  }

  const affected = await query(
    `SELECT wo.wb_order_id, wo.created_at, wo.wb_status, wo.wb_status_updated_at
     FROM wms.wb_orders wo
     WHERE wo.tenant_id=$1
       AND EXISTS (
         SELECT 1 FROM wms.wb_order_status_events e
         WHERE e.mp_account_id=wo.mp_account_id AND e.wb_order_id=wo.wb_order_id AND e.wb_status != 'waiting'
       )
       AND NOT EXISTS (
         SELECT 1 FROM wms.wb_order_status_events e2
         WHERE e2.mp_account_id=wo.mp_account_id AND e2.wb_order_id=wo.wb_order_id AND e2.wb_status = 'sorted'
       )
       AND wo.created_at >= NOW() - INTERVAL '30 days'
     ORDER BY wo.created_at DESC
     LIMIT 15`,
    [tenantId]
  );

  console.log(`Заказов без честного события 'sorted' в истории (значит раньше искажали срок до WB): найдено ${affected.rowCount} (показаны первые 15).`);
  for (const row of affected.rows) {
    const evRes = await query(
      `SELECT wb_status, observed_at FROM wms.wb_order_status_events
       WHERE mp_account_id=(SELECT mp_account_id FROM wms.wb_orders WHERE tenant_id=$1 AND wb_order_id=$2 LIMIT 1)
         AND wb_order_id=$2 ORDER BY observed_at ASC`,
      [tenantId, row.wb_order_id]
    );
    const events = evRes.rows.map(e => `${e.wb_status}@${e.observed_at.toISOString().slice(0,16)}`).join(', ') || '(нет событий)';
    console.log(`  заказ ${row.wb_order_id}  создан ${row.created_at.toISOString().slice(0,16)}  текущий wb_status=${row.wb_status}  события: ${events}`);
  }

  await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
