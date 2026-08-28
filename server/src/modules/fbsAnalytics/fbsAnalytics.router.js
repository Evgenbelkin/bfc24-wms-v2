'use strict';

const express = require('express');
const router = express.Router();
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware, requireModule, resolveClientScope } = require('../../middleware/tenant');
const { ValidationError } = require('../../utils/errors');
const fbsAnalyticsService = require('./fbsAnalytics.service');

// =============================================================================
// Модуль "Аналитика FBS" — по образцу конкурентов (сводка/графики/сводная
// таблица по FBS-заказам). Доступ открыт ВСЕМ ролям склада (не только
// tenant_admin/supervisor, как большинство отчётов) - это осознанное решение
// (просили дать доступ всем), поэтому здесь НЕТ requireRole(...). Требует
// только включённый модуль wb_integration (данные всё равно оттуда).
// =============================================================================

router.use(authRequired, tenantMiddleware, requireModule('wb_integration'));

function parseDateRange(query) {
  const to = query.to ? new Date(`${query.to}T23:59:59.999Z`) : new Date();
  const from = query.from ? new Date(`${query.from}T00:00:00.000Z`) : new Date(to.getTime() - 6 * 86400000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new ValidationError('Некорректный диапазон дат (from/to)');
  }
  return { dateFrom: from, dateTo: to };
}

/** GET /fbs-analytics/summary — сводка по статусам заказов за период +
 *  сравнение с предыдущим периодом такой же длины. */
router.get('/summary', async (req, res, next) => {
  try {
    const { dateFrom, dateTo } = parseDateRange(req.query);
    const clientId = resolveClientScope(req, req.query.client_id);
    const mpAccountId = req.query.mp_account_id ? Number(req.query.mp_account_id) : null;

    const result = await fbsAnalyticsService.getFbsSummary({
      tenantId: req.user.tenantId, clientId, mpAccountId, dateFrom, dateTo,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

/** GET /fbs-analytics/speed — сроки обработки (0-13/13-42/42-48/48-54/54-60/60+ч)
 *  и доля "доставлено вовремя" (<=48ч от создания до передачи в WB) - от этого
 *  напрямую зависит скидка/наценка на комиссию WB. */
router.get('/speed', async (req, res, next) => {
  try {
    const { dateFrom, dateTo } = parseDateRange(req.query);
    const clientId = resolveClientScope(req, req.query.client_id);
    const mpAccountId = req.query.mp_account_id ? Number(req.query.mp_account_id) : null;

    const result = await fbsAnalyticsService.getProcessingSpeed({
      tenantId: req.user.tenantId, clientId, mpAccountId, dateFrom, dateTo,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

/** GET /fbs-analytics/speed-by-client — сроки обработки в разрезе по клиентам
 *  (только для персонала - видно, кто из клиентов регулярно затягивает сборку). */
router.get('/speed-by-client', async (req, res, next) => {
  try {
    const { dateFrom, dateTo } = parseDateRange(req.query);
    const result = await fbsAnalyticsService.getProcessingSpeedByClient({
      tenantId: req.user.tenantId, dateFrom, dateTo,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

/** POST /fbs-analytics/refresh-now — ручной принудительный опрос wbStatus
 *  (обычно обновляется фоновой джобой раз в 30 минут). */
router.post('/refresh-now', async (req, res, next) => {
  try {
    const result = await fbsAnalyticsService.refreshWbStatusesForTenant(req.user.tenantId);
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

module.exports = router;
