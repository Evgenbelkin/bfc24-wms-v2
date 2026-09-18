'use strict';

require('dotenv').config();

const axios = require('axios');
const { pool } = require('../src/config/database');
const wbTariffsService = require('../src/modules/platform/wbTariffs.service');

// =============================================================================
// Разовая диагностика: у WB несколько раз менялся путь метода "коэффициенты
// приёмки" (расхождения даже между разными статьями/SDK), и оба варианта,
// которые мы пробовали (/api/v1/acceptance/coefficients и /api/tariffs/v1/
// acceptance/coefficients на supplies-api.wildberries.ru), вернули 404 от
// шлюза ag-supplies. Этот скрипт бьёт по нескольким кандидатам (разные хосты
// и пути) напрямую, без retry-логики основного клиента, и печатает статус +
// тело ответа по каждому - чтобы один раз увидеть, какой реально существует.
//
// Запуск (с сервера, где лежит server/.env):
//   cd server && node scripts/wb-probe-acceptance-path.js
// =============================================================================

const CANDIDATES = [
  { baseUrl: 'https://supplies-api.wildberries.ru', path: '/api/v1/acceptance/coefficients' },
  { baseUrl: 'https://supplies-api.wildberries.ru', path: '/api/tariffs/v1/acceptance/coefficients' },
  { baseUrl: 'https://supplies-api.wildberries.ru', path: '/api/v2/acceptance/coefficients' },
  { baseUrl: 'https://supplies-api.wildberries.ru', path: '/api/v1/tariffs/acceptance/coefficients' },
  { baseUrl: 'https://common-api.wildberries.ru', path: '/api/v1/acceptance/coefficients' },
  { baseUrl: 'https://common-api.wildberries.ru', path: '/api/tariffs/v1/acceptance/coefficients' },
  { baseUrl: 'https://marketplace-api.wildberries.ru', path: '/api/v1/acceptance/coefficients' },
  { baseUrl: 'https://supplies-api.wildberries.ru', path: '/ping' },
];

async function main() {
  const token = await wbTariffsService.getTariffsToken();
  if (!token) {
    console.log('Токен не задан.');
    await pool.end();
    return;
  }

  for (const c of CANDIDATES) {
    const url = `${c.baseUrl}${c.path}`;
    try {
      const res = await axios({
        method: 'GET',
        url,
        headers: { 'Authorization': token, 'Accept': 'application/json' },
        timeout: 15000,
        validateStatus: () => true,
      });
      const bodyStr = typeof res.data === 'string' ? res.data.slice(0, 300) : JSON.stringify(res.data).slice(0, 300);
      console.log(`[${res.status}] ${url}\n  body: ${bodyStr}\n`);
    } catch (e) {
      console.log(`[ERR] ${url}\n  ${e.message}\n`);
    }
    await new Promise(r => setTimeout(r, 1500)); // не долбить подряд без пауз
  }

  await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
