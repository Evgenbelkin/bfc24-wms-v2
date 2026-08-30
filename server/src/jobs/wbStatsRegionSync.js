'use strict';

const config = require('../config');
const wbService = require('../modules/wb/wb.service');
const logger = require('../utils/logger');

// =============================================================================
// Синк региона/округа покупателя + СЦ WB на заказах через Statistics API
// (/api/v1/supplier/orders) - нужен для отчёта "время доставки склад -> регион"
// (fbsAnalytics.service.js::getRegionDeliveryTime). Region/oblast недоступны в
// /api/v3/orders/* (address всегда null у FBS-заказов, проверено на живых
// данных 30.08.2026) - Statistics API единственный источник.
//
// ВАЖНО: у этого метода WB лимит 1 запрос/минуту. Обрабатываем ОДИН аккаунт за
// тик (round-robin по всем активным WB-аккаунтам всех тенантов), не все сразу -
// иначе либо мгновенно словим 429 на второй же попытке в том же тике, либо
// придётся городить внутреннюю очередь с ожиданием прямо внутри одного тика.
// Проще размазать по времени: тик раз в WB_STATS_REGION_SYNC_INTERVAL_MINUTES
// (по умолчанию 2 мин) - с запасом даже если у разных аккаунтов лимит общий на
// сторону WB, а не строго на токен.
// =============================================================================

let timer = null;
let running = false;
let cursorIndex = 0; // позиция в списке аккаунтов для round-robin (in-memory, не переживает рестарт)

async function runOnce() {
  if (running) {
    logger.warn('WB stats-region-sync: previous run still in progress, skipping this tick');
    return;
  }
  running = true;
  const startedAt = Date.now();
  try {
    const accounts = await wbService.listAllWbAccountsForStatsSync();
    if (accounts.length === 0) return;

    if (cursorIndex >= accounts.length) cursorIndex = 0;
    const acc = accounts[cursorIndex];
    cursorIndex++;

    try {
      const r = await wbService.syncStatsRegionForAccount({
        tenantId: acc.tenant_id,
        accountId: acc.id,
        apiToken: acc.api_token,
        settings: acc.settings,
      });
      logger.info(
        { tenantId: acc.tenant_id, accountId: acc.id, accountName: acc.account_name, ...r, ms: Date.now() - startedAt },
        'WB stats-region-sync: account synced'
      );
    } catch (e) {
      logger.error({ err: e, tenantId: acc.tenant_id, accountId: acc.id }, 'WB stats-region-sync: account failed');
    }
  } catch (e) {
    logger.error({ err: e }, 'WB stats-region-sync: run failed');
  } finally {
    running = false;
  }
}

function start() {
  const minutes = config.wb.statsRegionSyncIntervalMinutes;
  if (!minutes || minutes <= 0) {
    logger.info('WB stats-region-sync disabled (WB_STATS_REGION_SYNC_INTERVAL_MINUTES=0)');
    return;
  }
  if (timer) return; // уже запущен
  logger.info({ minutes }, 'WB stats-region-sync scheduler started');
  timer = setInterval(runOnce, minutes * 60_000);
  timer.unref();
  // Стартуем через 4 минуты после подъёма - позже остальных WB-джоб (не
  // толпимся при холодном старте, свежие заказы для сопоставления должны уже
  // быть в базе от wbAutoSync).
  setTimeout(runOnce, 4 * 60_000).unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, runOnce };
