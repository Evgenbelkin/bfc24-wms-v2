'use strict';

const pino = require('pino');
const config = require('../config');

// =============================================================================
// Централизованный логгер (pino)
// =============================================================================

const logger = pino({
  level: config.logging.level,
  ...(config.logging.pretty && config.isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  base: {
    env: config.env,
  },
});

module.exports = logger;
