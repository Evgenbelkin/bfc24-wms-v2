'use strict';

require('dotenv').config();

const { pool } = require('../src/config/database');
const wbTariffsService = require('../src/modules/platform/wbTariffs.service');
const wbAcceptanceService = require('../src/modules/platform/wbAcceptance.service');

// =============================================================================
// Разовый принудительный запрос коэффициентов приёмки ФБС по складам
// (platform.wb_acceptance_coefficients) - для проверки/отладки, аналог
// wb-tariffs-fetch-now.js. Тот же токен, но ДРУГАЯ категория ("Поставки") -
// может не совпадать с тем, что настроено для тарифов (401/403 тут не
// означает, что и тарифы сломаны, и наоборот).
//
// Запуск (с сервера, где лежит server/.env):
//   cd server && node scripts/wb-acceptance-fetch-now.js
// =============================================================================

async function main() {
  const hasToken = await wbTariffsService.hasTariffsToken();
  console.log(`Токен задан: ${hasToken ? 'да' : 'НЕТ'}`);
  if (!hasToken) {
    console.log('Токен не задан. Зайди в панель платформы (/platform/wb-tariffs.html) и вставь токен.');
    await pool.end();
    return;
  }

  console.log('Запрашиваю коэффициенты приёмки у WB...');
  try {
    const result = await wbAcceptanceService.fetchAndStoreCoefficients();
    console.log(`OK. Сохранено записей (склад×дата×тип): ${result.saved}`);
    const slots = await wbAcceptanceService.listNearestFreeSlots();
    console.log(`Складов в сводке: ${slots.warehouses.length}`);
    for (const w of slots.warehouses.slice(0, 15)) {
      console.log(`  ${w.warehouse_name}: сегодня коэф=${w.today_coefficient} allow=${w.today_allow_unload}, ближайшая бесплатная: ${w.nearest_free_date || 'нет в ближайшие 14 дней'}`);
    }
  } catch (e) {
    console.error('FATAL при запросе коэффициентов приёмки:', e.message);
    process.exitCode = 1;
  }
  await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
