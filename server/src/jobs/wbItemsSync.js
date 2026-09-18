'use strict';

const config = require('../config');
const wbService = require('../modules/wb/wb.service');
const logger = require('../utils/logger');

// =============================================================================
// Фоновая синхронизация карточек товаров WB (номенклатура) - заполняет
// размер (techSize/wbSize), габариты и объём в wms.items по каждому barcode.
//
// Раньше это происходило ТОЛЬКО по клику "Импортировать карточки из WB" в
// панели интеграции (public/app/wb.html) - если администратор клиента ни
// разу не нажимал эту кнопку (частый случай: интеграцию настраивал
// фулфилмент, а не сам клиент), поле "Размер" в кабинете клиента и в
// остатках оставалось пустым НАВСЕГДА, хотя у самого WB эти данные есть по
// каждой карточке. Для одежды/обуви размер - основной способ отличить
// штрихкоды друг от друга, поэтому это не декоративное поле.
//
// Карточки товаров меняются редко (новый товар/новый цвет-размер заводится
// не каждый день) - в отличие от остатков и заказов, гонять этот пересчёт
// часто незачем. По умолчанию раз в сутки (WB_ITEMS_SYNC_INTERVAL_MINUTES).
// Ошибка по одному аккаунту/тенанту не должна останавливать обход
// остальных - тот же принцип, что в wbAutoSync.js/wbStockSync.js.
// =============================================================================

let timer = null;
let running = false;

async function runOnce() {
  if (running) {
    logger.warn('WB items-sync: previous run still in progress, skipping this tick');
    return;
  }
  running = true;
  const startedAt = Date.now();
  try {
    const tenantIds = await wbService.listTenantsWithWbIntegration();
    let totalAccounts = 0, totalErrors = 0, totalSavedItems = 0;
    for (const tenantId of tenantIds) {
      try {
        const results = await wbService.importItemsForAllAccounts(tenantId);
        totalAccounts += results.length;
        totalSavedItems += results.reduce((s,r)=>s+(r.saved_items||0),0);
        totalErrors += results.filter(r=>!r.ok).length;
      } catch (e) {
        totalErrors++;
        logger.error({ err: e, tenantId }, 'WB items-sync: tenant import failed');
      }
    }
    logger.info(
      { tenants: tenantIds.length, accounts: totalAccounts, savedItems: totalSavedItems, errors: totalErrors, ms: Date.now() - startedAt },
      'WB items-sync run finished'
    );
  } catch (e) {
    logger.error({ err: e }, 'WB items-sync: run failed');
  } finally {
    running = false;
  }
}

function start() {
  const minutes = config.wb.itemsSyncIntervalMinutes;
  if (!minutes || minutes <= 0) {
    logger.info('WB items-sync disabled (WB_ITEMS_SYNC_INTERVAL_MINUTES=0)');
    return;
  }
  if (timer) return; // уже запущен
  logger.info({ minutes }, 'WB items-sync scheduler started');
  timer = setInterval(runOnce, minutes * 60_000);
  timer.unref();
  // Стартуем через 120с после подъёма - позже wbAutoSync (60с) и wbStockSync
  // (90с), чтобы не толпиться с ними при старте сервера на одни и те же
  // WB-аккаунты (карточки товаров - самый тяжёлый и редкий из трёх опросов).
  setTimeout(runOnce, 120_000).unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, runOnce };
