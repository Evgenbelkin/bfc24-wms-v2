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

/** GET /fbs-analytics/speed-by-supply — сроки обработки в разрезе по
 *  ОТДЕЛЬНЫМ поставкам (не по клиенту целиком) - для ручной сверки с личным
 *  кабинетом WB на конкретной поставке. */
router.get('/speed-by-supply', async (req, res, next) => {
  try {
    const { dateFrom, dateTo } = parseDateRange(req.query);
    const clientId = resolveClientScope(req, req.query.client_id);
    const result = await fbsAnalyticsService.getProcessingSpeedBySupply({
      tenantId: req.user.tenantId, clientId, dateFrom, dateTo,
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
    const warehouseId = req.query.warehouse_id ? Number(req.query.warehouse_id) : null;
    const wbScName = req.query.wb_sc_name || null;
    const regionName = req.query.region_name || null;
    const oblastOkrugName = req.query.oblast_okrug_name || null;
    const result = await fbsAnalyticsService.getRegionDeliveryTime({
      tenantId: req.user.tenantId, clientId, warehouseId, wbScName, regionName, oblastOkrugName, dateFrom, dateTo,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

/** GET /fbs-analytics/unsorted-report — поставки, где есть ещё не
 *  отсортированные WB (или ещё физически не принятые WB) заказы, по всем
 *  WB-аккаунтам тенанта. Staff-only — это рабочий инструмент диспетчера, а не
 *  витрина для клиента. */
router.get('/unsorted-report', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const result = await fbsAnalyticsService.getUnsortedSuppliesReport({ tenantId: req.user.tenantId });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

/** GET /fbs-analytics/unsorted-report/orders?mp_account_id=&supply_code= —
 *  детали конкретной поставки: какие именно заказы ещё не отсортированы. */
router.get('/unsorted-report/orders', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const mpAccountId = Number(req.query.mp_account_id);
    const supplyCode = req.query.supply_code;
    if (!mpAccountId || !supplyCode) throw new ValidationError('mp_account_id and supply_code are required');
    const result = await fbsAnalyticsService.getUnsortedSupplyOrders({ tenantId: req.user.tenantId, mpAccountId, supplyCode });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

/** GET /fbs-analytics/items-report?from=&to=&client_id= — "супер-отчёт"
 *  клиенту: остаток + продажи за период + оборачиваемость по КАЖДОМУ товару
 *  (владелец, 18.09.2026: "клиент попросил красивый отчёт - сколько продано,
 *  какие товары, остаток, оборачиваемость"). Доступен и селлеру (свой
 *  clientId через resolveClientScope), и персоналу (явный client_id) - как и
 *  /summary выше, поэтому без requireRole. */
router.get('/items-report', async (req, res, next) => {
  try {
    const { dateFrom, dateTo } = parseDateRange(req.query);
    const clientId = resolveClientScope(req, req.query.client_id);
    if (!clientId) throw new ValidationError('client_id is required');
    const result = await fbsAnalyticsService.getClientItemsReport({
      tenantId: req.user.tenantId, clientId, dateFrom, dateTo,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

/** GET /fbs-analytics/warehouse-performance?from=&to= — отчёт "Эффективность
 *  складов WB": по каждому клиенту тенанта - заказы в разрезе складов WB
 *  (шт и %), плюс общий рейтинг складов по всем клиентам сразу (владелец,
 *  19.09.2026: "хочу видеть какие склады дают больше заказов и их
 *  рекомендовать другим клиентам"). Staff-only И требует опциональный модуль
 *  warehouse_insights (см. миграцию 067) - владелец явно попросил не
 *  засорять меню фичами, которые не всем тенантам нужны. */
router.get('/warehouse-performance', requireModule('warehouse_insights'), requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const { dateFrom, dateTo } = parseDateRange(req.query);
    const result = await fbsAnalyticsService.getWarehousePerformanceReport({
      tenantId: req.user.tenantId, dateFrom, dateTo,
    });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

/** POST /fbs-analytics/unsorted-report/stickers-export { order_row_ids }  —
 *  печать стикеров WB выбранных "зависших" заказов одной HTML-страницей
 *  (id — это wms.wb_orders.id, не wb_order_id самого WB). */
router.post('/unsorted-report/stickers-export', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const orderRowIds = Array.isArray(req.body.order_row_ids) ? req.body.order_row_ids.map(Number).filter(Boolean) : [];
    if (!orderRowIds.length) throw new ValidationError('order_row_ids is required and must be a non-empty array');
    const result = await fbsAnalyticsService.exportUnsortedStickers({ tenantId: req.user.tenantId, orderRowIds });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

/** POST /fbs-analytics/unsorted-report/xlsx-export { order_row_ids } —
 *  выгрузка выбранных "зависших" заказов в Excel: баркод/товар/стикер/киз
 *  (владелец, 21.09.2026). Файл — base64 в JSON, как и другие xlsx-экспорты
 *  в проекте (см. shipping.router.js::collected-export). */
router.post('/unsorted-report/xlsx-export', requireRole('tenant_admin', 'supervisor'), async (req, res, next) => {
  try {
    const orderRowIds = Array.isArray(req.body.order_row_ids) ? req.body.order_row_ids.map(Number).filter(Boolean) : [];
    if (!orderRowIds.length) throw new ValidationError('order_row_ids is required and must be a non-empty array');
    const { buffer, count } = await fbsAnalyticsService.exportUnsortedOrdersXlsx({ tenantId: req.user.tenantId, orderRowIds });
    res.json({
      ok: true,
      count,
      filename: `ne-otsortirovano-${new Date().toISOString().slice(0, 10)}.xlsx`,
      xlsxBase64: buffer.toString('base64'),
    });
  } catch (e) { next(e); }
});

module.exports = router;
