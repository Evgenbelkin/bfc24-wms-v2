'use strict';

const config = require('../config');
const wbService = require('../modules/wb/wb.service');
const logger = require('../utils/logger');

// =============================================================================
// Фоновый периодический пересчёт и отправка остатков FBS в WB.
//
// РАНЬШЕ пересчёт (distributeStockForAccount) запускался только по событиям -
// приёмка/инвентаризация/смена клиентом весов складов (см. вызовы
// triggerRedistributionForClient в receiving.service.js/inventory.service.js/
// seller.router.js). Расчёт был на то, что WB сам корректно уменьшает остаток
// на своей стороне по мере поступления заказов, и лишний пересчёт только
// собьёт счётчики - см. подробный комментарий над distributeStockForAccount в
// wb.service.js.
//
// На практике (инцидент 11-12.08.2026, товар 2006784216833, клиент Yellow
// Fish) это не подтвердилось: пересчёт по этому товару не запускался НЕСКОЛЬКО
// ДНЕЙ (никто не делал приёмку/инвентаризацию именно по нему), а заказы на WB
// продолжали идти - в итоге WB принял 53 заказа при 47 когда-либо принятых
// физически (проверено по wms.stock_movements/wms.wb_orders). WB не
// гарантированно защищает от овербукинга сам по себе - особенно когда остаток
// раздроблен на 7-11 отдельных "виртуальных" складов продавца.
//
// Этот периодический прогон - страховка сверху основного фикса (самообнуление
// в distributeStockForAccount): каждые WB_STOCK_SYNC_INTERVAL_MINUTES минут
// (по умолчанию 15, как и у wbAutoSync) пересчитывает и отправляет остатки по
// ВСЕМ активным WB-аккаунтам, а не только по событию. Ошибка по одному
// аккаунту/тенанту не должна останавливать обход остальных - тот же принцип,
// что в wbAutoSync.js.
// =============================================================================

let timer = null;
let running = false;

async function runOnce() {
  if (running) {
    logger.warn('WB stock-sync: previous run still in progress, skipping this tick');
    return;
  }
  running = true;
  const startedAt = Date.now();
  try {
    const tenantIds = await wbService.listTenantsWithWbIntegration();
    let totalAccounts = 0, totalErrors = 0;
    for (const tenantId of tenantIds) {
      let accounts;
      try {
        accounts = await wbService.listActiveAccounts(tenantId);
      } catch (e) {
        logger.error({ err: e, tenantId }, 'WB stock-sync: failed to list accounts for tenant');
        continue;
      }
      for (const acc of accounts) {
        totalAccounts++;
        try {
          await wbService.distributeStockForAccount({ tenantId, mpAccountId: acc.id });
        } catch (e) {
          totalErrors++;
          logger.error({ err: e, tenantId, mpAccountId: acc.id }, 'WB stock-sync: distribute failed for account');
        }
      }
    }
    logger.info(
      { tenants: tenantIds.length, accounts: totalAccounts, errors: totalErrors, ms: Date.now() - startedAt },
      'WB stock-sync run finished'
    );
  } catch (e) {
    logger.error({ err: e }, 'WB stock-sync: run failed');
  } finally {
    running = false;
  }
}

function start() {
  const minutes = config.wb.stockSyncIntervalMinutes;
  if (!minutes || minutes <= 0) {
    logger.info('WB stock-sync disabled (WB_STOCK_SYNC_INTERVAL_MINUTES=0)');
    return;
  }
  if (timer) return; // уже запущен
  logger.info({ minutes }, 'WB stock-sync scheduler started');
  timer = setInterval(runOnce, minutes * 60_000);
  timer.unref();
  // Стартуем через 90с после подъёма, немного позже wbAutoSync (60с) - чтобы
  // не толпиться с ним при старте сервера на одни и те же WB-аккаунты.
  setTimeout(runOnce, 90_000).unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, runOnce };
