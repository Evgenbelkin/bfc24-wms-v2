'use strict';

const axios = require('axios');
const logger = require('../../utils/logger');

// =============================================================================
// Единый WB API Client
// - Принимает token как параметр (не из глобального env)
// - Retry + exponential backoff при 429/5xx
// - Логирует все запросы
// - Не хранит токены — только исполняет запросы
// =============================================================================

const WB_BASE = 'https://marketplace-api.wildberries.ru';
const WB_STATISTICS_BASE = 'https://statistics-api.wildberries.ru';
const WB_CONTENT_BASE = 'https://content-api.wildberries.ru';
const WB_RETURNS_BASE = 'https://returns-api.wildberries.ru';

const DEFAULT_TIMEOUT = 30_000;
const MAX_RETRIES = 5;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Выполнить запрос к WB API с retry/backoff
 */
async function wbRequest({ token, method = 'GET', baseUrl = WB_BASE, path, params = null, data = null, retries = MAX_RETRIES }) {
  const url = `${baseUrl}${path}`;
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
          'Authorization':  token,
          'Content-Type':   'application/json',
          'Accept':         'application/json',
        },
        validateStatus: () => true, // обрабатываем все статусы сами
      });

      // 429 Rate Limit — backoff
      if (response.status === 429) {
        const retryAfter = Number(response.headers['retry-after'] || 5);
        const waitMs = Math.max(retryAfter * 1000, 1000) * (attempt + 1);
        logger.warn({ path, attempt, waitMs }, 'WB rate limit 429, retrying...');
        await sleep(waitMs);
        attempt++;
        continue;
      }

      // 5xx Server errors — retry с backoff
      if (response.status >= 500) {
        const waitMs = Math.pow(2, attempt) * 1000;
        logger.warn({ path, status: response.status, attempt, waitMs }, 'WB 5xx error, retrying...');
        await sleep(waitMs);
        attempt++;
        lastError = new Error(`WB API ${response.status}: ${JSON.stringify(response.data)}`);
        continue;
      }

      // 401 — не ретраим
      if (response.status === 401) {
        throw new Error(`WB API 401 Unauthorized for path=${path}. Check api_token.`);
      }

      // 404 — не ретраим
      if (response.status === 404) {
        throw new Error(`WB API 404 Not Found: ${path}`);
      }

      // Другие ошибки (400, 409, etc.)
      if (response.status >= 400) {
        throw new Error(`WB API ${response.status}: ${JSON.stringify(response.data)}`);
      }

      // Успех
      logger.debug({ path, method, status: response.status }, 'WB API request OK');
      return response.data;

    } catch (err) {
      if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
        const waitMs = Math.pow(2, attempt) * 1000;
        logger.warn({ path, attempt, err: err.message }, 'WB API timeout, retrying...');
        await sleep(waitMs);
        attempt++;
        lastError = err;
        continue;
      }
      throw err; // Прокидываем не-сетевые ошибки сразу
    }
  }

  throw lastError || new Error(`WB API request failed after ${retries} retries: ${path}`);
}

// =============================================================================
// API методы
// =============================================================================

/** Получить карточки товаров (Content API) с пагинацией */
async function fetchItems(token, { limit = 100, maxPages = 50 } = {}) {
  const allCards = [];
  let cursor = null;
  let page = 0;

  while (page < maxPages) {
    const body = {
      settings: {
        cursor:  cursor ? { updatedAt: cursor.updatedAt, nmID: cursor.nmID, limit } : { limit },
        filter:  { withPhoto: -1 },
      },
    };

    const data = await wbRequest({
      token, method: 'POST',
      baseUrl: WB_CONTENT_BASE,
      path: '/content/v2/get/cards/list',
      data: body,
    });

    const cards = data?.cards || [];
    if (!cards.length) break;

    allCards.push(...cards);

    const newCursor = data?.cursor;
    if (!newCursor || newCursor.total === 0 || cards.length < limit) break;

    cursor = newCursor;
    page++;
  }

  return allCards;
}

/** Извлечь штрихкоды из карточки */
function extractCardBarcodes(card) {
  const barcodes = [];
  const nmID = card.nmID || card.id;
  if (!nmID) return barcodes;

  const sizes = card.sizes || card.addin?.find?.(a => a.type === 'Размер')?.params || [];
  for (const size of sizes) {
    const chrtID = size.chrtID || size.id;
    // techSize - "внутренний" размер карточки (то, что реально печатают на
    // этикетке, "128", "146", "42" и т.п.), wbSize - альтернативное поле в
    // некоторых ответах Content API. Берём первое, что есть.
    const techSize = size.techSize || size.wbSize || null;
    const skus = Array.isArray(size.skus) && size.skus.length
      ? size.skus
      : (size.barcode ? [size.barcode] : []);
    for (const sku of skus) {
      if (sku) barcodes.push({ nm_id: nmID, chrt_id: chrtID, barcode: String(sku), tech_size: techSize });
    }
  }
  return barcodes;
}

/** Получить ВСЕ заказы (историю, любой статус/дата) — для отчётов, не для сборки.
 *  ВАЖНО: WB требует параметр next (курсор пагинации) даже на первый запрос —
 *  без него отдаёт 400 IncorrectParameter. dateFrom у этого метода — Unix-время
 *  в секундах, а не строка даты; если передали строку/Date — конвертируем сами,
 *  чтобы вызывающий код не должен был об этом помнить. */
async function fetchOrders(token, { dateFrom = null, limit = 1000, next = 0 } = {}) {
  const params = { limit, next };
  if (dateFrom) {
    const n = Number(dateFrom);
    params.dateFrom = Number.isFinite(n) && String(dateFrom).trim() === String(n)
      ? n
      : Math.floor(new Date(dateFrom).getTime() / 1000);
  }
  const data = await wbRequest({ token, path: '/api/v3/orders', params });
  return Array.isArray(data?.orders) ? data.orders : (Array.isArray(data) ? data : []);
}

/** Получить ТОЛЬКО новые заказы, ожидающие сборки — то, что реально нужно для
 *  формирования волны. Отдельный эндпоинт WB, не пересекается с /api/v3/orders
 *  (тот отдаёт вообще всю историю, включая отменённые и архивные). */
async function fetchNewOrders(token) {
  const data = await wbRequest({ token, path: '/api/v3/orders/new' });
  return Array.isArray(data?.orders) ? data.orders : (Array.isArray(data) ? data : []);
}

/** Получить склады продавца */
async function fetchSellerWarehouses(token) {
  const data = await wbRequest({ token, path: '/api/v3/warehouses' });
  return Array.isArray(data) ? data : [];
}

/** Создать поставку */
async function createSupply(token, name) {
  const data = await wbRequest({ token, method: 'POST', path: '/api/v3/supplies', data: { name } });
  return data;
}

/** Добавить заказы в поставку.
 *  Четыре бага здесь были по очереди:
 *  1) префикс WB-GI- не срезался при походе на устаревший /api/v3 путь.
 *  2) Пробовали одним пакетным PATCH /api/v3/supplies/{id}/orders —
 *     такого пути в этом префиксе у WB нет, 404.
 *  3) Пробовали по одному заказу PATCH /api/v3/supplies/{id}/orders/{orderId} —
 *     тоже не существует (устаревший GET-only маршрут, Deprecated).
 *     Актуальный метод "Add Assembly Orders to the Supply" живёт под
 *     ДРУГИМ префиксом: PATCH /api/marketplace/v3/supplies/{id}/orders,
 *     тело {orders:[...]}, одним запросом до 100 заказов сразу.
 *  4) На этом верном пути WB вернул 400 IncorrectParameter — потому что
 *     в path-параметре {supplyId} мы срезали префикс WB-GI-. В доке
 *     dev.wildberries.ru пример path-параметра для ВСЕХ supply-эндпоинтов
 *     показан именно как "WB-GI-1234567" (с префиксом) — значит срезать
 *     его не нужно нигде, это был неверный фикс с самого начала.
 */
async function addOrdersToSupply(token, supplyId, orderIds) {
  const fullId = normalizeShipmentCode(supplyId);
  await wbRequest({
    token, method: 'PATCH',
    path: `/api/marketplace/v3/supplies/${encodeURIComponent(fullId)}/orders`,
    data: { orders: orderIds.map(Number) },
  });
}

/** Получить стикеры для заказов */
async function fetchOrderStickers(token, orderIds, { type = 'svg', width = 58, height = 40 } = {}) {
  const data = await wbRequest({
    token, method: 'POST',
    path: `/api/v3/orders/stickers?type=${type}&width=${width}&height=${height}`,
    data: { orders: orderIds },
  });
  return data?.stickers || [];
}

/** Получить QR-код поставки */
async function fetchSupplyBarcode(token, supplyId) {
  const fullId = normalizeShipmentCode(supplyId);
  const data = await wbRequest({
    token,
    path: `/api/v3/supplies/${encodeURIComponent(fullId)}/barcode?type=svg`,
  });
  return data; // { barcode, file }
}

/** Подтвердить поставку к отгрузке */
async function deliverSupply(token, supplyId) {
  const fullId = normalizeShipmentCode(supplyId);
  await wbRequest({
    token, method: 'PATCH',
    path: `/api/v3/supplies/${encodeURIComponent(fullId)}/deliver`,
  });
}

/** Получить реальный статус приёмки заказов у WB (не наш локальный supplierStatus,
 *  а именно wbStatus — статус на стороне WB: 'waiting' значит подтверждён
 *  продавцом, но WB ещё физически не принял; 'sorted'/'sold'/и т.п. — уже принят
 *  и обрабатывается дальше). Нужно, чтобы понять, когда поставка реально
 *  дошла до склада WB, а не просто была отмечена нами как "в пути". */
async function fetchOrderStatuses(token, orderIds) {
  if (!orderIds || !orderIds.length) return [];
  const data = await wbRequest({
    token, method: 'POST',
    path: '/api/v3/orders/status',
    data: { orders: orderIds.map(Number) },
  });
  return Array.isArray(data?.orders) ? data.orders : [];
}

/** Получить остатки FBS по складу */
async function fetchFbsStocks(token, warehouseId) {
  const data = await wbRequest({
    token,
    path: `/api/v3/stocks/${encodeURIComponent(warehouseId)}`,
  });
  return Array.isArray(data?.stocks) ? data.stocks : [];
}

/** Установить остатки FBS */
async function updateFbsStocks(token, warehouseId, stocks) {
  await wbRequest({
    token, method: 'PUT',
    path: `/api/v3/stocks/${encodeURIComponent(warehouseId)}`,
    data: { stocks },
  });
}

/**
 * Заявки покупателей на возврат ("Честный знак" тут ни при чём — это Returns API,
 * отдельный от marketplace-api хост). Отдаёт заявки за последние 14 дней (это
 * ограничение самого WB, не наше). Только ДЛЯ ВИДИМОСТИ ("заявлено, но ещё не
 * доехало до склада физически") — окончательное решение продажа/утиль всё
 * равно принимается человеком при физической приёмке (см. returns.service.js).
 * Поля по документации WB: claimId, nmId (товар), wbStatus, srid (номер
 * заказа), userComment. Полную структуру ответа WB нигде публично не
 * документирует построчно, поэтому дальше (wb.service.js) поля читаются
 * с фолбэками, а не жёстко по одной схеме.
 *
 * isArchive — ОБЯЗАТЕЛЬНЫЙ параметр (проверено на реальном аккаунте: без него
 * WB отвечает 400 "missing field `is_archive`"). Судя по всему соответствует
 * вкладкам в личном кабинете WB "Возвраты и перемещения товаров": false —
 * "Активные" (ещё в пути/не забраны), true — "История" (уже выданы/закрыты).
 */
async function fetchReturnClaims(token, { isArchive = false } = {}) {
  const data = await wbRequest({
    token,
    baseUrl: WB_RETURNS_BASE,
    path: '/api/v1/claims',
    params: { is_archive: isArchive },
  });
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.claims)) return data.claims;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

/**
 * Закрепить коды маркировки "Честный знак" (DataMatrix/КИЗ) за сборочным
 * заданием FBS — замена ручного ввода кода в кабинете WB на этапе сборки.
 * Работает только для заданий в статусе confirm (см. доку WB); до 100 кодов
 * за один вызов — для наших объёмов (штуки на один заказ) с большим запасом.
 */
async function setOrderKiz(token, orderId, sgtins) {
  const codes = (Array.isArray(sgtins) ? sgtins : [sgtins]).map(String).filter(Boolean);
  if (!codes.length) throw new Error('setOrderKiz: не передано ни одного кода');
  if (codes.length > 100) throw new Error('setOrderKiz: WB принимает не более 100 кодов за один вызов');
  await wbRequest({
    token, method: 'PUT',
    path: `/api/v3/orders/${encodeURIComponent(orderId)}/meta/sgtin`,
    data: { sgtins: codes },
  });
  return true;
}

/** Нормализовать shipment code в формат WB-GI-XXXXX */
function normalizeShipmentCode(rawId) {
  const s = String(rawId || '').trim();
  if (!s) return null;
  if (/^WB-GI-/i.test(s)) return s;
  if (/^\d+$/.test(s)) return `WB-GI-${s}`;
  return s;
}

/** Извлечь sticker code из base64 SVG */
function extractStickerCode(base64) {
  if (!base64 || typeof base64 !== 'string') return null;
  try {
    const svg = Buffer.from(base64, 'base64').toString('utf8');
    const nums = [];
    const re = /<text[^>]*>\s*([0-9]{4,})\s*<\/text>/gim;
    let m;
    while ((m = re.exec(svg)) !== null) nums.push(m[1]);
    if (nums.length >= 2) return `${nums[0]} ${nums[1]}`;
    if (nums.length === 1) return nums[0];
    return null;
  } catch { return null; }
}

module.exports = {
  wbRequest,
  fetchItems, extractCardBarcodes,
  fetchOrders, fetchNewOrders,
  fetchSellerWarehouses,
  createSupply, addOrdersToSupply,
  fetchOrderStickers, fetchSupplyBarcode,
  deliverSupply,
  fetchOrderStatuses,
  fetchFbsStocks, updateFbsStocks,
  fetchReturnClaims,
  setOrderKiz,
  normalizeShipmentCode, extractStickerCode,
};
