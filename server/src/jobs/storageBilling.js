'use strict';

const billing = require('../modules/billing/billing.service');
const logger = require('../utils/logger');

// =============================================================================
// Ежедневное начисление за хранение.
// Раз в сутки обходит всех клиентов с активным прайсом на 'storage' (у
// тенантов с включённым модулем billing) и начисляет за количество занятых
// грузомест сегодняшним днём. Идемпотентно (см. billing.service.js:
// chargeStorageForClientToday) — повторный прогон в тот же день ничего не
// задвоит. Ошибка по одному клиенту не должна останавливать обход остальных
// (тот же принцип, что и в wbAutoSync.js).
// =============================================================================

let timer = null;
let running = false;

const INTERVAL_MS = 24 * 60 * 60_000; // раз в сутки

async function runOnce() {
  if (running) {
    logger.warn('Storage billing: previous run still in progress, skipping this tick');
    return;
  }
  running = true;
  const startedAt = Date.now();
  try {
    const clients = await billing.listClientsWithActiveStoragePrice();
    let charged = 0, skipped = 0, errors = 0;
    for (const { tenant_id: tenantId, client_id: clientId } of clients) {
      try {
        const charge = await billing.chargeStorageForClientToday({ tenantId, clientId });
        if (charge) charged++; else skipped++;
      } catch (e) {
        errors++;
        logger.error({ err: e, tenantId, clientId }, 'Storage billing: charge failed for client');
      }
    }
    logger.info({ clients: clients.length, charged, skipped, errors, ms: Date.now() - startedAt }, 'Storage billing run finished');
  } catch (e) {
    logger.error({ err: e }, 'Storage billing: run failed');
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return; // уже запущен
  logger.info('Storage billing scheduler started (once per 24h)');
  timer = setInterval(runOnce, INTERVAL_MS);
  timer.unref();
  // Первый прогон — через пару минут после старта сервера, не сразу.
  setTimeout(runOnce, 2 * 60_000).unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, runOnce };
