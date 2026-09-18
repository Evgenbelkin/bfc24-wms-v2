'use strict';

require('dotenv').config();

const { pool } = require('../src/config/database');
const fbsAnalyticsService = require('../src/modules/fbsAnalytics/fbsAnalytics.service');

// =============================================================================
// Разовая проверка модуля "Аналитика FBS": обновляет wbStatus по всем
// активным WB-аккаунтам тенанта и печатает сводку за последние 7 дней.
//
// Запуск (с сервера, где лежит server/.env):
//   cd server && node scripts/fbs-analytics-test.js <tenant_id>
// =============================================================================

async function main() {
  const tenantId = Number(process.argv[2]);
  if (!tenantId) {
    console.error('Использование: node scripts/fbs-analytics-test.js <tenant_id>');
    process.exit(1);
  }

  console.log(`Опрашиваю wbStatus по тенанту #${tenantId}...`);
  const refreshResult = await fbsAnalyticsService.refreshWbStatusesForTenant(tenantId);
  console.log(`Аккаунтов: ${refreshResult.accounts}, проверено заказов: ${refreshResult.checked}, обновлено: ${refreshResult.updated}`);

  const to = new Date();
  const from = new Date(to.getTime() - 7 * 86400000);
  const summary = await fbsAnalyticsService.getFbsSummary({ tenantId, dateFrom: from, dateTo: to });

  console.log(`\nСводка за последние 7 дней (${from.toISOString().slice(0,10)} — ${to.toISOString().slice(0,10)}):`);
  console.log(`Всего: ${summary.current.total.qty} шт / ${summary.current.total.amount.toFixed(2)} ₽`);
  console.log(`% выкупа: ${summary.current.purchase_rate === null ? '—' : summary.current.purchase_rate.toFixed(1) + '%'}`);
  for (const b of summary.current.buckets) {
    console.log(`  ${b.label.padEnd(20)} ${String(b.qty).padStart(6)} шт   ${b.amount.toFixed(2)} ₽`);
  }

  const speed = await fbsAnalyticsService.getProcessingSpeed({ tenantId, dateFrom: from, dateTo: to });
  console.log(`\nСроки обработки (заказ→передача в WB), учтено: ${speed.processed} шт:`);
  console.log(`Вовремя (<=48ч): ${speed.on_time_rate === null ? '—' : speed.on_time_rate.toFixed(1) + '%'}`);
  console.log(`Ср. время заказ->WB: ${speed.avg_hours_to_wb === null ? '—' : speed.avg_hours_to_wb.toFixed(1) + ' ч'}`);
  console.log(`Ср. время заказ->выкуп: ${speed.avg_hours_to_sold === null ? '—' : speed.avg_hours_to_sold.toFixed(1) + ' ч'}`);
  for (const b of speed.buckets) {
    console.log(`  ${b.label.padEnd(28)} ${String(b.qty).padStart(6)} шт   ${b.pct.toFixed(1)}%`);
  }

  await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
