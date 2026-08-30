'use strict';

const express = require('express');
const router = express.Router();
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware, requireModule, resolveClientScope } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
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

/** GET /fbs-analytics/region-delivery/filters — списки значений для
 *  выпадающих фильтров (склад/регион/федеральный округ), встречающихся в
 *  заказах тенанта - без привязки к периоду. */
router.get('/region-delivery/filters', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const options = await fbsAnalyticsService.listRegionDeliveryFilterOptions(req.user.tenantId);
    res.json({ ok: true, ...options });
  } catch (e) { next(e); }
});

/** GET /fbs-analytics/region-delivery — время доставки склад (СЦ WB) -> регион
 *  покупателя, с фильтрами по клиенту/складу/региону/округу. Только для
 *  персонала (staff-only на данный момент - доступ селлерам планируется
 *  отдельно, пока не открываем). Без client_id - разрез сразу по всем
 *  клиентам тенанта (колонка "Клиент" в каждой строке). */
router.get('/region-delivery', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const { dateFrom, dateTo } = parseDateRange(req.query);
    const clientId = resolveClientScope(req, req.query.client_id);
    const wbScName = req.query.wb_sc_name || null;
    const regionName = req.query.region_name || null;
    const oblastOkrugName = req.query.oblast_okrug_name || null;
    const result = await fbsAnalyticsService.getRegionDeliveryTime({
      tenantId: req.user.tenantId, clientId, wbScName, regionName, oblastOkrugName, dateFrom, dateTo,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

module.exports = router;
