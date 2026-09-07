'use strict';

const axios = require('axios');
const logger = require('../../utils/logger');

// =============================================================================
// Единый Ozon Seller API Client — по образцу wb.client.js (задача #72,
// 07.09.2026). Отличия от WB:
//  - Авторизация: два заголовка (Client-Id + Api-Key), а не один Bearer-токен.
//    Держим их в тех же полях wms.mp_accounts, что и у WB (не потребовалась
//    отдельная миграция): supplier_id -> Ozon Client-Id, api_token -> Ozon
//    Api-Key. Смысл поля supplier_id ("ID поставщика у маркетплейса") подошёл
//    один в один.
//  - Один базовый хост на всё (api-seller.ozon.ru), в отличие от WB, где под
//    разные категории методов разные поддомены.
//  - Ошибки Ozon приходят как {code, message} — не пытаемся угадывать
//    человекочитаемое поле как в WB (там errorText/errors[]/error/detail/title,
//    см. marking.service.js::describeWbError) - здесь оно всегда одно, message.
// =============================================================================

const OZON_BASE = 'https://api-seller.ozon.ru';

const DEFAULT_TIMEOUT = 30_000;
const MAX_RETRIES = 5;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Выполнить запрос к Ozon Seller API с retry/backoff.
 * credentials = { clientId, apiKey } — см. комментарий выше про то, откуда
 * они берутся в wms.mp_accounts.
 */
async function ozonRequest({ credentials, method = 'POST', path, params = null, data = null, retries = MAX_RETRIES }) {
  const { clientId, apiKey } = credentials || {};
  if (!clientId || !apiKey) {
    throw new Error('Ozon credentials (clientId/apiKey) are required');
  }
  const url = `${OZON_BASE}${path}`;
  let attempt = 0;
  let lastError;

  while (attempt <= retries) {
    try {
      const response = await axios({
        method,
        url,
        params:  params || undefined,
        data:    data   || undefined,
        timeout: DEFAULT_TIMEOUT,
        headers: {
          'Client-Id':    String(clientId),
          'Api-Key':      String(apiKey),
          'Content-Type': 'application/json',
          'Accept':       'application/json',
        },
        validateStatus: () => true,
      });

      // 429 — Ozon тоже отдаёт стандартный Retry-After при превышении лимита.
      if (response.status === 429) {
        const retryAfter = Number(response.headers['retry-after'] || 5);
        const waitMs = Math.max(retryAfter * 1000, 1000);
        logger.warn({ path, attempt, waitMs }, 'Ozon rate limit 429, retrying...');
        await sleep(waitMs);
        attempt++;
        continue;
      }

      // 5xx — retry с backoff, как у WB.
      if (response.status >= 500) {
        const waitMs = Math.pow(2, attempt) * 1000;
        logger.warn({ path, status: response.status, attempt, waitMs }, 'Ozon 5xx error, retrying...');
        await sleep(waitMs);
        attempt++;
        lastError = new Error(`Ozon API ${response.status}: ${JSON.stringify(response.data)}`);
        continue;
      }

      // 401/403 — не ретраим, обычно неверный ключ или не хватает роли токена
      // (см. комментарий в системе про "минимальные права" при генерации ключа).
      if (response.status === 401 || response.status === 403) {
        const e = new Error(`Ozon API ${response.status}: ${JSON.stringify(response.data)} (path=${path}) — проверьте Client-Id/Api-Key и роли токена`);
        e.ozonStatus = response.status; e.ozonBody = response.data;
        throw e;
      }

      // Прочие ошибки (400 и т.п.) — тело кладём на объект ошибки, тем же
      // паттерном, что wbStatus/wbBody у WB-клиента.
      if (response.status >= 400) {
        const e = new Error(`Ozon API ${response.status}: ${JSON.stringify(response.data)}`);
        e.ozonStatus = response.status; e.ozonBody = response.data;
        throw e;
      }

      logger.debug({ path, method, status: response.status }, 'Ozon API request OK');
      return response.data;

    } catch (err) {
      if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
        const waitMs = Math.pow(2, attempt) * 1000;
        logger.warn({ path, attempt, err: err.message }, 'Ozon API timeout, retrying...');
        await sleep(waitMs);
        attempt++;
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error(`Ozon API request failed after ${retries} retries: ${path}`);
}

// =============================================================================
// API методы
// =============================================================================

/**
 * Отправления FBS за период (v3/posting/fbs/list). Пагинация через
 * has_next/offset, как в ответе Ozon (проверено живым запросом 07.09.2026,
 * задача #72 — реальный формат совпадает с документацией).
 *
 * with.analytics_data / with.financial_data — Ozon отдаёт эти блоки, только
 * если явно попросить (иначе null), включаем analytics_data по умолчанию
 * (там регион/город/склад, полезно для отчётов по аналогии с WB), financial_data
 * пока не запрашиваем — не нужно для сборки/упаковки.
 */
async function fetchFbsPostings(credentials, { since, to, status = null, limit = 100, offset = 0 } = {}) {
  const filter = { since, to };
  if (status) filter.status = status;

  const body = {
    dir: 'ASC',
    filter,
    limit,
    offset,
    with: { analytics_data: true },
  };

  return ozonRequest({
    credentials, method: 'POST',
    path: '/v3/posting/fbs/list',
    data: body,
  });
}

/**
 * Все отправления за период, с пагинацией "до конца" — обёртка над
 * fetchFbsPostings для использования в sync-джобе (по аналогии с
 * fetchNewOrders у WB, который тоже возвращает уже весь список целиком).
 */
async function fetchAllFbsPostings(credentials, { since, to, status = null, pageSize = 100, maxPages = 200 } = {}) {
  const all = [];
  let offset = 0;
  let page = 0;

  while (page < maxPages) {
    const data = await fetchFbsPostings(credentials, { since, to, status, limit: pageSize, offset });
    const postings = data?.result?.postings || [];
    all.push(...postings);
    if (!data?.result?.has_next || postings.length === 0) break;
    offset += pageSize;
    page++;
  }

  return all;
}

/**
 * Информация о товарах по offer_id (батч, до BATCH_SIZE штук за запрос) —
 * нужен, чтобы получить barcode: posting.products[] отдаёт только
 * offer_id/sku, без штрихкода (проверено живым запросом 07.09.2026, задача
 * #77). Метод /v3/product/info/list подтверждён живым тестом на реальном
 * товаре — возвращает barcodes[] (товар может иметь несколько штрихкодов,
 * берём первый — см. resolveBarcodesByOfferId в ozon.service.js).
 *
 * ВАЖНО: возвращённый barcode может быть сгенерирован самим Ozon
 * (вида "OZN<sku>"), если продавец не указал реальный EAN — тогда он может
 * физически не совпадать с тем, что наклеено на товар. Это забота уже
 * приёмки/сверки конкретного клиента, не этого метода.
 */
const PRODUCT_INFO_BATCH_SIZE = 100;

async function fetchProductInfoByOfferIds(credentials, offerIds) {
  const uniqueIds = [...new Set(offerIds.filter(Boolean))];
  const all = [];
  for (let i = 0; i < uniqueIds.length; i += PRODUCT_INFO_BATCH_SIZE) {
    const chunk = uniqueIds.slice(i, i + PRODUCT_INFO_BATCH_SIZE);
    const data = await ozonRequest({
      credentials, method: 'POST',
      path: '/v3/product/info/list',
      data: { offer_id: chunk },
    });
    all.push(...(data?.items || []));
  }
  return all;
}

/**
 * Полный список товаров продавца (offer_id) — нужен для "Справочник Ozon"
 * (задача #78), где, в отличие от резолва штрихкода по офферам из уже
 * пришедших отправлений (задача #77), нужно подтянуть КАРТОЧКИ ВСЕХ товаров
 * магазина заранее, до первого заказа — по аналогии с "Импортировать карточки
 * из WB" на экране Wildberries. /v3/product/list отдаёт только id/offer_id
 * (без деталей), пагинация курсором last_id — по документации Ozon Seller
 * API этот метод стабилен уже несколько лет, в отличие от product/info,
 * который недавно менялся (см. комментарий у fetchProductInfoByOfferIds про
 * /v2/product/info удалённый и его замену на /v3/product/info/list).
 */
async function fetchAllProductOfferIds(credentials, { pageSize = 100, maxPages = 200 } = {}) {
  const all = [];
  let lastId = '';
  let page = 0;

  while (page < maxPages) {
    const data = await ozonRequest({
      credentials, method: 'POST',
      path: '/v3/product/list',
      data: { filter: { visibility: 'ALL' }, last_id: lastId, limit: pageSize },
    });
    const items = data?.result?.items || [];
    all.push(...items.map(i => i.offer_id).filter(Boolean));
    const nextLastId = data?.result?.last_id || '';
    if (!nextLastId || items.length === 0 || nextLastId === lastId) break;
    lastId = nextLastId;
    page++;
  }

  return all;
}

/**
 * Полные характеристики карточки товара (задача #78) — В ОТЛИЧИЕ от
 * /v3/product/info/list (используется в fetchProductInfoByOfferIds для
 * резолва штрихкода при синке отправлений, задача #77), этот ответ НЕ
 * содержит габаритов/веса вообще — проверено живым запросом 07.09.2026 на
 * реальном товаре (raw в wms.ozon_items не имел полей height/width/depth/weight).
 * Нужные поля отдаёт отдельный метод /v4/product/info/attributes —
 * подтверждено живым запросом в тот же день: height/width/depth (числа,
 * единица в dimension_unit — на практике "mm"), weight (число, единица в
 * weight_unit — на практике "g"), плюс primary_image (строка, не массив,
 * как в product/info/list!) и barcodes[].
 */
const PRODUCT_ATTRS_BATCH_SIZE = 100;

async function fetchProductAttributesByOfferIds(credentials, offerIds) {
  const uniqueIds = [...new Set(offerIds.filter(Boolean))];
  const all = [];
  for (let i = 0; i < uniqueIds.length; i += PRODUCT_ATTRS_BATCH_SIZE) {
    const chunk = uniqueIds.slice(i, i + PRODUCT_ATTRS_BATCH_SIZE);
    const data = await ozonRequest({
      credentials, method: 'POST',
      path: '/v4/product/info/attributes',
      data: { filter: { offer_id: chunk }, limit: chunk.length },
    });
    all.push(...(data?.result || []));
  }
  return all;
}

module.exports = {
  ozonRequest,
  fetchFbsPostings,
  fetchAllFbsPostings,
  fetchProductInfoByOfferIds,
  fetchAllProductOfferIds,
  fetchProductAttributesByOfferIds,
};
