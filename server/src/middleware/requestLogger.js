'use strict';

const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

// =============================================================================
// Request logger middleware
// Логирует входящие запросы и время ответа
// =============================================================================

function requestLogger(req, res, next) {
  // Уникальный ID запроса для трассировки
  req.id = req.headers['x-request-id'] || uuidv4();
  res.setHeader('X-Request-Id', req.id);

  const startAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startAt) / 1_000_000;

    const level =
      res.statusCode >= 500 ? 'error' :
      res.statusCode >= 400 ? 'warn' :
      durationMs > 1000 ? 'warn' :
      'info';

    logger[level]({
      reqId:      req.id,
      method:     req.method,
      url:        req.originalUrl,
      status:     res.statusCode,
      durationMs: Math.round(durationMs),
      tenantId:   req.user?.tenantId,
      userId:     req.user?.id,
      role:       req.user?.role,
      ip:         req.ip,
    }, `${req.method} ${req.originalUrl} ${res.statusCode} ${Math.round(durationMs)}ms`);
  });

  next();
}

module.exports = requestLogger;
