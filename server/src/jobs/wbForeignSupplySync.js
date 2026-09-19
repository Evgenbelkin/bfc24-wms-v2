'use strict';

const config = require('../config');
const wbService = require('../modules/wb/wb.service');
const logger = require('../utils/logger');

// =============================================================================
// Обход ЧУЖИХ поставок WB (обрабатывает не наш тенант, а другой оператор на
// том же WB-аккаунте клиента) - кэш scanDt для отчёта "Эффективность складов
// WB" (fbsAnalytics.service.js::getWarehousePerformanceReport). Владелец,
// 19.09.2026: "мне важна информация как быстро работают другие склады".
//
// Только для аккаунтов тенантов, у которых включён модуль warehouse_insights
// (см. wbService.listAllWbAccountsForForeignSupplySync) - без модуля отчёт
// всё равно никто не увидит, незачем тратить WB API квоту.
//
// По аналогии с wbStatsRegionSync.js - round-robin ОДИН аккаунт за тик, а не
// все сразу (эндпоинты /api/v3/supplies и .../order-ids грузим не спеша, хоть
// их лимит и мягче, чем у Statistics API - 300 запросов/мин, но каждый тик
// сам по себе уже может сделать до ~10 списочных + 30 точечных запросов на
// один аккаунт, см. MAX_PAGES/MAX_NEW_LOOKUPS в syncForeignSuppliesForAccount).
// =============================================================================

let timer = null;
let running = false;
let cursorIndex = 0; // позиция в списке аккаунтов для round-robin (in-memory, не переживает рестарт)

async function runOnce() {
  if (running) {
    logger.warn('WB foreign-supply-sync: previous run still in progress, skipping this tick');
    return;
  }
  running = true;
  const startedAt = Date.now();
  try {
    const accounts = await wbService.listAllWbAccountsForForeignSupplySync();
    if (accounts.length === 0) return;

    if (cursorIndex >= accounts.length) cursorIndex = 0;
    const acc = accounts[cursorIndex];
    cursorIndex++;

    try {
      const r = await wbService.syncForeignSuppliesForAccount({
        tenantId: acc.tenant_id,
        accountId: acc.id,
        apiToken: acc.api_token,
      });
      logger.info(
        { tenantId: acc.tenant_id, accountId: acc.id, accountName: acc.account_name, ...r, ms: Date.now() - startedAt },
        'WB foreign-supply-sync: account synced'
      );
    } catch (e) {
      logger.error({ err: e, tenantId: acc.tenant_id, accountId: acc.id }, 'WB foreign-supply-sync: account failed');
    }
  } catch (e) {
    logger.error({ err: e }, 'WB foreign-supply-sync: run failed');
  } finally {
    running = false;
  }
}

function start() {
  const minutes = config.wb.foreignSupplySyncIntervalMinutes;
  if (!minutes || minutes <= 0) {
    logger.info('WB foreign-supply-sync disabled (WB_FOREIGN_SUPPLY_SYNC_INTERVAL_MINUTES=0)');
    return;
  }
  if (timer) return; // уже запущен
  logger.info({ minutes }, 'WB foreign-supply-sync scheduler started');
  timer = setInterval(runOnce, minutes * 60_000);
  timer.unref();
  // Стартуем через 5 минут после подъёма - позже остальных WB-джоб (не
  // толпимся при холодном старте).
  setTimeout(runOnce, 5 * 60_000).unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, runOnce };
