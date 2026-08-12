'use strict';

require('dotenv').config();

// =============================================================================
// Централизованный конфиг. Все переменные окружения читаются ТОЛЬКО здесь.
// Весь остальной код импортирует config, а не process.env напрямую.
// =============================================================================

function requireEnv(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Required environment variable ${key} is not set. Check .env file.`);
  }
  return value;
}

function optionalEnv(key, defaultValue = '') {
  return process.env[key] || defaultValue;
}

function intEnv(key, defaultValue) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return defaultValue;
  const n = parseInt(raw, 10);
  if (isNaN(n)) throw new Error(`Environment variable ${key} must be an integer, got: ${raw}`);
  return n;
}

function boolEnv(key, defaultValue = false) {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return defaultValue;
  return raw.toLowerCase() === 'true' || raw === '1';
}

const config = {
  env: optionalEnv('NODE_ENV', 'development'),
  isDev: optionalEnv('NODE_ENV', 'development') === 'development',
  isProd: optionalEnv('NODE_ENV', 'development') === 'production',

  server: {
    port: intEnv('PORT', 3001),
    apiPrefix: optionalEnv('API_PREFIX', '/api/v2'),
  },

  db: {
    host:     optionalEnv('DB_HOST', 'localhost'),
    port:     intEnv('DB_PORT', 5432),
    name:     optionalEnv('DB_NAME', 'bfc24_v2'),
    user:     optionalEnv('DB_USER', 'postgres'),
    password: optionalEnv('DB_PASSWORD', ''),
    pool: {
      min:    intEnv('DB_POOL_MIN', 2),
      max:    intEnv('DB_POOL_MAX', 20),
      idleMs: intEnv('DB_POOL_IDLE_MS', 10000),
    },
  },

  jwt: {
    secret:          requireEnv('JWT_SECRET'),
    expiresIn:       optionalEnv('JWT_EXPIRES_IN', '2h'),
    refreshSecret:   requireEnv('JWT_REFRESH_SECRET'),
    refreshExpiresIn: optionalEnv('JWT_REFRESH_EXPIRES_IN', '30d'),
  },

  platformJwt: {
    secret:    requireEnv('PLATFORM_JWT_SECRET'),
    expiresIn: optionalEnv('PLATFORM_JWT_EXPIRES_IN', '8h'),
  },

  cors: {
    origins: optionalEnv('CORS_ORIGINS', 'http://localhost:3001')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  },

  rateLimit: {
    windowMs: intEnv('RATE_LIMIT_WINDOW_MS', 60_000),
    max:      intEnv('RATE_LIMIT_MAX', 100),
    loginMax: intEnv('LOGIN_RATE_LIMIT_MAX', 10),
    registerMax: intEnv('REGISTER_RATE_LIMIT_MAX', 5),
  },

  // Уведомление владельцу платформы в Telegram о новых самостоятельных
  // регистрациях клиентов (см. platform.router.js POST /register). Если не
  // задано — регистрация всё равно работает, просто без уведомления.
  telegram: {
    botToken:    optionalEnv('TELEGRAM_BOT_TOKEN', ''),
    adminChatId: optionalEnv('TELEGRAM_ADMIN_CHAT_ID', ''),
  },

  logging: {
    level:  optionalEnv('LOG_LEVEL', 'info'),
    pretty: boolEnv('LOG_PRETTY', true),
  },

  wb: {
    // Автосинхронизация заказов WB в фоне (0 = выключено)
    autoSyncIntervalMinutes: intEnv('WB_AUTO_SYNC_INTERVAL_MINUTES', 15),
    // Периодический пересчёт и отправка остатков FBS в WB (0 = выключено).
    // См. server/src/jobs/wbStockSync.js - раньше пересчёт запускался только
    // по приёмке/инвентаризации, на реальных объёмах этого оказалось мало
    // (инцидент 12.08.2026, см. комментарий в wb.service.js).
    stockSyncIntervalMinutes: intEnv('WB_STOCK_SYNC_INTERVAL_MINUTES', 15),
  },

  urls: {
    public: optionalEnv('PUBLIC_SITE_URL', 'https://bfc24.ru'),
    app:    optionalEnv('APP_URL', 'https://app.bfc24.ru'),
  },
};

module.exports = config;
