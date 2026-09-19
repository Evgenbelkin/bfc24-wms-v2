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
// ИЗНАЧАЛЬНО было round-robin ОДИН аккаунт за тик (по аналогии с
// wbStatsRegionSync.js), но это оказалось неудачным решением: курсор
// хранится в памяти и сбрасывается на 0 при каждом `pm2 restart` (а деплои
// частые) - в итоге аккаунты в конце списка (ORDER BY ma.id) месяцами не
// доходили до своей очереди (владелец, 19.09.2026: обнаружено на примере
// аккаунта "ИП Макарова С. И", который проходил все условия выборки, но не
// обрабатывался). Эндпоинты /api/v3/supplies и .../order-ids используют
// лимит 300 запросов/мин НА АККАУНТ (в отличие от Statistics API с его
// жёстким 1 запрос/мин) - поэтому последовательный проход ВСЕХ аккаунтов
// за один тик безопасен, курсор больше не нужен.
// =============================================================================

let timer = null;
let running = false;

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

    for (const acc of accounts) {
      const accStartedAt = Date.now();
      try {
        const r = await wbService.syncForeignSuppliesForAccount({
          tenantId: acc.tenant_id,
          accountId: acc.id,
          apiToken: acc.api_token,
        });
        logger.info(
          { tenantId: acc.tenant_id, accountId: acc.id, accountName: acc.account_name, ...r, ms: Date.now() - accStartedAt },
          'WB foreign-supply-sync: account synced'
        );
      } catch (e) {
        logger.error({ err: e, tenantId: acc.tenant_id, accountId: acc.id }, 'WB foreign-supply-sync: account failed');
      }
    }
    logger.info({ accounts: accounts.length, ms: Date.now() - startedAt }, 'WB foreign-supply-sync: full run finished');
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
