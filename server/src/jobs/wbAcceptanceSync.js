'use strict';

const config = require('../config');
const wbTariffsService = require('../modules/platform/wbTariffs.service');
const wbAcceptanceService = require('../modules/platform/wbAcceptance.service');
const logger = require('../utils/logger');

// =============================================================================
// Периодическое обновление коэффициентов приёмки ФБС по складам WB
// (platform.wb_acceptance_coefficients) - данные динамические (меняются в
// течение дня), поэтому обновляем чаще, чем статичные тарифы (wbTariffsSync.js,
// раз в сутки). Используется тот же токен владельца платформы - если у него
// нет категории "Поставки", прогон просто будет падать с ошибкой в логах,
// не ломая остальное. WB_ACCEPTANCE_SYNC_INTERVAL_MINUTES, по умолчанию 60.
// =============================================================================

let timer = null;
let running = false;

async function runOnce() {
  if (running) {
    logger.warn('WB acceptance-sync: previous run still in progress, skipping this tick');
    return;
  }
  running = true;
  try {
    const hasToken = await wbTariffsService.hasTariffsToken();
    if (!hasToken) {
      logger.info('WB acceptance-sync: no token configured yet, skipping');
      return;
    }
    const result = await wbAcceptanceService.fetchAndStoreCoefficients();
    logger.info(result, 'WB acceptance-sync run finished');
  } catch (e) {
    logger.error({ err: e }, 'WB acceptance-sync: run failed');
  } finally {
    running = false;
  }
}

function start() {
  const minutes = config.wb.acceptanceSyncIntervalMinutes;
  if (!minutes || minutes <= 0) {
    logger.info('WB acceptance-sync disabled (WB_ACCEPTANCE_SYNC_INTERVAL_MINUTES=0)');
    return;
  }
  if (timer) return; // уже запущен
  logger.info({ minutes }, 'WB acceptance-sync scheduler started');
  timer = setInterval(runOnce, minutes * 60_000);
  timer.unref();
  // Стартуем через 180с после подъёма - позже wbTariffsSync (150с), чтобы не
  // толпиться с ним при старте сервера на один и тот же токен.
  setTimeout(runOnce, 180_000).unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, runOnce };
