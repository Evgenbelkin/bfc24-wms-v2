'use strict';

const axios = require('axios');
const config = require('../config');
const logger = require('./logger');

// =============================================================================
// Уведомления владельцу платформы в Telegram (например, о новой самостоятельной
// регистрации клиента, о расхождениях в "Сверке остатков"). Best-effort: если
// токен/chat_id не настроены, или Telegram недоступен — просто логируем и идём
// дальше, ничего не ломаем в основном потоке.
//
// ВАЖНО (найдено 29.08.2026 при диагностике "почему не приходит алерт по
// сверке остатков"): прямой доступ к api.telegram.org с этого VPS не работает
// вообще - ETIMEDOUT на уровне TCP-соединения (проверено curl'ом и голым
// axios-запросом, до TLS/ответа дело не доходит). Похоже на блокировку
// исходящего трафика на уровне сети/хостинга - настройками приложения это не
// лечится. Решение то же, что уже работает в OKCIFRA (тот же VPS, тот же
// чат-получатель) - см. telegram.notify.service.js там: слать не напрямую, а
// через Cloudflare Worker-прокси (TELEGRAM_PROXY_URL), который сам достаёт
// api.telegram.org не из России и просто пересылает {token, chat_id, text}.
// Если TELEGRAM_PROXY_URL не задан - остаётся старое поведение (прямой
// запрос) на случай, если блокировку когда-нибудь снимут/сменится хостинг.
// =============================================================================

async function sendTelegramMessage(text) {
  const { botToken, adminChatId, proxyUrl } = config.telegram;
  if (!botToken || !adminChatId) {
    logger.warn('Telegram notify skipped: TELEGRAM_BOT_TOKEN/TELEGRAM_ADMIN_CHAT_ID not configured');
    return false;
  }
  try {
    if (proxyUrl) {
      await axios.post(
        proxyUrl,
        { token: botToken, chat_id: adminChatId, text, parse_mode: 'HTML' },
        { timeout: 10_000 }
      );
    } else {
      await axios.post(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        { chat_id: adminChatId, text, parse_mode: 'HTML', disable_web_page_preview: true },
        { timeout: 10_000 }
      );
    }
    return true;
  } catch (err) {
    logger.error({ err: err.message }, 'Telegram notify failed');
    return false;
  }
}

module.exports = { sendTelegramMessage };
