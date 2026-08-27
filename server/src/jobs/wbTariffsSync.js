'use strict';

const config = require('../config');
const wbTariffsService = require('../modules/platform/wbTariffs.service');
const logger = require('../utils/logger');

// =============================================================================
// Ежедневное обновление тарифов приёмки/логистики/хранения WB по складам
// (platform.wb_warehouse_rates) — общеплатформенная фича, только для владельца.
// Тарифы у WB обновляются раз в сутки, поэтому раз в сутки достаточно и нам
// (WB_TARIFFS_SYNC_INTERVAL_MINUTES, по умолчанию 1440). Если токен ещё не
// задан владельцем в панели платформы — просто тихо пропускаем прогон, это
// не ошибка (фича может быть ещё не настроена).
// =============================================================================

let timer = null;
let running = false;

async function runOnce() {
  if (running) {
    logger.warn('WB tariffs-sync: previous run still in progress, skipping this tick');
    return;
  }
  running = true;
  try {
    const hasToken = await wbTariffsService.hasTariffsToken();
    if (!hasToken) {
      logger.info('WB tariffs-sync: no token configured yet, skipping');
      return;
    }
    const result = await wbTariffsService.fetchAndStoreTariffs();
    logger.info(result, 'WB tariffs-sync run finished');
  } catch (e) {
    logger.error({ err: e }, 'WB tariffs-sync: run failed');
  } finally {
    running = false;
  }
}

function start() {
  const minutes = config.wb.tariffsSyncIntervalMinutes;
  if (!minutes || minutes <= 0) {
    logger.info('WB tariffs-sync disabled (WB_TARIFFS_SYNC_INTERVAL_MINUTES=0)');
    return;
  }
  if (timer) return; // уже запущен
  logger.info({ minutes }, 'WB tariffs-sync scheduler started');
  timer = setInterval(runOnce, minutes * 60_000);
  timer.unref();
  // Стартуем через 150с после подъёма — позже wbAutoSync (60с), wbStockSync
  // (90с) и wbItemsSync (120с), чтобы не толпиться при старте сервера.
  setTimeout(runOnce, 150_000).unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, runOnce };
