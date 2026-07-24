'use strict';

const config = require('../config');
const wbService = require('../modules/wb/wb.service');
const logger = require('../utils/logger');

// =============================================================================
// Фоновая автосинхронизация заказов WB.
// Каждые N минут (WB_AUTO_SYNC_INTERVAL_MINUTES, по умолчанию 15) обходит всех
// тенантов с включённым модулем wb_integration и синхронизирует заказы по всем
// их активным WB-аккаунтам — так фулфилменту не нужно вручную заходить в каждый
// магазин клиента и жать "Синхронизировать". Ошибка по одному аккаунту/тенанту
// не должна останавливать обход остальных.
// =============================================================================

let timer = null;
let running = false;

async function runOnce() {
  if (running) {
    logger.warn('WB auto-sync: previous run still in progress, skipping this tick');
    return;
  }
  running = true;
  const startedAt = Date.now();
  try {
    const tenantIds = await wbService.listTenantsWithWbIntegration();
    let totalAccounts = 0, totalSaved = 0, totalErrors = 0;
    for (const tenantId of tenantIds) {
      try {
        const results = await wbService.syncAllAccountsForTenant(tenantId);
        totalAccounts += results.length;
        totalSaved += results.reduce((s,r)=>s+(r.saved||0),0);
        totalErrors += results.filter(r=>!r.ok).length;
      } catch (e) {
        totalErrors++;
        logger.error({ err: e, tenantId }, 'WB auto-sync: tenant sync failed');
      }
    }
    logger.info(
      { tenants: tenantIds.length, accounts: totalAccounts, saved: totalSaved, errors: totalErrors, ms: Date.now()-startedAt },
      'WB auto-sync run finished'
    );
  } catch (e) {
    logger.error({ err: e }, 'WB auto-sync: run failed');
  } finally {
    running = false;
  }
}

function start() {
  const minutes = config.wb.autoSyncIntervalMinutes;
  if (!minutes || minutes <= 0) {
    logger.info('WB auto-sync disabled (WB_AUTO_SYNC_INTERVAL_MINUTES=0)');
    return;
  }
  if (timer) return; // уже запущен
  logger.info({ minutes }, 'WB auto-sync scheduler started');
  // Первый прогон — не сразу при старте сервера, а через минуту (даём приложению подняться)
  timer = setInterval(runOnce, minutes * 60_000);
  timer.unref();
  setTimeout(runOnce, 60_000).unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, runOnce };
