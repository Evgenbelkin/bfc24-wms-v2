'use strict';

const { query } = require('../../config/database');
const wbClient = require('../wb/wb.client');
const wbTariffsService = require('./wbTariffs.service');
const logger = require('../../utils/logger');

// =============================================================================
// Коэффициенты приёмки ФБС по складам WB — ДИНАМИЧЕСКИЕ данные (меняются в
// течение дня), в отличие от статичных тарифов логистики/хранения в
// wbTariffs.service.js. Тот же общий токен владельца платформы (см.
// wbTariffs.service.js:getTariffsToken) - категория токена должна включать
// "Поставки", иначе этот метод вернёт 401/403 отдельно от tariffs/box.
// =============================================================================

const PREFERRED_BOX_TYPE = 'Короба'; // основной тип для ФБС-поставок коробками

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** Запросить у WB коэффициенты приёмки и сохранить снимок. */
async function fetchAndStoreCoefficients() {
  const token = await wbTariffsService.getTariffsToken();
  if (!token) {
    throw new Error('Токен для запроса тарифов/приёмки WB не задан — введите его в панели платформы');
  }

  const rows = await wbClient.fetchAcceptanceCoefficients(token);
  let saved = 0;
  for (const r of rows) {
    const warehouseId = r.warehouseID ?? r.warehouseId;
    const dateStr = r.date ? String(r.date).slice(0, 10) : null;
    if (!warehouseId || !dateStr) continue;
    const boxTypeId = r.boxTypeID ?? r.boxTypeId ?? -1;
    await query(
      `INSERT INTO platform.wb_acceptance_coefficients
         (warehouse_id, warehouse_name, box_type_id, box_type_name, coef_date,
          coefficient, allow_unload, is_sorting_center, raw_data, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (warehouse_id, box_type_id, coef_date) DO UPDATE SET
         warehouse_name=$2, box_type_name=$4,
         coefficient=$6, allow_unload=$7, is_sorting_center=$8, raw_data=$9, fetched_at=NOW()`,
      [
        warehouseId, r.warehouseName || String(warehouseId), boxTypeId, r.boxTypeName || null, dateStr,
        num(r.coefficient), r.allowUnload === true, r.isSortingCenter === true, JSON.stringify(r),
      ]
    );
    saved++;
  }

  // Старые даты (прошедшие) больше не нужны - таблица иначе растёт бесконечно,
  // а прошлое тут не имеет смысла (это не история, а прогноз на будущее).
  await query(`DELETE FROM platform.wb_acceptance_coefficients WHERE coef_date < CURRENT_DATE`);

  logger.info({ saved, fetched: rows.length }, 'WB acceptance coefficients fetched and stored');
  return { saved };
}

/**
 * Для каждого склада: статус на сегодня + ближайшая бесплатная дата (coefficient=0).
 * Предпочитаем строки с box_type_name='Короба' (обычные ФБС-поставки коробками),
 * если для склада есть несколько типов приёмки (короба/монопаллеты/сейф-пакеты) -
 * остальные типы тут не так релевантны для типового ФФ-клиента.
 */
async function listNearestFreeSlots() {
  const r = await query(
    `SELECT DISTINCT ON (warehouse_id, coef_date)
        warehouse_id, warehouse_name, box_type_name, coef_date, coefficient, allow_unload
     FROM platform.wb_acceptance_coefficients
     WHERE coef_date >= CURRENT_DATE
     ORDER BY warehouse_id, coef_date,
       (box_type_name = $1) DESC NULLS LAST`,
    [PREFERRED_BOX_TYPE]
  );

  const today = new Date().toISOString().slice(0, 10);
  const byWarehouse = new Map();
  for (const row of r.rows) {
    if (!byWarehouse.has(row.warehouse_id)) {
      byWarehouse.set(row.warehouse_id, { warehouse_id: row.warehouse_id, warehouse_name: row.warehouse_name, days: [] });
    }
    byWarehouse.get(row.warehouse_id).days.push(row);
  }

  const result = [];
  for (const w of byWarehouse.values()) {
    w.days.sort((a, b) => String(a.coef_date).localeCompare(String(b.coef_date)));
    const todayRow = w.days.find(d => String(d.coef_date).slice(0, 10) === today);
    const freeRow = w.days.find(d => Number(d.coefficient) === 0 && d.allow_unload);

    let daysUntilFree = null;
    if (freeRow) {
      const diffMs = new Date(freeRow.coef_date).getTime() - new Date(today).getTime();
      daysUntilFree = Math.round(diffMs / 86400000);
    }

    result.push({
      warehouse_id: w.warehouse_id,
      warehouse_name: w.warehouse_name,
      today_coefficient: todayRow ? Number(todayRow.coefficient) : null,
      today_allow_unload: todayRow ? todayRow.allow_unload : null,
      nearest_free_date: freeRow ? freeRow.coef_date : null,
      days_until_free: daysUntilFree,
    });
  }

  result.sort((a, b) => a.warehouse_name.localeCompare(b.warehouse_name, 'ru'));

  const fetchedAtRes = await query(`SELECT MAX(fetched_at) AS t FROM platform.wb_acceptance_coefficients`);
  return { warehouses: result, fetched_at: fetchedAtRes.rows[0]?.t || null };
}

module.exports = {
  fetchAndStoreCoefficients,
  listNearestFreeSlots,
};
