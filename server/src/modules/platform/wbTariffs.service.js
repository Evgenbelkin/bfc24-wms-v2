'use strict';

const { query } = require('../../config/database');
const wbClient = require('../wb/wb.client');
const logger = require('../../utils/logger');

// =============================================================================
// Тарифы приёмки/логистики/хранения WB по складам — общеплатформенная фича,
// видна ТОЛЬКО владельцу платформы (роуты за platformAuthRequired), не
// тенантам-клиентам. Тарифы у WB одинаковые для любого продавца, поэтому
// запрашиваются одним токеном (личный кабинет владельца "Мой магазин вб"),
// который владелец сам вводит в панели платформы и хранится отдельно от
// клиентских WB-токенов (platform.settings, ключ 'wb_tariffs_api_token').
// =============================================================================

const SETTINGS_KEY = 'wb_tariffs_api_token';

async function getTariffsToken() {
  const r = await query(`SELECT value FROM platform.settings WHERE key=$1`, [SETTINGS_KEY]);
  return r.rowCount ? r.rows[0].value : null;
}

async function setTariffsToken(token, platformUserId) {
  const value = String(token || '').trim();
  if (!value) throw new Error('Токен не может быть пустым');
  await query(
    `INSERT INTO platform.settings(key, value, updated_at, updated_by)
     VALUES ($1,$2,NOW(),$3)
     ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW(), updated_by=$3`,
    [SETTINGS_KEY, value, platformUserId || null]
  );
}

function hasTariffsToken() {
  return getTariffsToken().then(t => !!t);
}

// WB иногда присылает числа строками с запятой вместо точки ("123,45") —
// парсим с фолбэком на null, а не 0 (0 ₽ выглядело бы как настоящий тариф).
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Запросить тарифы у WB и сохранить снимок на сегодня. */
async function fetchAndStoreTariffs() {
  const token = await getTariffsToken();
  if (!token) {
    throw new Error('Токен для запроса тарифов WB не задан — введите его в панели платформы');
  }

  const { dtNextBox, dtTillMax, warehouseList } = await wbClient.fetchBoxTariffs(token);
  const tariffDate = new Date().toISOString().slice(0, 10);

  let saved = 0;
  for (const w of warehouseList) {
    const warehouseName = w.warehouseName || w.geoName;
    if (!warehouseName) continue;
    await query(
      `INSERT INTO platform.wb_warehouse_rates
         (tariff_date, warehouse_name, geo_name,
          box_delivery_base, box_delivery_coef_expr, box_delivery_liter,
          box_delivery_marketplace_base, box_delivery_marketplace_coef_expr, box_delivery_marketplace_liter,
          box_storage_base, box_storage_coef_expr, box_storage_liter,
          dt_next_box, dt_till_max, raw_data, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
       ON CONFLICT (warehouse_name, tariff_date) DO UPDATE SET
         geo_name=$3,
         box_delivery_base=$4, box_delivery_coef_expr=$5, box_delivery_liter=$6,
         box_delivery_marketplace_base=$7, box_delivery_marketplace_coef_expr=$8, box_delivery_marketplace_liter=$9,
         box_storage_base=$10, box_storage_coef_expr=$11, box_storage_liter=$12,
         dt_next_box=$13, dt_till_max=$14, raw_data=$15, fetched_at=NOW()`,
      [
        tariffDate, warehouseName, w.geoName || null,
        num(w.boxDeliveryBase), num(w.boxDeliveryCoefExpr), num(w.boxDeliveryLiter),
        num(w.boxDeliveryMarketplaceBase), num(w.boxDeliveryMarketplaceCoefExpr), num(w.boxDeliveryMarketplaceLiter),
        num(w.boxStorageBase), num(w.boxStorageCoefExpr), num(w.boxStorageLiter),
        dtNextBox ? new Date(dtNextBox) : null, dtTillMax ? new Date(dtTillMax) : null,
        JSON.stringify(w),
      ]
    );
    saved++;
  }

  logger.info({ saved, tariffDate }, 'WB warehouse tariffs fetched and stored');
  return { saved, tariffDate, dtNextBox, dtTillMax };
}

/** Последний сохранённый снимок тарифов (самая свежая tariff_date). */
async function listLatestTariffs() {
  const dateRes = await query(`SELECT MAX(tariff_date) AS d FROM platform.wb_warehouse_rates`);
  const latestDate = dateRes.rows[0]?.d;
  if (!latestDate) return { tariff_date: null, tariffs: [] };

  const r = await query(
    `SELECT warehouse_name, geo_name,
            box_delivery_base, box_delivery_coef_expr, box_delivery_liter,
            box_delivery_marketplace_base, box_delivery_marketplace_coef_expr, box_delivery_marketplace_liter,
            box_storage_base, box_storage_coef_expr, box_storage_liter,
            dt_next_box, dt_till_max, fetched_at
     FROM platform.wb_warehouse_rates
     WHERE tariff_date = $1
     ORDER BY box_delivery_base ASC NULLS LAST, warehouse_name ASC`,
    [latestDate]
  );
  return { tariff_date: latestDate, tariffs: r.rows };
}

module.exports = {
  getTariffsToken,
  setTariffsToken,
  hasTariffsToken,
  fetchAndStoreTariffs,
  listLatestTariffs,
};
