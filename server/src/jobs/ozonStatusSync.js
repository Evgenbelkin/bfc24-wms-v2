'use strict';

const ozonService = require('../modules/ozon/ozon.service');
const logger = require('../utils/logger');

// =============================================================================
// Задача #75 (первая половина — обратный синк статусов; пуш остатков
// сознательно отложен отдельной задачей, см. комментарий у
// reflectTerminalStatusesForTenant в ozon.service.js) — фоновая
// автосинхронизация отправлений Ozon, тот же паттерн, что wbAutoSync.js.
//
// На каждый тик по каждому тенанту с включённым модулем ozon_integration:
//   1) syncAllAccountsForTenant — подтягивает свежие статусы отправлений со
//      всех активных Ozon-аккаунтов (то же самое, что кнопка "Синхронизировать
//      отправления" в интерфейсе — просто без участия человека).
//   2) reflectTerminalStatusesForTenant — если Ozon уже сообщил "отменено"
//      или "доставлено", а наша локальная отгрузка ещё не закрыта, закрываем
//      её сами (иначе отменённый на Ozon заказ навсегда висит активной волной
//      в "Диспетчерской", и наоборот — доставленный годами торчит в "в пути").
// =============================================================================

let timer = null;
let running = false;

async function runOnce() {
  if (running) {
    logger.warn('Ozon status-sync: previous run still in progress, skipping this tick');
    return;
  }
  running = true;
  const startedAt = Date.now();
  try {
    const tenantIds = await ozonService.listTenantsWithOzonIntegration();
    let totalAccounts = 0, totalSaved = 0, totalCancelled = 0, totalDelivered = 0, totalErrors = 0;
    for (const tenantId of tenantIds) {
      try {
        const results = await ozonService.syncAllAccountsForTenant(tenantId);
        totalAccounts += results.length;
        totalSaved += results.reduce((s, r) => s + (r.saved || 0), 0);
        totalErrors += results.filter(r => !r.ok).length;
      } catch (e) {
        totalErrors++;
        logger.error({ err: e, tenantId }, 'Ozon status-sync: tenant sync failed');
      }

      try {
        const r = await ozonService.reflectTerminalStatusesForTenant(tenantId);
        totalCancelled += r.cancelled;
        totalDelivered += r.delivered;
        totalErrors += r.errors;
      } catch (e) {
        totalErrors++;
        logger.error({ err: e, tenantId }, 'Ozon status-sync: reflect terminal statuses failed');
      }
    }
    logger.info(
      {
        tenants: tenantIds.length, accounts: totalAccounts, saved: totalSaved,
        cancelled: totalCancelled, delivered: totalDelivered, errors: totalErrors,
        ms: Date.now() - startedAt,
      },
      'Ozon status-sync run finished'
    );
  } catch (e) {
    logger.error({ err: e }, 'Ozon status-sync: run failed');
  } finally {
    running = false;
  }
}

function start() {
  const minutes = Number(process.env.OZON_STATUS_SYNC_INTERVAL_MINUTES || 15);
  if (!minutes || minutes <= 0) {
    logger.info('Ozon status-sync disabled (OZON_STATUS_SYNC_INTERVAL_MINUTES=0)');
    return;
  }
  if (timer) return; // уже запущен
  logger.info({ minutes }, 'Ozon status-sync scheduler started');
  timer = setInterval(runOnce, minutes * 60_000);
  timer.unref();
  // Стартуем через 75с после подъёма — позже wbAutoSync (60с), чтобы не
  // толпиться при старте сервера.
  setTimeout(runOnce, 75_000).unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, runOnce };
