'use strict';

const { query, transaction } = require('../../config/database');
const ozonClient = require('./ozon.client');
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

module.exports = {
  listActiveAccounts,
  syncPostingsForAccount,
  syncAllAccountsForTenant,
};
