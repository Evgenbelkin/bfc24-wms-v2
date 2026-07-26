'use strict';

const { query } = require('../../config/database');
const wbClient = require('./wb.client');
const { NotFoundError, ValidationError } = require('../../utils/errors');
const logger = require('../../utils/logger');

// =============================================================================
// WB Service — переиспользуемая логика синхронизации, общая для:
//  - ручной кнопки "Синхронизировать заказы" (один аккаунт)
//  - ручной кнопки "Синхронизировать все" (все аккаунты тенанта)
//  - фонового автосинка (server/src/jobs/wbAutoSync.js)
// =============================================================================

async function getMpAccount(tenantId, accountId) {
  const r = await query(
    `SELECT id, client_id, api_token, marketplace FROM wms.mp_accounts
     WHERE id=$1 AND tenant_id=$2 AND is_active=TRUE LIMIT 1`,
    [accountId, tenantId]
  );
  if (r.rowCount === 0) throw new NotFoundError('MP Account', accountId);
  const acc = r.rows[0];
  if (!acc.api_token) throw new ValidationError(`MP account ${accountId} has no api_token`);
  return acc;
}

/** Активные WB-аккаунты тенанта с заполненным токеном */
async function listActiveAccounts(tenantId) {
  const r = await query(
    `SELECT id, client_id, api_token, account_name FROM wms.mp_accounts
     WHERE tenant_id=$1 AND is_active=TRUE AND marketplace='wb'
       AND api_token IS NOT NULL AND length(trim(api_token))>0`,
    [tenantId]
  );
  return r.rows;
}

/** Синхронизация новых заказов по одному аккаунту (acc уже должен содержать api_token).
 *
 *  Помимо сохранения новых заказов, здесь же живёт РЕКОНСИЛИАЦИЯ: WB отдаёт в
 *  /api/v3/orders/new только те заказы, которые ВСЁ ЕЩЁ ждут сборки. Если владелец
 *  кабинета вручную сгруппировал заказ в поставку прямо в своём ЛК WB (в обход
 *  нашего софта), этот заказ просто перестаёт приходить в ответе — а наша старая
 *  запись в БД как была 'new' без wb_supply_id, так и остаётся, будто заказ всё ещё
 *  ждёт нас. Раньше это "зависшее" состояние ничем не лечилось: такой заказ мог
 *  попасть в "Сформировать волну" и упасть с ошибкой WB (заказ уже в другой поставке).
 *  Теперь при КАЖДОЙ синхронизации (ручной, "синхронизировать всё", фоновой раз в
 *  15 минут) мы сверяем, какие из наших "new"-заказов пропали из свежего ответа WB,
 *  и помечаем их status='external' — это выводит их из очереди на волну и делает
 *  видимыми в фильтре как "Занято в кабинете WB", вместо того чтобы бесконечно висеть. */
async function syncOrdersForAccount({ tenantId, accountId, apiToken }) {
  const orders = await wbClient.fetchNewOrders(apiToken);

  let saved = 0;
  const freshIds = [];
  for (const o of orders) {
    const wbOrderId = o.id || o.odid || o.orderId;
    if (!wbOrderId) continue;
    freshIds.push(Number(wbOrderId));
    const barcode = Array.isArray(o.skus) ? o.skus[0] : (o.barcode || null);
    await query(
      `INSERT INTO wms.wb_orders
         (tenant_id,mp_account_id,wb_order_id,nm_id,chrt_id,article,barcode,
          warehouse_id,warehouse_name,region_name,price,converted_price,currency_code,
          status,created_at,raw)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT(mp_account_id,wb_order_id) DO UPDATE SET
         status=EXCLUDED.status, fetched_at=NOW(), raw=EXCLUDED.raw`,
      [
        tenantId, accountId, wbOrderId,
        o.nmId||o.nmID||null, o.chrtId||null, o.article||null, barcode,
        o.warehouseId||null, (o.offices||[]).join(',')||o.warehouseName||null,
        o.regionName||null, o.price||null, o.convertedPrice||null, o.currencyCode||null,
        'new', o.createdAt||null,
        JSON.stringify(o),
      ]
    );
    saved++;
  }

  // Реконсилиация: наши "new"-заказы без поставки, которых больше нет в свежем
  // ответе WB — значит их забрали в поставку/отменили не через нас.
  const reconciled = await query(
    `UPDATE wms.wb_orders SET status='external', fetched_at=NOW()
     WHERE tenant_id=$1 AND mp_account_id=$2 AND status='new' AND wb_supply_id IS NULL
       AND NOT (wb_order_id = ANY($3::bigint[]))
     RETURNING wb_order_id`,
    [tenantId, accountId, freshIds]
  );

  return { fetched: orders.length, saved, marked_external: reconciled.rowCount };
}

/** Синхронизировать заказы по ВСЕМ активным WB-аккаунтам тенанта (кнопка "Синхронизировать все") */
async function syncAllAccountsForTenant(tenantId) {
  const accounts = await listActiveAccounts(tenantId);
  const results = [];
  for (const acc of accounts) {
    try {
      const r = await syncOrdersForAccount({ tenantId, accountId: acc.id, apiToken: acc.api_token });
      results.push({ account_id: acc.id, account_name: acc.account_name, ok: true, ...r });
    } catch (e) {
      logger.error({ err: e, tenantId, accountId: acc.id }, 'WB sync-all: account sync failed');
      results.push({ account_id: acc.id, account_name: acc.account_name, ok: false, error: e.message });
    }
  }
  return results;
}

/** Проверяет через WB API, принял ли WB физически заказы отгрузок, которые у
 *  нас всё ещё висят в status='in_transit' (скан QR поставки отгрузчиком уже
 *  сделан, но подтверждения от самой WB мы никогда не спрашивали — раньше
 *  счётчик "в пути" на табло копился бесконечно, т.к. ничего не переводило
 *  отгрузку дальше). wbStatus='waiting' у заказа означает "продавец
 *  подтвердил, WB ещё не получил физически" — как только у ВСЕХ заказов
 *  поставки wbStatus вышел из 'waiting' (sorted/sold/и т.п. — WB реально
 *  принял), переводим отгрузку в status='done' локально. */
async function syncDeliveryStatusForTenant(tenantId) {
  const shipRes = await query(
    `SELECT id, external_id FROM wms.shipments WHERE tenant_id=$1 AND status='in_transit'`,
    [tenantId]
  );
  if (shipRes.rowCount === 0) return { checked: 0, updated: 0 };

  let updated = 0;
  for (const shipment of shipRes.rows) {
    try {
      const ordersRes = await query(
        `SELECT wo.wb_order_id, ma.api_token
         FROM wms.wb_orders wo
         JOIN wms.mp_accounts ma ON ma.id=wo.mp_account_id
         WHERE wo.tenant_id=$1 AND wo.wb_supply_id=$2 AND ma.api_token IS NOT NULL`,
        [tenantId, shipment.external_id]
      );
      if (ordersRes.rowCount === 0) continue; // ещё не досинхронизировано/нет токена — попробуем в следующий прогон

      // Поставка всегда привязана к одному WB-аккаунту, поэтому один токен на все её заказы.
      const token = ordersRes.rows[0].api_token;
      const orderIds = ordersRes.rows.map(r => Number(r.wb_order_id));

      const statuses = await wbClient.fetchOrderStatuses(token, orderIds);
      if (!statuses.length) continue;

      const allAccepted = statuses.every(s => s.wbStatus && s.wbStatus !== 'waiting');
      if (allAccepted) {
        await query(
          `UPDATE wms.shipments SET status='done', wb_accepted_at=NOW(), updated_at=NOW() WHERE id=$1`,
          [shipment.id]
        );
        updated++;
      }
    } catch (e) {
      logger.warn({ err: e.message, tenantId, shipmentId: shipment.id }, 'WB delivery-status check failed for shipment (non-fatal)');
    }
  }
  return { checked: shipRes.rowCount, updated };
}

/** tenant_id всех тенантов с включённым модулем wb_integration и активным доступом (для фонового джоба) */
async function listTenantsWithWbIntegration() {
  const r = await query(
    `SELECT t.id FROM platform.tenants t
     JOIN platform.tenant_modules tm ON tm.tenant_id = t.id AND tm.module_code = 'wb_integration'
     WHERE t.status IN ('trial','active')`
  );
  return r.rows.map(row => row.id);
}

module.exports = {
  getMpAccount,
  listActiveAccounts,
  syncOrdersForAccount,
  syncAllAccountsForTenant,
  syncDeliveryStatusForTenant,
  listTenantsWithWbIntegration,
};
