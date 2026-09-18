'use strict';

const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');

// =============================================================================
// Централизованный обработчик ошибок Express
// Должен быть последним app.use() в app.js
// =============================================================================

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Добавляем контекст к логу
  const logCtx = {
    err,
    method:  req.method,
    url:     req.originalUrl,
    tenantId: req.tenant?.id,
    userId:   req.user?.id,
    reqId:    req.id,
  };

  if (err instanceof AppError && err.isOperational) {
    // Операциональная ошибка — ожидаемая, логируем как warn
    logger.warn(logCtx, err.message);

    return res.status(err.statusCode).json({
      ok: false,
      error: {
        code:    err.code,
        message: err.message,
        details: err.details ?? undefined,
      },
    });
  }

  // Неожиданная ошибка — логируем как error
  logger.error(logCtx, 'Unexpected server error');

  // В production не раскрываем внутренние детали
  const isDev = process.env.NODE_ENV !== 'production';

  return res.status(500).json({
    ok: false,
    error: {
      code:    'INTERNAL_ERROR',
      message: isDev ? err.message : 'An unexpected error occurred',
      stack:   isDev ? err.stack : undefined,
    },
  });
}

/**
 * 404 handler — добавить перед errorHandler
 */
function notFoundHandler(req, res) {
  res.status(404).json({
    ok: false,
    error: {
      code:    'NOT_FOUND',
      message: `Route ${req.method} ${req.originalUrl} not found`,
    },
  });
}

module.exports = { errorHandler, notFoundHandler };
