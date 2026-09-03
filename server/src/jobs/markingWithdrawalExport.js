'use strict';

const config = require('../config');
const markingService = require('../modules/marking/marking.service');
const { sendTelegramMessage } = require('../utils/telegram');
const logger = require('../utils/logger');

// =============================================================================
// Ночной крон "Вывод из оборота" — формирует выгрузку выкупленных КИЗ для
// каждого тенанта с модулем 'marking', тем же путём, что и ручная кнопка
// (marking.service.js::createWithdrawalExport, source='cron'). Требование
// пользователя (04.09.2026): отчёт должен быть готов к 9 утра, а если
// первая попытка не удалась — джоба должна сама пробовать исправить
// ситуацию и догрузить, а не просто один раз выстрелить и забыть.
//
// Реализация — не classic cron-выражение, а простой тик раз в TICK_MINUTES:
// как только текущий час (сервер работает с TZ=Europe/Moscow, см.
// config/database.js — поэтому это уже московское время без пересчёта)
// >= withdrawalExportHour, пробуем сформировать выгрузку по тенантам,
// которые ещё не выполнены сегодня. Неудачные тенанты остаются "не done" и
// попадают в следующую попытку через withdrawalExportRetryMinutes — это и
// есть самолечение. После withdrawalExportDeadlineHour, если кто-то так и
// не выгрузился, шлём один Telegram-алерт владельцу платформы (та же
// труба, что wbStockReconcileAlert.js), но попытки продолжаются и дальше —
// "лучше поздно, чем никогда".
//
// "Успех" тенанта = вызов createWithdrawalExport не бросил исключение,
// НЕЗАВИСИМО от того, сколько строк реально попало в выгрузку (0 строк —
// тоже валидный результат, если за сутки нечего выводить). Повторных
// прогонов для уже успешного сегодня тенанта нет — новые продажи в течение
// того же дня подхватит либо завтрашний крон, либо ручная кнопка в
// интерфейсе (см. обсуждение с пользователем — ночной крон только на "к
// 9 утра", остальное покрывает ручной экспорт).
// =============================================================================

let timer = null;
let running = false;

const TICK_MINUTES = 5;

let state = {
  day: null, // 'YYYY-MM-DD' (московская дата) — для сброса состояния на новый день
  doneTenantIds: new Set(),
  lastAttemptAt: 0, // Date.now() последней попытки — для каданса повторов
  deadlineAlertSent: false,
};

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function resetStateIfNewDay() {
  const t = todayStr();
  if (state.day !== t) {
    state.day = t;
    state.doneTenantIds = new Set();
    state.lastAttemptAt = 0;
    state.deadlineAlertSent = false;
  }
}

async function attemptTenant(tenantId) {
  try {
    const result = await markingService.createWithdrawalExport({ tenantId, source: 'cron' });
    state.doneTenantIds.add(tenantId);
    logger.info(
      { tenantId, rowCount: result.export ? result.export.row_count : 0 },
      'Marking withdrawal cron: tenant export ok'
    );
    return true;
  } catch (e) {
    logger.error({ err: e, tenantId }, 'Marking withdrawal cron: tenant export failed, will retry');
    return false;
  }
}

async function runOnce() {
  if (running) {
    logger.warn('Marking withdrawal cron: previous run still in progress, skipping this tick');
    return;
  }
  running = true;
  try {
    resetStateIfNewDay();
    const now = new Date();
    const hour = now.getHours();
    if (hour < config.marking.withdrawalExportHour) return; // ещё не время первой попытки за сутки

    const sinceLastMs = Date.now() - state.lastAttemptAt;
    const dueForRetry = state.lastAttemptAt === 0 || sinceLastMs >= config.marking.withdrawalExportRetryMinutes * 60_000;

    const tenantIds = await markingService.listTenantsWithMarkingModule();
    let pending = tenantIds.filter((id) => !state.doneTenantIds.has(id));

    if (pending.length > 0 && dueForRetry) {
      state.lastAttemptAt = Date.now();
      let ok = 0, failed = 0;
      for (const tenantId of pending) {
        const success = await attemptTenant(tenantId);
        if (success) ok++; else failed++;
      }
      pending = tenantIds.filter((id) => !state.doneTenantIds.has(id));
      logger.info(
        { total: tenantIds.length, attempted: ok + failed, ok, failed, stillPending: pending.length },
        'Marking withdrawal cron: tick finished'
      );
    }

    // Эскалация — один раз в сутки, если после дедлайна кто-то так и не выгрузился.
    if (hour >= config.marking.withdrawalExportDeadlineHour && pending.length > 0 && !state.deadlineAlertSent) {
      state.deadlineAlertSent = true;
      try {
        await sendTelegramMessage(
          `⚠️ <b>Вывод из оборота КИЗ: не готово к ${config.marking.withdrawalExportDeadlineHour}:00</b>\n` +
          `Тенантов с ошибкой: ${pending.length} из ${tenantIds.length}. Джоба продолжит попытки автоматически (каждые ${config.marking.withdrawalExportRetryMinutes} мин), но стоит проверить логи.`
        );
      } catch (err) {
        logger.error({ err }, 'Marking withdrawal cron: failed to send deadline alert');
      }
    }
  } catch (e) {
    logger.error({ err: e }, 'Marking withdrawal cron: run failed');
  } finally {
    running = false;
  }
}

function start() {
  if (!config.marking.withdrawalExportEnabled) {
    logger.info('Marking withdrawal cron disabled (MARKING_WITHDRAWAL_EXPORT_ENABLED=false)');
    return;
  }
  if (timer) return; // уже запущен
  logger.info(
    {
      hour: config.marking.withdrawalExportHour,
      deadlineHour: config.marking.withdrawalExportDeadlineHour,
      retryMinutes: config.marking.withdrawalExportRetryMinutes,
    },
    'Marking withdrawal cron scheduler started'
  );
  timer = setInterval(runOnce, TICK_MINUTES * 60_000);
  timer.unref();
  // Первый тик — вскоре после старта; дальше раз в TICK_MINUTES runOnce сам
  // решает, время ли действовать (сравнивает текущий час с целевым).
  setTimeout(runOnce, 60_000).unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, runOnce };
