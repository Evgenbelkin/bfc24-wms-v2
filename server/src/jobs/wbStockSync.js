'use strict';

const config = require('../config');
const wbService = require('../modules/wb/wb.service');
const logger = require('../utils/logger');

// =============================================================================
// Контрольная синхронизация остатков FBS в WB - редкий полный пересчёт.
//
// ОСНОВНОЙ механизм актуализации остатков в WB - точечный пересчёт по
// событию (приёмка/инвентаризация/сборка комплекта), см.
// triggerRedistributionForClient(..., { barcodes }) в receiving.service.js/
// inventory.service.js. Он теперь всегда передаёт КОНКРЕТНЫЙ затронутый
// штрихкод, а не весь ассортимент клиента - раньше (до 12.08.2026) событие по
// одному товару пересчитывало ВСЕ товары клиента разом, что регулярно
// приводило к завышенным пушам: у других товаров в этот момент могли быть уже
// принятые, но ещё не собранные в волну WB-заказы (резерв в WMS проставляется
// только при генерации волны сборки), их "полный" остаток в WMS пересчёт
// заново отправлял в WB - фактически возвращая то, что WB уже продал.
// Подробности инцидента (товар 2006784216833, клиент Yellow Fish,
// 11-12.08.2026, WB принял 53 заказа при 47 когда-либо принятых физически) -
// см. комментарий над distributeStockForAccount в wb.service.js.
//
// Этот прогон - ДОПОЛНИТЕЛЬНАЯ, редкая подстраховка сверху точечного
// пересчёта (по умолчанию 3 раза/сутки = каждые 480 минут,
// WB_STOCK_SYNC_INTERVAL_MINUTES), а НЕ основной механизм - обходит ВСЕ
// активные WB-аккаунты и пересчитывает весь их ассортимент разом. Специально
// редко: у полного пересчёта тот же риск завышенного пуша, что и вызвал
// инцидент, часто гонять его - держать этот риск открытым постоянно. Ловит
// то, что точечный пересчёт по определению не видит (например остаток,
// изменённый вручную прямо в кабинете WB, или разовый сбой на конкретном
// событии). Ошибка по одному аккаунту/тенанту не должна останавливать обход
// остальных - тот же принцип, что в wbAutoSync.js.
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
