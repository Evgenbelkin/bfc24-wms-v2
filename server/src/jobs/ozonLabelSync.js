'use strict';

const ozonService = require('../modules/ozon/ozon.service');
const logger = require('../utils/logger');

// =============================================================================
// Задача #74 — фоновый забор PDF-этикеток Ozon. Ozon отдаёт готовую этикетку
// не раньше чем через 45-60 секунд после /v4/posting/fbs/ship (см. комментарии
// в ozon.client.js::fetchPackageLabelPdf и ozon.service.js::fetchLabelsForReadyPostings),
// поэтому это не может быть частью самого запроса на упаковку — отдельная
// джоба, тот же паттерн, что и wbFbsStatusSync.js.
//
// Интервал короче, чем у большинства WB-джоб (30с, а не 10-30мин) — потому
// что здесь опоздание напрямую означает, что упаковщик стоит и ждёт этикетку
// у принтера. checkJobs (панель принтера/agent.js) сама опрашивает сервер
// каждые несколько секунд, так что 30с здесь — это верхняя граница задержки
// "упаковано -> этикетка легла в очередь печати", а не время самой печати.
// =============================================================================

const INTERVAL_MS = Number(process.env.OZON_LABEL_SYNC_INTERVAL_MS || 30_000);

let timer = null;
let running = false;

async function runOnce() {
  if (running) return; // предыдущий тик ещё не закончился — не накладываем запросы друг на друга
  running = true;
  const startedAt = Date.now();
  try {
    const r = await ozonService.fetchLabelsForReadyPostings();
    if (r.checked > 0) {
      logger.info({ ...r, ms: Date.now() - startedAt }, 'Ozon label-sync tick finished');
    }
  } catch (e) {
    logger.error({ err: e }, 'Ozon label-sync: run failed');
  } finally {
    running = false;
  }
}

function start() {
  if (timer) return; // уже запущен
  logger.info({ intervalMs: INTERVAL_MS }, 'Ozon label-sync scheduler started');
  timer = setInterval(runOnce, INTERVAL_MS);
  timer.unref();
  // Стартуем через 20с после подъёма сервера — не толпимся с остальными джобами при старте.
  setTimeout(runOnce, 20_000).unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, runOnce };
