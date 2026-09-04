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
//   cd server && node scripts/wb-probe-sales-report-kiz.js [mp_account_id] [days] [vendorFilter]
//
// Если mp_account_id не передан - берётся первый активный WB-аккаунт с
// заполненным токеном. days - глубина периода в сутках (по умолчанию 30).
// vendorFilter - подстрока по vendorCode, чтобы явно найти строки по
// конкретному марочному товару (например "lopatki") и посмотреть их kiz
// отдельно от общей статистики. Лимит WB на этот метод - 1 запрос/минуту,
// поэтому при days > ~90 (может понадобиться больше одной страницы по 500
// строк) скрипт делает паузы между страницами - это может занять минуты.
// =============================================================================

const FINANCE_BASE = 'https://finance-api.wildberries.ru';
const PAGE_LIMIT = 500;
const MAX_PAGES = 6; // защита от случайного зависания на сутки при большом периоде

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const argAccountId = process.argv[2] ? Number(process.argv[2]) : null;
  const days = process.argv[3] ? Number(process.argv[3]) : 30;
  const vendorFilter = process.argv[4] || null;

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
  const dateFrom = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);

  console.log(`Запрашиваю /api/finance/v1/sales-reports/detailed за ${fmt(dateFrom)}..${fmt(dateTo)} (без fields - вернутся все поля), до ${MAX_PAGES} страниц по ${PAGE_LIMIT}...`);

  const allRows = [];
  let rrdId = 0;
  let page = 0;
  let hadError = false;

  try {
    while (page < MAX_PAGES) {
      page++;
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
          limit: PAGE_LIMIT,
          rrdId,
        },
        timeout: 30000,
        validateStatus: () => true,
      });

      console.log(`[стр. ${page}] HTTP ${res.status}`);

      if (res.status === 401 || res.status === 403) {
        console.log('Нет доступа - скорее всего у токена не включена категория "Финансы". Тело ответа:');
        console.log(JSON.stringify(res.data).slice(0, 500));
        hadError = true;
        break;
      }
      if (res.status === 204) {
        console.log('204 - больше данных нет, останавливаюсь.');
        break;
      }
      if (res.status !== 200) {
        console.log('Тело ответа:', JSON.stringify(res.data).slice(0, 800));
        hadError = true;
        break;
      }

      const rows = Array.isArray(res.data) ? res.data : [];
      console.log(`  строк на странице: ${rows.length}`);
      allRows.push(...rows);

      if (rows.length < PAGE_LIMIT) break; // последняя страница
      rrdId = rows[rows.length - 1].rrdId;

      if (page < MAX_PAGES) {
        console.log('  жду 61с (лимит WB 1 запрос/минуту)...');
        await sleep(61000);
      }
    }

    if (!hadError) {
      console.log(`\nВсего строк собрано: ${allRows.length}`);

      const sales = allRows.filter(r => r.docTypeName === 'Продажа');
      const withKiz = sales.filter(r => r.kiz);
      console.log(`docTypeName='Продажа': ${sales.length}, из них с непустым kiz: ${withKiz.length}`);

      const docTypes = [...new Set(allRows.map(r => r.docTypeName))];
      console.log('Встреченные docTypeName:', docTypes.join(', '));

      // Сводка по товарам (vendorCode) среди продаж - сколько продаж и сколько из них с kiz
      const byVendor = new Map();
      for (const r of sales) {
        const key = r.vendorCode || '(без артикула)';
        if (!byVendor.has(key)) byVendor.set(key, { count: 0, withKiz: 0 });
        const v = byVendor.get(key);
        v.count++;
        if (r.kiz) v.withKiz++;
      }
      console.log('\nПродажи по артикулам (vendorCode): всего / с kiz:');
      for (const [vendor, v] of [...byVendor.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 30)) {
        console.log(`  ${vendor}: ${v.count} / ${v.withKiz}`);
      }

      if (vendorFilter) {
        const matched = sales.filter(r => (r.vendorCode || '').toLowerCase().includes(vendorFilter.toLowerCase()));
        console.log(`\nСтроки с vendorCode, содержащим "${vendorFilter}": ${matched.length}`);
        for (const r of matched.slice(0, 10)) {
          console.log(JSON.stringify({
            rrdId: r.rrdId, vendorCode: r.vendorCode, nmId: r.nmId, sku: r.sku, saleDt: r.saleDt,
            srid: r.srid, orderId: r.orderId,
            kiz: r.kiz ? (r.kiz.slice(0, 60) + '...(обрезано, длина ' + r.kiz.length + ')') : null,
          }, null, 2));
        }
      }

      const sample = withKiz[0];
      if (sample) {
        console.log('\nПример строки С kiz (интересующие нас поля):');
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
          kiz: sample.kiz.slice(0, 60) + '...(обрезано, длина ' + sample.kiz.length + ')',
        }, null, 2));
      } else {
        console.log('\nНи в одной собранной строке нет kiz. Попробуй увеличить период (третий аргумент days) - учти лимит 1 запрос/минуту на страницу.');
      }
    }
  } catch (e) {
    console.error('FATAL при запросе:', e.message);
    process.exitCode = 1;
  }

  await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
