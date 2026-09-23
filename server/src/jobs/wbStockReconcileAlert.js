'use strict';

const config = require('../config');
const wbService = require('../modules/wb/wb.service');
const { query } = require('../config/database');
const { sendTelegramMessage } = require('../utils/telegram');
const logger = require('../utils/logger');

// =============================================================================
// Автосверка "WB реально отдаёт" vs "должно быть отправлено" по ВСЕМ тенантам
// разом (та же логика, что кнопка "Сверка остатков" в кабинете -
// wbService.reconcileStockForTenant), с алертом владельцу платформы в
// Telegram, если найдены расхождения. Читает данные, ничего не пушит и не
// меняет - чисто оповещение, чтобы реагировать быстрее, чем "зашёл проверить
// и заметил". По умолчанию раз в 4 часа (WB_RECONCILE_ALERT_INTERVAL_MINUTES,
// 0 = выключено).
//
// Одно сообщение на прогон - сводка по всем тенантам сразу, а не по одному
// на тенанта, чтобы не заспамить админ-чат (тот же чат, куда уже шлются
// уведомления о новых регистрациях, см. utils/telegram.js).
// =============================================================================

let timer = null;
let running = false;

const MAX_ROWS_IN_MESSAGE = 20; // не пытаться впихнуть весь список в одно telegram-сообщение

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function buildAndSendAlert(tenantResults) {
  const withMismatches = tenantResults.filter(t => t.total_mismatches > 0);

  // ФИКС 23.09.2026 (жалоба "бот шлёт 92 расхождения по ИП Китай, а на деле
  // просто протух токен - хотелось бы отдельное уведомление про токен, а не
  // тонущую в шуме ошибку синхронизации"): аккаунты, у которых
  // reconcileStockForTenant не смог посчитать mismatches вовсе (все склады
  // упали с 401/malformed-токеном - см. wb.service.js), помечены
  // acc.tokenError=true и mismatches=[] - раньше они просто молча пропадали
  // из алерта (0 расхождений = "всё ок", хотя на деле мы вообще ничего не
  // проверили). Теперь собираем их отдельно и показываем ПЕРВЫМ, заметным
  // блоком - это и есть ответ на "если б сразу было понятно, что проблема в
  // токене, а не в остатках".
  const tokenErrorRows = [];
  for (const t of tenantResults) {
    for (const acc of t.result.accounts) {
      if (acc.tokenError) {
        tokenErrorRows.push({
          tenantName: t.tenantName,
          clientName: acc.client_name,
          accountName: acc.account_name,
          errors: acc.errors || [],
        });
      }
    }
  }

  if (withMismatches.length === 0 && tokenErrorRows.length === 0) return;

  const lines = [];

  if (tokenErrorRows.length > 0) {
    lines.push(`🔑 <b>Проблема с токеном WB — сверка невозможна (${tokenErrorRows.length})</b>`);
    tokenErrorRows.forEach((r) => {
      const detail = r.errors[0] ? escapeHtml(r.errors[0]) : 'токен не принимается WB API';
      lines.push(
        `• ${escapeHtml(r.clientName)}${r.accountName ? ` (${escapeHtml(r.accountName)})` : ''}: ${detail}`
      );
    });
    lines.push('Обнови токен в кабинете: МР Аккаунты → нужный аккаунт. Пока токен битый, расхождения по этому аккаунту не проверяются (ниже их не будет).');
    lines.push('');
  }

  if (withMismatches.length === 0) {
    await sendTelegramMessage(lines.join('\n'));
    return;
  }

  const totalAcrossAll = withMismatches.reduce((s, t) => s + t.total_mismatches, 0);
  lines.push(`⚠️ <b>Сверка остатков WB: найдено расхождений — ${totalAcrossAll}</b>`);
  lines.push('');

  // Собираем плоский список строк "тенант / клиент / товар / diff", отсортированный
  // по модулю расхождения - самое заметное (риск оверселла) наверху.
  const flatRows = [];
  for (const t of withMismatches) {
    for (const acc of t.result.accounts) {
      for (const m of acc.mismatches) {
        flatRows.push({
          tenantName: t.tenantName,
          clientName: acc.client_name,
          name: m.name,
          barcode: m.barcode,
          wb_qty: m.wb_qty,
          expected_qty: m.expected_qty,
          diff: m.diff,
        });
      }
    }
  }
  flatRows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  const shown = flatRows.slice(0, MAX_ROWS_IN_MESSAGE);
  shown.forEach((r, i) => {
    const sign = r.diff > 0 ? '+' : '';
    const risk = r.diff > 0 ? 'риск оверселла' : 'не ушло в WB';
    // ФИКС 13.09.2026: раньше показывали ТОЛЬКО имя (а если товара нет в WMS -
    // плейсхолдер "(нет остатка в WMS)"), штрихкод не попадал в сообщение
    // вообще - по такому алерту нельзя было понять, какой конкретно товар
    // физически проверять на риск оверселла. Теперь штрихкод показываем
    // всегда, имя - только если оно реальное.
    const hasRealName = r.name && r.name !== '(нет остатка в WMS)';
    const label = hasRealName
      ? `${escapeHtml(r.name)} (шк ${escapeHtml(r.barcode)})`
      : `шк ${escapeHtml(r.barcode)} (нет остатка в WMS)`;
    // ФИКС 13.09.2026: убрали название тенанта из строки (сейчас фактически
    // один тенант в использовании, имя только шумело) - вместо него простая
    // нумерация строк, так легче ссылаться на конкретную позицию в чате.
    lines.push(
      `${i + 1}. ${escapeHtml(r.clientName)}: ${label} — ` +
      `WB ${r.wb_qty} / ожидается ${r.expected_qty} (${sign}${r.diff}, ${risk})`
    );
  });
  if (flatRows.length > shown.length) {
    lines.push('');
    lines.push(`…и ещё ${flatRows.length - shown.length} строк. Полный список — в разделе "Сверка остатков" в кабинете.`);
  }

  await sendTelegramMessage(lines.join('\n'));
}

async function runOnce() {
  if (running) {
    logger.warn('WB reconcile-alert: previous run still in progress, skipping this tick');
    return;
  }
  running = true;
  const startedAt = Date.now();
  try {
    let tenantIds = await wbService.listTenantsWithWbIntegration();
    // Ограничение по своим тенантам (WB_RECONCILE_ALERT_TENANT_IDS) - см.
    // комментарий у config.wb.reconcileAlertTenantIds. Пусто = без ограничения.
    const allowedTenantIds = config.wb.reconcileAlertTenantIds;
    if (allowedTenantIds.length > 0) {
      tenantIds = tenantIds.filter(id => allowedTenantIds.includes(id));
    }
    if (tenantIds.length === 0) return;

    const namesRes = await query(
      `SELECT id, company_name FROM platform.tenants WHERE id = ANY($1::int[])`,
      [tenantIds]
    );
    const nameById = new Map(namesRes.rows.map(r => [r.id, r.company_name || `Тенант #${r.id}`]));

    const tenantResults = [];
    for (const tenantId of tenantIds) {
      try {
        const result = await wbService.reconcileStockForTenant(tenantId);
        tenantResults.push({
          tenantId,
          tenantName: nameById.get(tenantId) || `Тенант #${tenantId}`,
          total_mismatches: result.total_mismatches,
          result,
        });
      } catch (e) {
        logger.error({ err: e, tenantId }, 'WB reconcile-alert: reconcile failed for tenant');
      }
    }

    await buildAndSendAlert(tenantResults);

    const totalMismatches = tenantResults.reduce((s, t) => s + t.total_mismatches, 0);
    logger.info(
      { tenants: tenantIds.length, totalMismatches, ms: Date.now() - startedAt },
      'WB reconcile-alert run finished'
    );
  } catch (e) {
    logger.error({ err: e }, 'WB reconcile-alert: run failed');
  } finally {
    running = false;
  }
}

function start() {
  const minutes = config.wb.reconcileAlertIntervalMinutes;
  if (!minutes || minutes <= 0) {
    logger.info('WB reconcile-alert disabled (WB_RECONCILE_ALERT_INTERVAL_MINUTES=0)');
    return;
  }
  if (timer) return; // уже запущен
  logger.info({ minutes }, 'WB reconcile-alert scheduler started');
  timer = setInterval(runOnce, minutes * 60_000);
  timer.unref();
  // Стартуем через 3 минуты после подъёма - даём wbAutoSync/wbStockSync отработать
  // первый раз, чтобы не сверяться сразу после холодного старта на пустых данных.
  setTimeout(runOnce, 3 * 60_000).unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, runOnce };
