'use strict';

require('dotenv').config();

const app = require('./src/app');
const config = require('./src/config');
const { testConnection, pool } = require('./src/config/database');
const logger = require('./src/utils/logger');
const wbAutoSync = require('./src/jobs/wbAutoSync');
const wbStockSync = require('./src/jobs/wbStockSync');
const storageBilling = require('./src/jobs/storageBilling');

// =============================================================================
// Server entry point с graceful shutdown
// =============================================================================

let server;

async function start() {
  // Проверяем подключение к БД перед стартом
  try {
    const dbInfo = await testConnection();
    logger.info({ db: dbInfo.db, time: dbInfo.now }, 'Database connection OK');
  } catch (err) {
    logger.fatal({ err }, 'Failed to connect to database. Exiting.');
    process.exit(1);
  }

  server = app.listen(config.server.port, '0.0.0.0', () => {
    logger.info(
      {
        port:   config.server.port,
        env:    config.env,
        prefix: config.server.apiPrefix,
      },
      `BFC24 WMS v2 started on port ${config.server.port}`
    );
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.fatal({ port: config.server.port }, 'Port already in use');
    } else {
      logger.fatal({ err }, 'Server error');
    }
    process.exit(1);
  });

  wbAutoSync.start();
  wbStockSync.start();
  storageBilling.start();
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
async function shutdown(signal) {
  logger.info(`Received ${signal}, starting graceful shutdown...`);
  wbAutoSync.stop();
  wbStockSync.stop();
  storageBilling.stop();

  if (server) {
    server.close(async () => {
      logger.info('HTTP server closed');
      try {
        await pool.end();
        logger.info('Database pool closed');
      } catch (err) {
        logger.error({ err }, 'Error closing database pool');
      }
      process.exit(0);
    });

    // Принудительное завершение через 10 секунд
    setTimeout(() => {
      logger.warn('Forced shutdown after timeout');
      process.exit(1);
    }, 10_000).unref();
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// Необработанные исключения
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'Unhandled promise rejection');
  process.exit(1);
});

start();
