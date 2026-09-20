'use strict';

const config = require('../config');
const wbService = require('../modules/wb/wb.service');
const logger = require('../utils/logger');

// =============================================================================
// Синк РЕАЛЬНОГО времени продажи (Statistics API /api/v1/supplier/sales) —
// нужен для точного дедлайна "вывод из оборота" Честного знака (владелец,
// 20.09.2026: "в 'ждут выгрузки' почему то одинаковое время у кизов, разве
// так должно быть? просто проданы они в разное время а не в одно" — раньше
// дедлайн считался от момента, когда наш job УВИДЕЛ статус 'sold' при
// опросе (~раз в 30 мин), а не от реального времени продажи).
//
// ВАЖНО: у этого метода WB, как и у /orders (см. wbStatsRegionSync.js),
// лимит 1 запрос/минуту — обрабатываем ОДИН аккаунт за тик. В ОТЛИЧИЕ от
// wbStatsRegionSync.js курсор "чей сейчас черёд" НЕ храним в памяти
// процесса: in-memory round-robin уже дважды подводил (см. комментарий в
// wbForeignSupplySync.js и диагностику 19.09.2026 с аккаунтом ИП Макарова
// С.И. — pm2 restart сбрасывал позицию, и аккаунты в хвосте списка месяцами
// не доходили до синка). Вместо этого на каждый тик выбираем аккаунт с
// САМЫМ старым settings.sales_sync.last_attempt_at (никогда не синканные —
// в приоритете, т.к. отсутствующее значение сортируется первым). Это даёт
// тот же результат, что и round-robin, но переживает рестарты без
// какого-либо отдельного состояния — просто читаем то, что синк сам же
// пишет в mp_accounts.settings при каждой попытке (успешной и нет).
// =============================================================================

let timer = null;
let running = false;

function pickLeastRecentlyAttempted(accounts) {
  return accounts.slice().sort((a, b) => {
    const ta = a.settings?.sales_sync?.last_attempt_at || '';
    const tb = b.settings?.sales_sync?.last_attempt_at || '';
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  })[0];
}

async function runOnce() {
  if (running) {
    logger.warn('WB sales-sync: previous run still in progress, skipping this tick');
    return;
  }
  running = true;
  const startedAt = Date.now();
  try {
    // Переиспользуем тот же список аккаунтов, что и wbStatsRegionSync.js —
    // те же условия применимости (нужен токен категории "Статистика", это
    // тот же Statistics API у WB).
    const accounts = await wbService.listAllWbAccountsForStatsSync();
    if (accounts.length === 0) return;

    const acc = pickLeastRecentlyAttempted(accounts);

    try {
      const r = await wbService.syncSalesForAccount({
        tenantId: acc.tenant_id,
        accountId: acc.id,
        apiToken: acc.api_token_stats || acc.api_token,
        settings: acc.settings,
      });
      logger.info(
        { tenantId: acc.tenant_id, accountId: acc.id, accountName: acc.account_name, ...r, ms: Date.now() - startedAt },
        'WB sales-sync: account synced'
      );
    } catch (e) {
      logger.error({ err: e, tenantId: acc.tenant_id, accountId: acc.id }, 'WB sales-sync: account failed');
    }
  } catch (e) {
    logger.error({ err: e }, 'WB sales-sync: run failed');
  } finally {
    running = false;
  }
}

function start() {
  const minutes = config.wb.salesSyncIntervalMinutes;
  if (!minutes || minutes <= 0) {
    logger.info('WB sales-sync disabled (WB_SALES_SYNC_INTERVAL_MINUTES=0)');
    return;
  }
  if (timer) return; // уже запущен
  logger.info({ minutes }, 'WB sales-sync scheduler started');
  timer = setInterval(runOnce, minutes * 60_000);
  timer.unref();
  // Стартуем через 6 минут после подъёма — позже остальных WB-джоб (не
  // толпимся при холодном старте).
  setTimeout(runOnce, 6 * 60_000).unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, runOnce };
