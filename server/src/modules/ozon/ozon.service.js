'use strict';

const { query, transaction } = require('../../config/database');
const ozonClient = require('./ozon.client');
const { resolveOrCreateItem } = require('../masterdata/items/items.service');
const { getDefaultWarehouse } = require('../warehouses/warehouses.service');
const { resolvePrinter } = require('../printing/printerResolver');
const { NotFoundError, ValidationError } = require('../../utils/errors');
const logger = require('../../utils/logger');

// =============================================================================
// Ozon Service — синхронизация отправлений FBS в staging-таблицы
// (wms.ozon_postings / wms.ozon_posting_items), задача #72 (07.09.2026).
//
// По аналогии с wb.service.js::fetchAndUpsertOrders, но без WB'шной
// реконсилиации "заказ пропал из ответа — значит забрали в обход нас": у Ozon
// нет отдельного шага "поставка" перед сборкой (см. комментарий в миграции
// 056), отправление и так уже однозначно идентифицируется posting_number, и
// его статус/пропажу видно по обычному повторному синку с фильтром по датам.
// =============================================================================

async function getMpAccount(tenantId, accountId) {
  const r = await query(
    `SELECT id, client_id, supplier_id AS ozon_client_id, api_token AS ozon_api_key
     FROM wms.mp_accounts
     WHERE id=$1 AND tenant_id=$2 AND is_active=TRUE AND marketplace='ozon' LIMIT 1`,
    [accountId, tenantId]
  );
  if (r.rowCount === 0) throw new NotFoundError('Ozon MP Account', accountId);
  const acc = r.rows[0];
  if (!acc.ozon_client_id || !acc.ozon_api_key) {
    throw new ValidationError(`Ozon account ${accountId} has no Client-Id/Api-Key configured`);
  }
  return acc;
}

async function listActiveAccounts(tenantId) {
  const r = await query(
    `SELECT id, client_id, supplier_id AS ozon_client_id, api_token AS ozon_api_key, account_name
     FROM wms.mp_accounts
     WHERE tenant_id=$1 AND is_active=TRUE AND marketplace='ozon'
       AND supplier_id IS NOT NULL AND length(trim(supplier_id))>0
       AND api_token   IS NOT NULL AND length(trim(api_token))>0`,
    [tenantId]
  );
  return r.rows;
}

/**
 * Из requirements.products_requiring_mandatory_mark (массив sku, требующих
 * код "Честный знак") строим множество для быстрой проверки по каждой
 * позиции posting.products[].sku.
 *
 * ВАЖНО: точная форма элементов этого массива у Ozon пока не проверена на
 * живом маркированном товаре (наш тестовый заказ 07.09.2026 — теннисный мяч,
 * массив пустой). Если у элементов окажется другая форма (не голый sku, а
 * объект) — поправить здесь после первого реального заказа с маркировкой.
 */
function extractMarkedSkus(posting) {
  const req = posting?.requirements?.products_requiring_mandatory_mark;
  if (!Array.isArray(req) || req.length === 0) return new Set();
  return new Set(req.map(x => (typeof x === 'object' ? x?.sku : x)).filter(Boolean).map(Number));
}

/** Синхронизировать отправления одного Ozon-аккаунта за период. */
async function syncPostingsForAccount({ tenantId, accountId, ozonClientId, ozonApiKey, sinceDays = 14 }) {
  const credentials = { clientId: ozonClientId, apiKey: ozonApiKey };
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const to = new Date().toISOString();

  const postings = await ozonClient.fetchAllFbsPostings(credentials, { since, to });

  let saved = 0;
  await transaction(async (client) => {
    for (const p of postings) {
      const postingNumber = p.posting_number;
      if (!postingNumber) continue;

      const delivery = p.delivery_method || {};
      const postingRes = await client.query(
        `INSERT INTO wms.ozon_postings
           (tenant_id, mp_account_id, posting_number, order_id, order_number,
            parent_posting_number, status, substatus, warehouse_id, warehouse_name,
            tpl_provider, shipment_date, in_process_at, tracking_number, raw)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (mp_account_id, posting_number) DO UPDATE SET
           order_number   = EXCLUDED.order_number,
           status         = EXCLUDED.status,
           substatus      = EXCLUDED.substatus,
           warehouse_id   = EXCLUDED.warehouse_id,
           warehouse_name = EXCLUDED.warehouse_name,
           tpl_provider   = EXCLUDED.tpl_provider,
           shipment_date  = EXCLUDED.shipment_date,
           tracking_number= EXCLUDED.tracking_number,
           raw            = EXCLUDED.raw,
           fetched_at     = NOW()
         RETURNING id, wms_shipment_code`,
        [
          tenantId, accountId, postingNumber, p.order_id || null, p.order_number || null,
          p.parent_posting_number || null, p.status || null, p.substatus || null,
          delivery.warehouse_id || null, delivery.warehouse || null, delivery.tpl_provider || null,
          p.shipment_date || null, p.in_process_at || null, p.tracking_number || null,
          JSON.stringify(p),
        ]
      );
      const postingId = postingRes.rows[0].id;
      const alreadyWaved = !!postingRes.rows[0].wms_shipment_code;
      saved++;

      // Позиции обновляем только для ещё не сформированных в волну отправлений
      // (см. комментарий у wms_shipment_code в миграции 056) — как только
      // отправление превратилось в задачи сборки, дальше их место жительства
      // wms.picking_tasks, а не этот кэш.
      if (alreadyWaved) continue;

      const markedSkus = extractMarkedSkus(p);
      await client.query(`DELETE FROM wms.ozon_posting_items WHERE posting_id=$1`, [postingId]);
      for (const line of (p.products || [])) {
        await client.query(
          `INSERT INTO wms.ozon_posting_items
             (tenant_id, posting_id, offer_id, sku, item_name, qty, price, currency_code, requires_marking)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            tenantId, postingId, line.offer_id || '', line.sku || null, line.name || null,
            Number(line.quantity) || 1, line.price || null, line.currency_code || null,
            markedSkus.has(Number(line.sku)),
          ]
        );
      }
    }
  });

  // Резолв штрихкода по offer_id (задача #77) — Ozon не отдаёт barcode прямо в
  // отправлении (posting.products[] содержит только offer_id/sku), нужен
  // отдельный запрос к /v3/product/info/list. Делаем ПОСЛЕ основной
  // транзакции (тот же паттерн, что notifyWbSupplyDelivered у WB — не
  // держим открытое соединение/лок на время похода в сеть), точечно только
  // по offer_id, реально встреченным в этом тике синка. Мягкий отказ — если
  // Ozon недоступен или роли токена не хватает, штрихкод просто останется
  // пустым до следующего синка, сборку заказов это не ломает (просто ещё не
  // видно волну, пока barcode не резолвится).
  const offerIds = [...new Set(postings.flatMap(p => (p.products || []).map(l => l.offer_id)).filter(Boolean))];
  if (offerIds.length > 0) {
    try {
      const productInfos = await ozonClient.fetchProductInfoByOfferIds(credentials, offerIds);
      for (const item of productInfos) {
        const barcode = Array.isArray(item.barcodes) && item.barcodes.length ? item.barcodes[0] : null;
        if (!item.offer_id || !barcode) continue;
        await query(
          `UPDATE wms.ozon_posting_items opi
             SET barcode=$1
           FROM wms.ozon_postings op
           WHERE opi.posting_id=op.id AND op.mp_account_id=$2
             AND opi.offer_id=$3 AND opi.barcode IS NULL`,
          [barcode, accountId, item.offer_id]
        );
      }
    } catch (e) {
      logger.warn({ err: e.message, tenantId, accountId }, 'Ozon: barcode resolve failed (soft-fail, роли токена может не хватать)');
    }
  }

  return { fetched: postings.length, saved };
}

async function syncAllAccountsForTenant(tenantId) {
  const accounts = await listActiveAccounts(tenantId);
  const results = [];
  for (const acc of accounts) {
    try {
      const r = await syncPostingsForAccount({
        tenantId, accountId: acc.id,
        ozonClientId: acc.ozon_client_id, ozonApiKey: acc.ozon_api_key,
      });
      results.push({ account_id: acc.id, account_name: acc.account_name, ok: true, ...r });
    } catch (e) {
      logger.error({ err: e, tenantId, accountId: acc.id }, 'Ozon sync-all: account sync failed');
      results.push({ account_id: acc.id, account_name: acc.account_name, ok: false, error: e.message });
    }
  }
  return results;
}

/**
 * "Сформировать волну" для Ozon (задача #73) — в отличие от WB, у Ozon НЕТ
 * отдельного шага "поставка" перед сборкой (см. комментарий в миграции 056):
 * единица группировки — уже готовое отправление (posting_number), поэтому
 * здесь просто превращаем каждое ещё не сформированное отправление (
 * wms_shipment_code IS NULL) в СВОИ wms.shipments + wms.pick_waves +
 * wms.picking_tasks, один в один, без промежуточного контейнера.
 *
 * Отправление, у которого хоть одна позиция ещё без резолвленного barcode
 * (см. задачу #77), пропускаем целиком — resolveOrCreateItem без штрихкода
 * не может создать товар, и заводить "проблемную" задачу сборки, для которой
 * заведомо непонятно, что сканировать, было бы хуже, чем просто оставить
 * отправление в очереди на следующий синк (barcode может подтянуться позже).
 */
async function generateWaveFromPostings({ tenantId, accountId, actorId, limit = 50 }) {
  const acc = await getMpAccount(tenantId, accountId);
  const wh = await getDefaultWarehouse(tenantId);

  // Свежий синк перед выборкой — сужает окно гонки, тот же приём, что и в
  // wb.router.js::generate-wave.
  await syncPostingsForAccount({
    tenantId, accountId, ozonClientId: acc.ozon_client_id, ozonApiKey: acc.ozon_api_key,
  });

  const postingsRes = await query(
    `SELECT id, posting_number, order_number FROM wms.ozon_postings
     WHERE tenant_id=$1 AND mp_account_id=$2 AND wms_shipment_code IS NULL
       AND status='awaiting_packaging'
     ORDER BY in_process_at ASC NULLS LAST LIMIT $3`,
    [tenantId, accountId, Math.min(limit, 200)]
  );
  if (postingsRes.rowCount === 0) return { created: [], skipped: [], message: 'Нет отправлений, готовых к формированию волны' };

  const created = [];
  const skipped = [];

  for (const posting of postingsRes.rows) {
    const itemsRes = await query(
      `SELECT offer_id, sku, barcode, item_name, qty FROM wms.ozon_posting_items WHERE posting_id=$1`,
      [posting.id]
    );
    const lines = itemsRes.rows;
    const missingBarcode = lines.find(l => !l.barcode);
    if (lines.length === 0 || missingBarcode) {
      skipped.push({
        posting_number: posting.posting_number,
        reason: lines.length === 0 ? 'no_items' : 'missing_barcode',
        offer_id: missingBarcode?.offer_id || null,
      });
      continue;
    }

    await transaction(async (client) => {
      await client.query(
        `INSERT INTO wms.shipments(tenant_id,warehouse_id,client_id,external_id,marketplace,status,created_by)
         VALUES($1,$2,$3,$4,'ozon','new',$5)
         ON CONFLICT(tenant_id,external_id) DO UPDATE SET client_id=EXCLUDED.client_id`,
        [tenantId, wh.id, acc.client_id, posting.posting_number, actorId]
      );

      await client.query(
        `INSERT INTO wms.pick_waves(tenant_id,warehouse_id,client_id,shipment_code,status,total_tasks,created_by)
         VALUES($1,$2,$3,$4,'open',0,$5)
         ON CONFLICT(tenant_id,shipment_code) DO NOTHING`,
        [tenantId, wh.id, acc.client_id, posting.posting_number, actorId]
      );

      const waveRes = await client.query(
        `SELECT id FROM wms.pick_waves WHERE tenant_id=$1 AND shipment_code=$2 LIMIT 1`,
        [tenantId, posting.posting_number]
      );
      const waveId = waveRes.rows[0].id;

      let insertedTasks = 0;
      for (const line of lines) {
        const itemId = await resolveOrCreateItem({
          tenantId, clientId: acc.client_id, barcode: line.barcode, dbClient: client,
        });
        await client.query(
          `INSERT INTO wms.picking_tasks
             (tenant_id,warehouse_id,client_id,wave_id,item_id,barcode,qty,status,priority,
              order_ref,shipment_code,created_by,updated_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,'new',3,$8,$9,$10,$10)`,
          [tenantId, wh.id, acc.client_id, waveId, itemId, line.barcode, line.qty,
           posting.order_number, posting.posting_number, actorId]
        );
        insertedTasks++;
      }

      await client.query(
        `UPDATE wms.pick_waves SET total_tasks=(SELECT COUNT(*)::int FROM wms.picking_tasks WHERE wave_id=pick_waves.id)
         WHERE tenant_id=$1 AND shipment_code=$2`,
        [tenantId, posting.posting_number]
      );

      // Помечаем отправление сформированным — дальше синк уже не трогает его
      // wms.ozon_posting_items (см. комментарий у alreadyWaved в syncPostingsForAccount).
      await client.query(
        `UPDATE wms.ozon_postings SET wms_shipment_code=$1 WHERE id=$2`,
        [posting.posting_number, posting.id]
      );

      created.push({ posting_number: posting.posting_number, tasks_inserted: insertedTasks });
    });
  }

  return { created, skipped };
}

/**
 * Достаём число/строку из объекта Ozon product/info по одному из нескольких
 * возможных имён поля. Основные имена (height/width/depth/weight/
 * dimension_unit/weight_unit/primary_image) уже подтверждены живым запросом
 * к /v4/product/info/attributes 07.09.2026 (задача #78) — держим
 * firstNumber/firstString с запасными вариантами на случай, если у части
 * товаров (другая категория, другая версия карточки) форма чуть отличается,
 * а не потому что мы гадаем вслепую.
 */
function firstNumber(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== '' && !Number.isNaN(Number(v))) return Number(v);
  }
  return null;
}
function firstString(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Импорт карточек товаров Ozon (задача #78, аналог importItemsForAccount у
 * WB) — заполняет фото и габариты в wms.items и заводит справочник
 * wms.ozon_items, независимо от того, приходили уже заказы по этому товару
 * или нет. Единицы измерения у Ozon — мм и граммы (в отличие от WB, где
 * карточка уже отдаёт см) — конвертируем в см при записи в wms.items, чтобы
 * формат совпадал с тем, что уже пишет WB-импорт.
 *
 * Источник данных — /v4/product/info/attributes (fetchProductAttributesByOfferIds),
 * НЕ /v3/product/info/list (тот используется в fetchProductInfoByOfferIds
 * только для резолва штрихкода при синке отправлений, задача #77) — первая
 * попытка использовать /v3/product/info/list и здесь показала на живых
 * данных, что тот ответ вообще не содержит габаритов/веса (см. историю
 * задачи #78), только цену/сток/картинки.
 */
async function importCatalogForAccount({ tenantId, accountId, ozonClientId, ozonApiKey, clientId }) {
  const credentials = { clientId: ozonClientId, apiKey: ozonApiKey };

  const offerIds = await ozonClient.fetchAllProductOfferIds(credentials);
  if (offerIds.length === 0) return { fetched_cards: 0, saved_items: 0, filled_dimensions: 0 };

  const productInfos = await ozonClient.fetchProductAttributesByOfferIds(credentials, offerIds);

  let savedItems = 0; let filledDimensions = 0;
  await transaction(async (client) => {
    for (const item of productInfos) {
      if (!item.offer_id) continue;

      const preview = firstString(item, ['primary_image']) ||
        (Array.isArray(item.images) && item.images.length ? String(item.images[0]) : null) ||
        (Array.isArray(item.primary_image) && item.primary_image.length ? String(item.primary_image[0]) : null);

      const unit = (item.dimension_unit || '').toLowerCase();
      const mmToCm = (v) => v == null ? null : (unit === 'cm' ? v : Number((v / 10).toFixed(2)));
      const lengthCm = mmToCm(firstNumber(item, ['depth', 'length']));
      const widthCm  = mmToCm(firstNumber(item, ['width']));
      const heightCm = mmToCm(firstNumber(item, ['height']));
      const weightGrams = (() => {
        const w = firstNumber(item, ['weight']);
        if (w == null) return null;
        const wu = (item.weight_unit || 'g').toLowerCase();
        return wu === 'kg' ? Math.round(w * 1000) : Math.round(w);
      })();

      await client.query(
        `INSERT INTO wms.ozon_items(tenant_id,mp_account_id,offer_id,ozon_product_id,ozon_sku,name,preview_url,
                                     length_cm,width_cm,height_cm,weight_grams,raw)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT(mp_account_id,offer_id) DO UPDATE SET
           ozon_product_id=EXCLUDED.ozon_product_id, ozon_sku=EXCLUDED.ozon_sku,
           name=EXCLUDED.name, preview_url=EXCLUDED.preview_url,
           length_cm=EXCLUDED.length_cm, width_cm=EXCLUDED.width_cm, height_cm=EXCLUDED.height_cm,
           weight_grams=EXCLUDED.weight_grams, raw=EXCLUDED.raw, updated_at=NOW()`,
        [tenantId, accountId, item.offer_id, item.id || null, item.sku || null,
         item.name || null, preview, lengthCm, widthCm, heightCm, weightGrams, JSON.stringify(item)]
      );
      savedItems++;

      const barcodes = Array.isArray(item.barcodes) ? item.barcodes.filter(Boolean) : [];
      const volumeLiters = (lengthCm && widthCm && heightCm)
        ? Number(((lengthCm * widthCm * heightCm) / 1000).toFixed(4))
        : null;

      for (const barcode of barcodes) {
        const existing = await client.query(
          `SELECT id, volume_liters, preview_url FROM wms.items WHERE tenant_id=$1 AND client_id=$2 AND barcode=$3 LIMIT 1`,
          [tenantId, clientId, barcode]
        );
        if (existing.rowCount === 0) {
          await client.query(
            `INSERT INTO wms.items(tenant_id,client_id,barcode,item_name,unit,source,preview_url,
                                    length_cm,width_cm,height_cm,volume_liters,weight_grams)
             VALUES($1,$2,$3,$4,'шт','ozon',$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
            [tenantId, clientId, barcode, item.name || barcode, preview, lengthCm, widthCm, heightCm, volumeLiters, weightGrams]
          );
          if (volumeLiters) filledDimensions++;
        } else if (existing.rows[0].volume_liters == null && volumeLiters) {
          await client.query(
            `UPDATE wms.items SET
               length_cm = COALESCE(length_cm, $1), width_cm = COALESCE(width_cm, $2),
               height_cm = COALESCE(height_cm, $3), volume_liters = COALESCE(volume_liters, $4),
               weight_grams = COALESCE(weight_grams, $5), preview_url = COALESCE(preview_url, $6),
               updated_at = NOW()
             WHERE id=$7`,
            [lengthCm, widthCm, heightCm, volumeLiters, weightGrams, preview, existing.rows[0].id]
          );
          filledDimensions++;
        }
      }
    }
  });

  return { fetched_cards: productInfos.length, saved_items: savedItems, filled_dimensions: filledDimensions };
}

async function listCatalogForAccount({ tenantId, accountId }) {
  const r = await query(
    `SELECT id, offer_id, ozon_sku, name, preview_url, length_cm, width_cm, height_cm, weight_grams, updated_at
     FROM wms.ozon_items WHERE tenant_id=$1 AND mp_account_id=$2 ORDER BY name NULLS LAST, offer_id LIMIT 500`,
    [tenantId, accountId]
  );
  return r.rows;
}

/**
 * "Собрать заказ" на стороне Ozon (задача #74) — вызывается из
 * packing.service.js::confirmPacking В МОМЕНТ, когда упаковщик реально
 * поставил короб в зону отгрузки (shipment.status -> ready_to_ship), для
 * marketplace='ozon' отгрузок. Soft-fail по духу (вызывающий код сам решает,
 * ловить ли ошибку) — если Ozon недоступен или что-то не так, упаковка в
 * нашей WMS всё равно уже подтверждена, просто не запустится получение
 * этикетки для этой конкретной отгрузки (можно будет разобраться руками).
 *
 * Тихо ничего не делает, если это не Ozon-отправление (ещё не засинкано в
 * wms.ozon_postings) — вызывающий код НЕ обязан заранее проверять
 * marketplace, functions сама разбирается по данным.
 */
async function shipPostingForShipment({ tenantId, shipmentId }) {
  const shipRes = await query(
    `SELECT external_id FROM wms.shipments WHERE id=$1 AND tenant_id=$2`,
    [shipmentId, tenantId]
  );
  if (shipRes.rowCount === 0) return { skipped: true, reason: 'shipment_not_found' };
  const postingNumber = shipRes.rows[0].external_id;

  const postingRes = await query(
    `SELECT op.id, ma.supplier_id AS ozon_client_id, ma.api_token AS ozon_api_key
     FROM wms.ozon_postings op JOIN wms.mp_accounts ma ON ma.id=op.mp_account_id
     WHERE op.tenant_id=$1 AND op.posting_number=$2 LIMIT 1`,
    [tenantId, postingNumber]
  );
  if (postingRes.rowCount === 0) return { skipped: true, reason: 'not_ozon_posting' };
  const posting = postingRes.rows[0];

  const itemsRes = await query(
    `SELECT sku, qty FROM wms.ozon_posting_items WHERE posting_id=$1 AND sku IS NOT NULL`,
    [posting.id]
  );
  if (itemsRes.rowCount === 0) return { skipped: true, reason: 'no_sku' };

  const credentials = { clientId: posting.ozon_client_id, apiKey: posting.ozon_api_key };
  const products = itemsRes.rows.map(r => ({ product_id: Number(r.sku), quantity: Number(r.qty) }));

  await ozonClient.shipPosting(credentials, { postingNumber, packages: [{ products }] });
  await query(`UPDATE wms.ozon_postings SET shipped_at=NOW() WHERE id=$1`, [posting.id]);

  return { ok: true, postingNumber };
}

/**
 * Фоновый шаг получения этикеток (задача #74, вызывается из
 * server/src/jobs/ozonLabelSync.js) — забирает PDF для отправлений, которые
 * мы отправили в /ship не раньше чем 55 секунд назад (Ozon просит 45-60с,
 * берём с небольшим запасом) и для которых этикетка ещё не была получена.
 * Глобальный проход по всем тенантам сразу (без явного перебора tenantId) —
 * каждая строка wms.ozon_postings уже несёт свой tenant_id, поэтому
 * дальнейшие джойны (mp_accounts/shipments) остаются в рамках того же
 * тенанта сами по себе, без риска утечки между тенантами.
 */
async function fetchLabelsForReadyPostings({ limit = 50, minAgeSeconds = 55, maxAttempts = 5 } = {}) {
  const dueRes = await query(
    `SELECT op.id, op.tenant_id, op.posting_number,
            ma.supplier_id AS ozon_client_id, ma.api_token AS ozon_api_key
     FROM wms.ozon_postings op
     JOIN wms.mp_accounts ma ON ma.id=op.mp_account_id
     WHERE op.shipped_at IS NOT NULL
       AND op.shipped_at <= NOW() - ($1 || ' seconds')::interval
       AND op.label_fetched_at IS NULL
       AND op.label_attempts < $2
     ORDER BY op.shipped_at ASC LIMIT $3`,
    [minAgeSeconds, maxAttempts, limit]
  );

  let fetched = 0, notReady = 0, failed = 0, noPrinter = 0;

  for (const row of dueRes.rows) {
    try {
      const credentials = { clientId: row.ozon_client_id, apiKey: row.ozon_api_key };
      const { pdfBase64 } = await ozonClient.fetchPackageLabelPdf(credentials, [row.posting_number]);

      const shipRes = await query(
        `SELECT id, packer_id, client_id FROM wms.shipments
         WHERE tenant_id=$1 AND external_id=$2 ORDER BY id DESC LIMIT 1`,
        [row.tenant_id, row.posting_number]
      );
      if (shipRes.rowCount === 0) {
        await query(`UPDATE wms.ozon_postings SET label_attempts=label_attempts+1 WHERE id=$1`, [row.id]);
        continue;
      }
      const shipment = shipRes.rows[0];

      // employeeId=packer_id — та же логика приоритета, что и у wb_sticker:
      // если у упаковщика активно рабочее место со своим принтером, этикетка
      // уйдёт туда, иначе — общий маршрут printer_routes по doc_type='ozon_label'.
      const resolved = await resolvePrinter(query, {
        tenantId: row.tenant_id, docType: 'ozon_label',
        employeeId: shipment.packer_id, clientId: shipment.client_id,
      });
      if (!resolved) {
        noPrinter++;
        logger.warn({ tenantId: row.tenant_id, postingNumber: row.posting_number },
          'Ozon label: не нашли принтер (нет рабочего места у упаковщика и нет маршрута doc_type=ozon_label) — этикетка не поставлена в очередь');
      } else {
        const jobCode = `OZL-${shipment.id}-${Date.now()}`;
        await query(
          `INSERT INTO wms.print_jobs(tenant_id,job_code,printer_id,route_id,doc_type,entity_type,entity_id,
                                       copies,payload_json,status,created_by)
           VALUES($1,$2,$3,$4,'ozon_label','shipment',$5,1,$6::jsonb,'new',$7)`,
          [row.tenant_id, jobCode, resolved.printerId, resolved.routeId, shipment.id,
           JSON.stringify({ pdf_base64: pdfBase64, posting_number: row.posting_number }),
           shipment.packer_id || null]
        );
      }

      await query(`UPDATE wms.ozon_postings SET label_fetched_at=NOW() WHERE id=$1`, [row.id]);
      fetched++;
    } catch (e) {
      const msg = String(e.message || '');
      // "next postings aren't ready" - ожидаемое временное состояние
      // (см. комментарий у fetchPackageLabelPdf), не настоящая ошибка -
      // просто попробуем на следующем тике джобы, не тратя одну из
      // maxAttempts попыток так же агрессивно, как на реальных ошибках.
      if (/ready/i.test(msg)) {
        notReady++;
      } else {
        failed++;
        logger.warn({ err: e, tenantId: row.tenant_id, postingNumber: row.posting_number }, 'Ozon label fetch failed');
      }
      await query(`UPDATE wms.ozon_postings SET label_attempts=label_attempts+1 WHERE id=$1`, [row.id]);
    }
  }

  return { checked: dueRes.rowCount, fetched, notReady, failed, noPrinter };
}

module.exports = {
  listActiveAccounts,
  getMpAccount,
  syncPostingsForAccount,
  syncAllAccountsForTenant,
  generateWaveFromPostings,
  importCatalogForAccount,
  listCatalogForAccount,
  shipPostingForShipment,
  fetchLabelsForReadyPostings,
};
