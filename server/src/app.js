'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const config = require('./config');
const requestLogger = require('./middleware/requestLogger');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const logger = require('./utils/logger');

// Routers
const authRouter = require('./modules/auth/auth.router');
const usersRouter = require('./modules/users/users.router');
const clientsRouter = require('./modules/clients/clients.router');
const warehousesRouter = require('./modules/warehouses/warehouses.router');
const itemsRouter = require('./modules/masterdata/items/items.router');
const locationsRouter = require('./modules/masterdata/locations/locations.router');
const stockRouter = require('./modules/stock/stock.router');
const inboundRouter = require('./modules/inbound/inbound.router');
const receivingRouter = require('./modules/receiving/receiving.router');
const placementRouter = require('./modules/placement/placement.router');
const movementRouter = require('./modules/movement/movement.router');
const inventoryRouter = require('./modules/inventory/inventory.router');
const pickingRouter = require('./modules/picking/picking.router');
const packingRouter = require('./modules/packing/packing.router');
const shippingRouter = require('./modules/shipping/shipping.router');
const printingRouter = require('./modules/printing/printing.router');
const printingAgentRouter = require('./modules/printing/printingAgent.router');
const workstationsRouter = require('./modules/printing/workstations.router');
const checkinRouter = require('./modules/checkin/checkin.router');
const consumablesRouter = require('./modules/consumables/consumables.router');
const payrollRouter = require('./modules/payroll/payroll.router');
const markingRouter = require('./modules/marking/marking.router');
const returnsRouter = require('./modules/returns/returns.router');
const wbRouter = require('./modules/wb/wb.router');
const fbsAnalyticsRouter = require('./modules/fbsAnalytics/fbsAnalytics.router');
const sellerRouter = require('./modules/seller/seller.router');
const analyticsRouter = require('./modules/analytics/analytics.router');
const billingRouter = require('./modules/billing/billing.router');
const auditRouter = require('./modules/audit/audit.router');
const platformRouter = require('./modules/platform/platform.router');
const overviewRouter = require('./modules/overview/overview.router');
const tenantRouter = require('./modules/tenant/tenant.router');
const actsRouter = require('./modules/acts/acts.router');

// =============================================================================
// Express App
// =============================================================================

const app = express();

// ---------------------------------------------------------------------------
// Trust proxy
// ---------------------------------------------------------------------------
// Приложение всегда стоит за nginx на том же хосте (127.0.0.1 -> :3001/:3002/...).
// Без этого express-rate-limit не может доверять X-Forwarded-For и либо кидает
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR на каждый запрос, либо считает всех клиентов
// одним IP. 'loopback' доверяет заголовку ТОЛЬКО когда соединение пришло с
// 127.0.0.1/::1 (т.е. от самого nginx) — снаружи подделать X-Forwarded-For нельзя,
// т.к. прямого доступа к порту приложения из интернета нет (только через nginx).
app.set('trust proxy', 'loopback');

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------
// NB: все страницы в public/app/*.html — однофайловые, со встроенными <script>/<style>
// И с onclick="..."/style="..." атрибутами прямо в разметке (без сборщика/бандлера).
// Дефолтный CSP хелмета блокирует это в трёх РАЗНЫХ директивах:
//   script-src / style-src       — инлайновые <script> и <style> блоки
//   script-src-attr / style-src-attr — онклики и style="" атрибуты (отдельная директива!)
// Мы уже словили баг с первыми двумя (форма логина не реагировала на клик), а затем
// с *-attr (ни один onclick вообще не срабатывал, включая +/- и кнопку камеры) —
// helmet подставляет свои дефолты для необъявленных ключей, даже если explicitly
// передан объект directives. Поэтому здесь useDefaults:false и полный явный список,
// чтобы больше никакой скрытый дефолт не прилетел незаметно.
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: config.isProd ? {
    useDefaults: false,
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'"],
      scriptSrcAttr:  ["'unsafe-inline'"],
      styleSrc:       ["'self'", "'unsafe-inline'"],
      styleSrcAttr:   ["'unsafe-inline'"],
      imgSrc:         ["'self'", 'data:', 'https:'],
      connectSrc:     ["'self'"],
      mediaSrc:       ["'self'", 'blob:'],
      objectSrc:      ["'none'"],
      baseUri:        ["'self'"],
      formAction:     ["'self'"],
      frameAncestors: ["'self'"],
    },
  } : false,
}));

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
app.use(cors({
  origin: (origin, callback) => {
    // Разрешаем запросы без origin (мобильные клиенты, curl)
    if (!origin) return callback(null, true);
    if (config.cors.origins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin '${origin}' not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
}));

// ---------------------------------------------------------------------------
// Body parsers
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ---------------------------------------------------------------------------
// Request logging
// ---------------------------------------------------------------------------
app.use(requestLogger);

// ---------------------------------------------------------------------------
// Rate limiting — глобальный
// ---------------------------------------------------------------------------
const globalLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max:      config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { ok: false, error: { code: 'RATE_LIMIT', message: 'Too many requests' } },
  // В dev не ограничиваем localhost; /printer-agent живёт на отдельном, более
  // щедром лимите ниже — см. комментарий там про причину.
  skip: (req) => (config.isDev && req.ip === '::1') || req.path.startsWith('/printer-agent'),
});

app.use(config.server.apiPrefix, globalLimiter);

// На части ТСД со старым Android WebView (например Атол Smart.Lite) сетевой
// стек агрессивно кэширует GET-ответы по URL даже без explicit-заголовков —
// из-за этого экраны могли показывать давно устаревшие данные (например,
// список отгрузок "Готовы" продолжал показывать уже отгруженные заказы).
// Явно запрещаем кэширование всех ответов API, чтобы такого не повторялось.
app.use(config.server.apiPrefix, (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

// Агент печати опрашивает сервер раз в ~1.5 сек НА КАЖДЫЙ принтер (обычный,
// ожидаемый трафик, не злоупотребление) — с обычным общим лимитом (100/мин
// на IP) одного принтера почти хватает впритык, а с двумя-тремя принтерами
// за одним офисным/складским IP (обычная ситуация) лимит выбивало мгновенно,
// съедая заодно и весь бюджет на обычную работу в браузере с того же IP.
// Аутентификация тут уже отдельная (постоянный ключ принтера), так что можно
// позволить более щедрый предел, не открывая дыру для злоупотреблений.
const agentLimiter = rateLimit({
  windowMs: 60_000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: { code: 'RATE_LIMIT', message: 'Too many requests' } },
});
app.use(`${config.server.apiPrefix}/printer-agent`, agentLimiter);

// ---------------------------------------------------------------------------
// Static files (фронтенд)
//
// По умолчанию express.static не шлёт Cache-Control вовсе (только
// Last-Modified/ETag), и на обычных браузерах conditional-запросы это
// худо-бедно закрывают. Но на старом Android WebView (Атол Smart.Lite и
// подобные ТСД) кэш статики отрабатывает криво — устройство годами отдаёт
// СТАРУЮ версию html/js даже после git pull + pm2 restart на сервере (после
// каждого деплоя владелец продолжал видеть баги, пофикшенные несколько
// раундов назад, включая уже другой раз пофикшенный "Shipment 'undefined'
// not found" — верный признак, что дело не в самом коде, а в кэше на
// устройстве). Явно запрещаем кэширование самих файлов приложения, как и
// сделали для API-ответов выше — не полагаемся на heuristic-кэширование.
app.use(express.static(path.join(__dirname, '../../public'), {
  setHeaders: (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  },
}));

// ---------------------------------------------------------------------------
// Health check (без auth)
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    version: '2.0.0',
    env: config.env,
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// API Routes
// ---------------------------------------------------------------------------
const api = config.server.apiPrefix;

// Platform (SaaS owner-admin) — отдельный auth
app.use(`${api}/platform`, platformRouter);

// Public auth endpoints
app.use(`${api}/auth`, authRouter);

// Site leads (публичная форма)
// app.use(`${api}/site`, siteRouter); // добавить при необходимости

// Все остальные роуты требуют аутентификации (настраивается внутри каждого роутера)
app.use(`${api}/users`,      usersRouter);
app.use(`${api}/clients`,    clientsRouter);
app.use(`${api}/warehouses`, warehousesRouter);
app.use(`${api}/items`,      itemsRouter);
app.use(`${api}/locations`,  locationsRouter);
app.use(`${api}/stock`,      stockRouter);
app.use(`${api}/inbound`,    inboundRouter);
app.use(`${api}/receiving`,  receivingRouter);
app.use(`${api}/placement`,  placementRouter);
app.use(`${api}/movement`,   movementRouter);
app.use(`${api}/inventory`,  inventoryRouter);
app.use(`${api}/picking`,    pickingRouter);
app.use(`${api}/packing`,    packingRouter);
app.use(`${api}/shipping`,   shippingRouter);
app.use(`${api}/printing`,   printingRouter);
// Отдельная аутентификация ключом принтера (не JWT сотрудника) — см. printingAgent.router.js
app.use(`${api}/printer-agent`, printingAgentRouter);
app.use(`${api}/workstations`, workstationsRouter);
app.use(`${api}/checkin`,   checkinRouter);
app.use(`${api}/consumables`, consumablesRouter);
app.use(`${api}/payroll`,   payrollRouter);
app.use(`${api}/marking`,   markingRouter);
app.use(`${api}/returns`,   returnsRouter);
app.use(`${api}/wb`,         wbRouter);
app.use(`${api}/fbs-analytics`, fbsAnalyticsRouter);
app.use(`${api}/seller`,     sellerRouter);
app.use(`${api}/analytics`,  analyticsRouter);
app.use(`${api}/billing`,    billingRouter);
app.use(`${api}/audit`,      auditRouter);
app.use(`${api}/overview`,   overviewRouter);
app.use(`${api}/tenant`,     tenantRouter);
app.use(`${api}/acts`,       actsRouter);

// ---------------------------------------------------------------------------
// 404 + Error handler (должны быть ПОСЛЕДНИМИ)
// ---------------------------------------------------------------------------
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
