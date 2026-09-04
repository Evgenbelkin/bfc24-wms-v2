'use strict';

require('dotenv').config();

const axios = require('axios');
const { pool, query } = require('../src/config/database');

// =============================================================================
// Разовая диагностика: проверить новый метод WB "Детализация отчёта о
// реализации" (POST /api/finance/v1/sales-reports/detailed, категория
// токена "Финансы") на живых данных — конкретно интересует поле `kiz`
// (код маркировки) в строках с docTypeName='Продажа'. Старый метод
// (GET /api/v5/supplier/reportDetailByPeriod), с которым изначально
// планировали работать, WB отключил 15.07.2026 - переходим на новый сразу.
//
// Запуск (с сервера, где лежит server/.env):
//   cd server && node scripts/wb-probe-sales-report-kiz.js [mp_account_id]
//
// Если mp_account_id не передан - берётся первый активный WB-аккаунт с
// заполненным токеном. Период по умолчанию - последние 30 дней (чтобы
// повысить шанс поймать хотя бы одну продажу с кизом на тестовых данных).
// =============================================================================

const FINANCE_BASE = 'https://finance-api.wildberries.ru';

async function main() {
  const argAccountId = process.argv[2] ? Number(process.argv[2]) : null;

  let accRes;
  if (argAccountId) {
    accRes = await query(
      `SELECT id, tenant_id, client_id, account_name, api_token FROM wms.mp_accounts
       WHERE id=$1 AND marketplace='wb'`,
      [argAccountId]
    );
  } else {
    accRes = await query(
      `SELECT id, tenant_id, client_id, account_name, api_token FROM wms.mp_accounts
       WHERE marketplace='wb' AND is_active=TRUE AND api_token IS NOT NULL AND api_token <> ''
       ORDER BY id LIMIT 1`
    );
  }

  if (accRes.rowCount === 0) {
    console.log('Не нашёл подходящий WB-аккаунт с токеном. Передай ID явно: node scripts/wb-probe-sales-report-kiz.js <mp_account_id>');
    await pool.end();
    return;
  }

  const acc = accRes.rows[0];
  console.log(`Аккаунт: #${acc.id} "${acc.account_name}" (tenant=${acc.tenant_id}, client=${acc.client_id})`);

  const dateTo = new Date();
  const dateFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);

  console.log(`Запрашиваю /api/finance/v1/sales-reports/detailed за ${fmt(dateFrom)}..${fmt(dateTo)} (без fields - вернутся все поля)...`);

  try {
    const res = await axios({
      method: 'POST',
      url: `${FINANCE_BASE}/api/finance/v1/sales-reports/detailed`,
      headers: {
        'Authorization': acc.api_token,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      data: {
        dateFrom: fmt(dateFrom),
        dateTo: fmt(dateTo),
        limit: 500,
        rrdId: 0,
      },
      timeout: 30000,
      validateStatus: () => true,
    });

    console.log(`HTTP ${res.status}`);

    if (res.status === 401 || res.status === 403) {
      console.log('Нет доступа - скорее всего у токена не включена категория "Финансы". Тело ответа:');
      console.log(JSON.stringify(res.data).slice(0, 500));
    } else if (res.status === 204) {
      console.log('204 - данных за этот период нет.');
    } else if (res.status !== 200) {
      console.log('Тело ответа:', JSON.stringify(res.data).slice(0, 800));
    } else {
      const rows = Array.isArray(res.data) ? res.data : [];
      console.log(`Строк получено: ${rows.length}`);

      const sales = rows.filter(r => r.docTypeName === 'Продажа');
      const withKiz = sales.filter(r => r.kiz);
      console.log(`Из них docTypeName='Продажа': ${sales.length}, с непустым kiz: ${withKiz.length}`);

      const docTypes = [...new Set(rows.map(r => r.docTypeName))];
      console.log('Встреченные docTypeName:', docTypes.join(', '));

      const sample = withKiz[0] || sales[0] || rows[0];
      if (sample) {
        console.log('\nПример строки (интересующие нас поля):');
        console.log(JSON.stringify({
          rrdId: sample.rrdId,
          reportId: sample.reportId,
          docTypeName: sample.docTypeName,
          nmId: sample.nmId,
          sku: sample.sku,
          vendorCode: sample.vendorCode,
          techSize: sample.techSize,
          title: sample.title,
          subjectName: sample.subjectName,
          saleDt: sample.saleDt,
          orderDt: sample.orderDt,
          srid: sample.srid,
          orderId: sample.orderId,
          officeName: sample.officeName,
          quantity: sample.quantity,
          kiz: sample.kiz ? (sample.kiz.slice(0, 60) + '...(обрезано, длина ' + sample.kiz.length + ')') : null,
        }, null, 2));
      }

      if (withKiz.length === 0) {
        console.log('\nНи в одной строке за 30 дней нет kiz. Возможные причины: за этот период не было продаж маркированных товаров, либо поле появляется не сразу после продажи (WB формирует отчёт реализации с задержкой). Можно попробовать увеличить период через ручное редактирование скрипта.');
      }
    }
  } catch (e) {
    console.error('FATAL при запросе:', e.message);
    process.exitCode = 1;
  }

  await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
