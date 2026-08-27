'use strict';

require('dotenv').config();

const { pool } = require('../src/config/database');
const wbService = require('../src/modules/wb/wb.service');

// =============================================================================
// Разовая сверка: реальные остатки на WB (живой запрос к WB API по каждому
// складу продавца) против ОЖИДАЕМЫХ остатков в WMS - не сырого qty_available,
// а той же формулы, что и в самом пуше (distributeStockForAccount): физический
// остаток минус открытые заказы ('new'/'confirm', ещё не отгруженные) минус
// резерв (settings.stock_reserve_pct). Правка 28.08.2026: раньше сравнивали
// с сырым остатком - это давало ложные "расхождения" на каждый легитимно
// придержанный заказ и на резерв (например 878 в WMS / 826 в WB - это не
// баг, это 8 шт под открытыми заказами + 5% резерва). Теперь строка в отчёте
// значит настоящее расхождение между тем, что мы посчитали, и тем, что
// реально видно у WB.
//
// НЕ использует wms.wb_stock_distribution напрямую (это то, что мы сами в
// последний раз посчитали и попытались отправить - может быть устаревшим).
// Спрашивает у WB напрямую, что у него сейчас записано по каждому SKU на
// каждом складе, и сравнивает с расчётом "на сейчас".
//
// Использует ТУ ЖЕ функцию, что и кнопка "Сверка остатков" в интерфейсе
// (wb.service.js:reconcileStockForTenant) - один источник истины, без
// дублирования логики сравнения в двух местах.
//
// Запуск (с сервера, где лежит server/.env):
//   cd server && node scripts/wb-stock-reconcile.js
// =============================================================================

async function main() {
  const tenantIds = await wbService.listTenantsWithWbIntegration();
  if (!tenantIds.length) {
    console.log('Нет тенантов с включённым модулем wb_integration.');
    await pool.end();
    return;
  }

  let totalMismatches = 0;

  for (const tenantId of tenantIds) {
    const result = await wbService.reconcileStockForTenant(tenantId);

    for (const a of result.accounts) {
      console.log(`\n=== Тенант #${tenantId} · Аккаунт #${a.account_id} "${a.account_name || ''}" - клиент "${a.client_name}" ===`);

      if (a.skipped === 'no_warehouses') { console.log('  Нет складов WB для этого аккаунта, пропуск.'); continue; }
      if (a.skipped === 'no_barcodes')   { console.log('  Нет зарегистрированных штрихкодов WB, пропуск.'); continue; }

      if (a.errors && a.errors.length) {
        for (const e of a.errors) console.error(`  ! ошибка запроса: ${e}`);
      }

      if (!a.mismatches.length) {
        console.log('  OK: WB совпадает с ожидаемым (с учётом открытых заказов и резерва), расхождений нет.');
        continue;
      }

      console.log('  barcode           | diff  | WB итого | Ожидается | физ.WMS | заказов | резерв | товар');
      for (const m of a.mismatches) {
        const sign = m.diff > 0 ? '+' : '';
        const tag = m.diff > 0 ? 'оверселл' : 'не ушло в WB';
        console.log(
          `  ${m.barcode.padEnd(17)} | ${(sign + m.diff).padEnd(5)} | ${String(m.wb_qty).padEnd(8)} | ${String(m.expected_qty).padEnd(9)} | ${String(m.wms_qty).padEnd(7)} | ${String(m.open_orders).padEnd(7)} | ${String(m.reserve_pct).padEnd(6)} | ${m.name}  [${tag}]`
        );
        totalMismatches++;
      }
    }
  }

  console.log(`\n=== Итого товаров с настоящим расхождением (в любую сторону) по всем тенантам: ${totalMismatches} ===`);
  await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
