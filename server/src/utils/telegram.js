'use strict';

const axios = require('axios');
const config = require('../config');
const logger = require('./logger');

// =============================================================================
// Уведомления владельцу платформы в Telegram (например, о новой самостоятельной
// регистрации клиента). Best-effort: если токен/chat_id не настроены, или
// Telegram недоступен — просто логируем и идём дальше, ничего не ломаем
// в основном потоке (регистрация не должна падать из-за упавшего уведомления).
// =============================================================================

async function sendTelegramMessage(text) {
  const { botToken, adminChatId } = config.telegram;
  if (!botToken || !adminChatId) {
    logger.warn('Telegram notify skipped: TELEGRAM_BOT_TOKEN/TELEGRAM_ADMIN_CHAT_ID not configured');
    return false;
  }
  try {
    await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      { chat_id: adminChatId, text, parse_mode: 'HTML', disable_web_page_preview: true },
      { timeout: 10_000 }
    );
    return true;
  } catch (err) {
    logger.error({ err: err.message }, 'Telegram notify failed');
    return false;
  }
}

module.exports = { sendTelegramMessage };
