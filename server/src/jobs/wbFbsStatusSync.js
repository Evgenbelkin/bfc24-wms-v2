'use strict';

const config = require('../config');
const wbService = require('../modules/wb/wb.service');
const fbsAnalyticsService = require('../modules/fbsAnalytics/fbsAnalytics.service');
const logger = require('../utils/logger');

// =============================================================================
// Периодический опрос реального статуса заказа на стороне WB (wbStatus, POST
// /api/v3/orders/status) для модуля "Аналитика FBS" - раньше этот статус
// нигде не сохранялся (использовался только "на лету" в
// syncDeliveryStatusForTenant). Обновляем раз в 30 минут по умолчанию - тот
// же интервал, что и у WB для собственного пересчёта (см. документацию
// конкурентов: "для Wildberries — каждые 30 минут").
// =============================================================================

let timer = null;
let running = false;

async function runOnce() {
  if (running) {
    logger.warn('WB FBS status-sync: previous run still in progress, skipping this tick');
    return;
  }
  running = true;
  const startedAt = Date.now();
  try {
    const tenantIds = await wbService.listTenantsWithWbIntegration();
    let totalChecked = 0, totalUpdated = 0;
    for (const tenantId of tenantIds) {
      try {
        const r = await fbsAnalyticsService.refreshWbStatusesForTenant(tenantId);
        totalChecked += r.checked;
        totalUpdated += r.updated;
      } catch (e) {
        logger.error({ err: e, tenantId }, 'WB FBS status-sync: failed for tenant');
      }
    }
    logger.info(
      { tenants: tenantIds.length, checked: totalChecked, updated: totalUpdated, ms: Date.now() - startedAt },
      'WB FBS status-sync run finished'
    );
  } catch (e) {
    logger.error({ err: e }, 'WB FBS status-sync: run failed');
  } finally {
    running = false;
  }
}

function start() {
  const minutes = config.wb.fbsStatusSyncIntervalMinutes;
  if (!minutes || minutes <= 0) {
    logger.info('WB FBS status-sync disabled (WB_FBS_STATUS_SYNC_INTERVAL_MINUTES=0)');
    return;
  }
  if (timer) return; // уже запущен
  logger.info({ minutes }, 'WB FBS status-sync scheduler started');
  timer = setInterval(runOnce, minutes * 60_000);
  timer.unref();
  // Стартуем через 210с после подъёма - позже остальных WB-джоб, чтобы не
  // толпиться при старте сервера.
  setTimeout(runOnce, 210_000).unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, runOnce };
