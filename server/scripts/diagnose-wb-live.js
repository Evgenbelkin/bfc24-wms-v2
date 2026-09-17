#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const wbClient = require('../src/modules/wb/wb.client');

// =============================================================================
// Диагностика (15.09.2026, срочная): живой запрос ПРЯМО в WB Content API
// (минуя нашу БД и предыдущий импорт), чтобы понять, видит ли сам WB
// (под данным токеном) карточки с нужными vendorCode/nmID вообще.
// Локальный импорт (wms.wb_items/wb_item_barcodes) вернул только 96 карточек
// для аккаунта "КОСМОПРОФ" и не содержит нужные 2 товара ни по штрихкоду,
// ни по nm_id - надо понять, это WB так отвечает (значит трогать нечего,
// смотреть в личном кабинете WB почему карточка не публикуется на этот
// токен/кабинет), или где-то теряется уже после получения ответа.
//
// Делает: 1) live cards/list с textSearch по каждому vendorCode,
//         2) live cards/list БЕЗ фильтра, считает total по cursor,
//         3) сверяет total с тем, что реально пришло (постранично).
//
// Использование:
//   cd server && node scripts/diagnose-wb-live.js <mp_account_id> [vendorCode1,vendorCode2]
// =============================================================================

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME     || 'bfc24_v2',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

async function main() {
  const accountId = process.argv[2];
  const vendorCodes = (process.argv[3] || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!accountId) {
    console.error('Использование: node scripts/diagnose-wb-live.js <mp_account_id> [vendorCode1,vendorCode2]');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    const accRes = await client.query(
      `SELECT id, tenant_id, client_id, account_name, api_token FROM wms.mp_accounts WHERE id=$1`,
      [accountId]
    );
    if (accRes.rowCount === 0) {
      console.log(`Аккаунт #${accountId} не найден.`);
      return;
    }
    const acc = accRes.rows[0];
    if (!acc.api_token) {
      console.log(`У аккаунта #${accountId} ("${acc.account_name}") нет токена.`);
      return;
    }
    console.log(`Аккаунт #${acc.id} "${acc.account_name}" (tenant_id=${acc.tenant_id}, client_id=${acc.client_id}), токен: ...${acc.api_token.slice(-8)}\n`);

    // Узнаём у самого WB, какому продавцу (юрлицу/кабинету) принадлежит
    // ЭТОТ токен - прямое доказательство того, "тот" ли это кабинет.
    console.log('--- Информация о продавце по этому токену (common-api/seller-info) ---');
    try {
      const seller = await wbClient.wbRequest({
        token: acc.api_token, method: 'GET',
        baseUrl: 'https://common-api.wildberries.ru',
        path: '/api/v1/seller-info',
      });
      console.log(`  Название: "${seller?.name}", trademark: "${seller?.tradeMark}", sid: ${seller?.sid}\n`);
    } catch (e) {
      console.log(`  Не удалось получить: ${e.message}\n`);
    }

    // 1) Живой полный список (без фильтра) - считаем, сколько реально WB отдаёт
    //    постранично, и сверяем с cursor.total на первой странице.
    console.log('--- Живой полный список карточек (cards/list, без текстового фильтра) ---');
    let cursor = null;
    let page = 0;
    let allCards = [];
    let firstTotal = null;
    while (page < 50) {
      const body = { settings: { cursor: cursor ? { updatedAt: cursor.updatedAt, nmID: cursor.nmID, limit: 100 } : { limit: 100 }, filter: { withPhoto: -1 } } };
      const data = await wbClient.wbRequest({
        token: acc.api_token, method: 'POST',
        baseUrl: 'https://content-api.wildberries.ru',
        path: '/content/v2/get/cards/list',
        data: body,
      });
      const cards = data?.cards || [];
      if (page === 0) firstTotal = data?.cursor?.total;
      if (!cards.length) break;
      allCards.push(...cards);
      const newCursor = data?.cursor;
      console.log(`  страница ${page + 1}: получено ${cards.length}, cursor.total=${newCursor?.total}`);
      if (!newCursor || newCursor.total === 0 || cards.length < 100) break;
      cursor = newCursor;
      page++;
    }
    console.log(`Итого живых карточек получено: ${allCards.length} (cursor.total на первой странице: ${firstTotal})\n`);

    console.log('Примеры vendorCode из живого ответа (первые 15):');
    for (const c of allCards.slice(0, 15)) {
      console.log(`  nmID=${c.nmID}, vendorCode="${c.vendorCode}", title="${c.title}"`);
    }
    console.log('');

    // 2) Ищем нужные vendorCode среди живых карточек
    if (vendorCodes.length) {
      for (const vc of vendorCodes) {
        const found = allCards.find(c => c.vendorCode === vc);
        if (found) {
          console.log(`vendorCode "${vc}": НАЙДЕН в живом ответе - nmID=${found.nmID}, title="${found.title}"`);
        } else {
          console.log(`vendorCode "${vc}": НЕ найден среди ${allCards.length} живых карточек этого токена`);
        }
      }
      console.log('');

      // 3) Пробуем прямой textSearch по каждому vendorCode - вдруг WB найдёт
      //    его отдельно, но не отдаёт в общем списке (например если карточка
      //    архивная/на модерации и общий cards/list её по умолчанию пропускает)
      console.log('--- Прямой textSearch по vendorCode ---');
      for (const vc of vendorCodes) {
        try {
          const body = { settings: { cursor: { limit: 100 }, filter: { withPhoto: -1, textSearch: vc } } };
          const data = await wbClient.wbRequest({
            token: acc.api_token, method: 'POST',
            baseUrl: 'https://content-api.wildberries.ru',
            path: '/content/v2/get/cards/list',
            data: body,
          });
          const cards = data?.cards || [];
          if (cards.length) {
            for (const c of cards) {
              console.log(`  "${vc}" -> nmID=${c.nmID}, vendorCode="${c.vendorCode}", title="${c.title}"`);
            }
          } else {
            console.log(`  "${vc}" -> textSearch тоже ничего не нашёл (WB не знает эту карточку под этим токеном)`);
          }
        } catch (e) {
          console.log(`  "${vc}" -> ошибка textSearch: ${e.message}`);
        }
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => {
  console.error('Ошибка:', e.message);
  process.exit(1);
});
