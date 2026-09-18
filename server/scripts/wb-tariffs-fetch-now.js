'use strict';

require('dotenv').config();

const { pool } = require('../src/config/database');
const wbTariffsService = require('../src/modules/platform/wbTariffs.service');

// =============================================================================
// Разовый принудительный запрос тарифов приёмки/логистики/хранения WB по
// складам (platform.wb_warehouse_rates) с сервера - чтобы сразу увидеть
// реальную ошибку WB (401 неверный токен, 400 и т.п.), а не просто "Нет
// данных" в интерфейсе. Обычно тарифы тянутся сами раз в сутки
// (server/src/jobs/wbTariffsSync.js), этот скрипт - для проверки/отладки.
//
// Запуск (с сервера, где лежит server/.env):
//   cd server && node scripts/wb-tariffs-fetch-now.js
// =============================================================================

async function main() {
  const hasToken = await wbTariffsService.hasTariffsToken();
  console.log(`Токен задан: ${hasToken ? 'да' : 'НЕТ'}`);
  if (!hasToken) {
    console.log('Токен не задан. Зайди в панель платформы (/platform/wb-tariffs.html) владельцем и вставь токен своего личного кабинета WB (категория "Тарифы"), затем запусти скрипт снова.');
    await pool.end();
    return;
  }

  console.log('Запрашиваю тарифы у WB...');
  try {
    const result = await wbTariffsService.fetchAndStoreTariffs();
    console.log(`OK. Сохранено складов: ${result.saved}. Дата: ${result.tariffDate}. dtNextBox: ${result.dtNextBox}, dtTillMax: ${result.dtTillMax}`);
  } catch (e) {
    console.error('FATAL при запросе тарифов:', e.message);
    process.exitCode = 1;
  }
  await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
