function _typeof(o) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (o) { return typeof o; } : function (o) { return o && "function" == typeof Symbol && o.constructor === Symbol && o !== Symbol.prototype ? "symbol" : typeof o; }, _typeof(o); }
function ownKeys(e, r) { var t = Object.keys(e); if (Object.getOwnPropertySymbols) { var o = Object.getOwnPropertySymbols(e); r && (o = o.filter(function (r) { return Object.getOwnPropertyDescriptor(e, r).enumerable; })), t.push.apply(t, o); } return t; }
function _objectSpread(e) { for (var r = 1; r < arguments.length; r++) { var t = null != arguments[r] ? arguments[r] : {}; r % 2 ? ownKeys(Object(t), !0).forEach(function (r) { _defineProperty(e, r, t[r]); }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : ownKeys(Object(t)).forEach(function (r) { Object.defineProperty(e, r, Object.getOwnPropertyDescriptor(t, r)); }); } return e; }
function _defineProperty(e, r, t) { return (r = _toPropertyKey(r)) in e ? Object.defineProperty(e, r, { value: t, enumerable: !0, configurable: !0, writable: !0 }) : e[r] = t, e; }
function _toPropertyKey(t) { var i = _toPrimitive(t, "string"); return "symbol" == _typeof(i) ? i : i + ""; }
function _toPrimitive(t, r) { if ("object" != _typeof(t) || !t) return t; var e = t[Symbol.toPrimitive]; if (void 0 !== e) { var i = e.call(t, r || "default"); if ("object" != _typeof(i)) return i; throw new TypeError("@@toPrimitive must return a primitive value."); } return ("string" === r ? String : Number)(t); }
function _regenerator() { /*! regenerator-runtime -- Copyright (c) 2014-present, Facebook, Inc. -- license (MIT): https://github.com/babel/babel/blob/main/packages/babel-helpers/LICENSE */ var e, t, r = "function" == typeof Symbol ? Symbol : {}, n = r.iterator || "@@iterator", o = r.toStringTag || "@@toStringTag"; function i(r, n, o, i) { var c = n && n.prototype instanceof Generator ? n : Generator, u = Object.create(c.prototype); return _regeneratorDefine2(u, "_invoke", function (r, n, o) { var i, c, u, f = 0, p = o || [], y = !1, G = { p: 0, n: 0, v: e, a: d, f: d.bind(e, 4), d: function d(t, r) { return i = t, c = 0, u = e, G.n = r, a; } }; function d(r, n) { for (c = r, u = n, t = 0; !y && f && !o && t < p.length; t++) { var o, i = p[t], d = G.p, l = i[2]; r > 3 ? (o = l === n) && (u = i[(c = i[4]) ? 5 : (c = 3, 3)], i[4] = i[5] = e) : i[0] <= d && ((o = r < 2 && d < i[1]) ? (c = 0, G.v = n, G.n = i[1]) : d < l && (o = r < 3 || i[0] > n || n > l) && (i[4] = r, i[5] = n, G.n = l, c = 0)); } if (o || r > 1) return a; throw y = !0, n; } return function (o, p, l) { if (f > 1) throw TypeError("Generator is already running"); for (y && 1 === p && d(p, l), c = p, u = l; (t = c < 2 ? e : u) || !y;) { i || (c ? c < 3 ? (c > 1 && (G.n = -1), d(c, u)) : G.n = u : G.v = u); try { if (f = 2, i) { if (c || (o = "next"), t = i[o]) { if (!(t = t.call(i, u))) throw TypeError("iterator result is not an object"); if (!t.done) return t; u = t.value, c < 2 && (c = 0); } else 1 === c && (t = i.return) && t.call(i), c < 2 && (u = TypeError("The iterator does not provide a '" + o + "' method"), c = 1); i = e; } else if ((t = (y = G.n < 0) ? u : r.call(n, G)) !== a) break; } catch (t) { i = e, c = 1, u = t; } finally { f = 1; } } return { value: t, done: y }; }; }(r, o, i), !0), u; } var a = {}; function Generator() {} function GeneratorFunction() {} function GeneratorFunctionPrototype() {} t = Object.getPrototypeOf; var c = [][n] ? t(t([][n]())) : (_regeneratorDefine2(t = {}, n, function () { return this; }), t), u = GeneratorFunctionPrototype.prototype = Generator.prototype = Object.create(c); function f(e) { return Object.setPrototypeOf ? Object.setPrototypeOf(e, GeneratorFunctionPrototype) : (e.__proto__ = GeneratorFunctionPrototype, _regeneratorDefine2(e, o, "GeneratorFunction")), e.prototype = Object.create(u), e; } return GeneratorFunction.prototype = GeneratorFunctionPrototype, _regeneratorDefine2(u, "constructor", GeneratorFunctionPrototype), _regeneratorDefine2(GeneratorFunctionPrototype, "constructor", GeneratorFunction), GeneratorFunction.displayName = "GeneratorFunction", _regeneratorDefine2(GeneratorFunctionPrototype, o, "GeneratorFunction"), _regeneratorDefine2(u), _regeneratorDefine2(u, o, "Generator"), _regeneratorDefine2(u, n, function () { return this; }), _regeneratorDefine2(u, "toString", function () { return "[object Generator]"; }), (_regenerator = function _regenerator() { return { w: i, m: f }; })(); }
function _regeneratorDefine2(e, r, n, t) { var i = Object.defineProperty; try { i({}, "", {}); } catch (e) { i = 0; } _regeneratorDefine2 = function _regeneratorDefine(e, r, n, t) { function o(r, n) { _regeneratorDefine2(e, r, function (e) { return this._invoke(r, n, e); }); } r ? i ? i(e, r, { value: n, enumerable: !t, configurable: !t, writable: !t }) : e[r] = n : (o("next", 0), o("throw", 1), o("return", 2)); }, _regeneratorDefine2(e, r, n, t); }
function asyncGeneratorStep(n, t, e, r, o, a, c) { try { var i = n[a](c), u = i.value; } catch (n) { return void e(n); } i.done ? t(u) : Promise.resolve(u).then(r, o); }
function _asyncToGenerator(n) { return function () { var t = this, e = arguments; return new Promise(function (r, o) { var a = n.apply(t, e); function _next(n) { asyncGeneratorStep(a, r, o, _next, _throw, "next", n); } function _throw(n) { asyncGeneratorStep(a, r, o, _next, _throw, "throw", n); } _next(void 0); }); }; }
/**
 * BFC24 WMS v2 — Shared API Layer
 * Единственный файл для всех запросов к backend.
 * Все экраны подключают этот файл и используют только его.
 */
(function (window) {
  'use strict';

  var API_BASE = '/api/v2';

  // ─────────────── Token Management ───────────────

  var TOKEN_KEY = 'wms2_token';
  var REFRESH_TOKEN_KEY = 'wms2_refresh_token';
  var USER_KEY = 'wms2_user';
  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }
  function getRefreshToken() {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  }
  function getUser() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    } catch (_unused) {
      return null;
    }
  }
  function saveAuth(token, user, refreshToken) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    if (refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  }
  function clearAuth() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  }
  function isLoggedIn() {
    return !!getToken();
  }

  // ─────────────── HTTP Core ───────────────

  // Access token живёт недолго (см. JWT_EXPIRES_IN, по умолчанию 2ч). Чтобы не
  // выкидывать пользователя на логин при каждом истечении, при 401 пробуем один
  // раз молча обновить его через refresh token, и только если это не удалось —
  // разлогиниваем. Конкурентные запросы, словившие 401 одновременно, ждут один
  // и тот же refresh (не долбят /auth/refresh параллельно).
  var refreshPromise = null;
  function trySilentRefresh() {
    return _trySilentRefresh.apply(this, arguments);
  }
  function _trySilentRefresh() {
    _trySilentRefresh = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee7() {
      var rt;
      return _regenerator().w(function (_context7) {
        while (1) switch (_context7.n) {
          case 0:
            rt = getRefreshToken();
            if (rt) {
              _context7.n = 1;
              break;
            }
            return _context7.a(2, false);
          case 1:
            if (!refreshPromise) {
              refreshPromise = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee6() {
                var res, json, _t2;
                return _regenerator().w(function (_context6) {
                  while (1) switch (_context6.p = _context6.n) {
                    case 0:
                      _context6.p = 0;
                      _context6.n = 1;
                      return fetch("".concat(API_BASE, "/auth/refresh"), {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                          refreshToken: rt
                        })
                      });
                    case 1:
                      res = _context6.v;
                      if (res.ok) {
                        _context6.n = 2;
                        break;
                      }
                      return _context6.a(2, false);
                    case 2:
                      _context6.n = 3;
                      return res.json().catch(function () {
                        return null;
                      });
                    case 3:
                      json = _context6.v;
                      if (!(!json || json.ok === false || !json.accessToken)) {
                        _context6.n = 4;
                        break;
                      }
                      return _context6.a(2, false);
                    case 4:
                      localStorage.setItem(TOKEN_KEY, json.accessToken);
                      if (json.refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, json.refreshToken);
                      return _context6.a(2, true);
                    case 5:
                      _context6.p = 5;
                      _t2 = _context6.v;
                      return _context6.a(2, false);
                    case 6:
                      _context6.p = 6;
                      refreshPromise = null;
                      return _context6.f(6);
                    case 7:
                      return _context6.a(2);
                  }
                }, _callee6, null, [[0, 5, 6, 7]]);
              }))();
            }
            return _context7.a(2, refreshPromise);
        }
      }, _callee7);
    }));
    return _trySilentRefresh.apply(this, arguments);
  }
  function request(_x, _x2) {
    return _request.apply(this, arguments);
  }
  function _request() {
    _request = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee8(method, path) {
      var data,
        opts,
        isFormData,
        doFetch,
        res,
        refreshed,
        json,
        msg,
        err,
        _args8 = arguments,
        _t3;
      return _regenerator().w(function (_context8) {
        while (1) switch (_context8.p = _context8.n) {
          case 0:
            data = _args8.length > 2 && _args8[2] !== undefined ? _args8[2] : null;
            opts = _args8.length > 3 && _args8[3] !== undefined ? _args8[3] : {};
            // FormData (загрузка файла) — НЕ JSON.stringify и НЕ выставляем свой
            // Content-Type: браузер сам проставит multipart/form-data с правильным
            // boundary, если мы его не трогаем.
            isFormData = typeof FormData !== 'undefined' && data instanceof FormData;
            doFetch = function doFetch() {
              var token = getToken();
              var headers = isFormData ? {} : {
                'Content-Type': 'application/json'
              };
              if (token) headers['Authorization'] = "Bearer ".concat(token);
              // На части ТСД со старым WebView (например Атол Smart.Lite) сетевой
              // стек агрессивно кэширует GET-запросы по URL даже без явных
              // Cache-Control заголовков от бэкенда — из-за этого, например,
              // список отгрузок мог показывать давно устаревший ответ (уже
              // отгруженные заказы всё ещё "готовы к отгрузке"). cache:'no-store'
              // + заголовок явно запрещают браузеру подставлять кэш вместо
              // свежего запроса. Ставим на все запросы (не только GET) - лишним
              // не будет, а для мутаций надёжнее не оставлять места двусмысленности.
              headers['Cache-Control'] = 'no-cache';
              var config = _objectSpread({
                method: method,
                headers: headers,
                cache: 'no-store'
              }, opts);
              if (data !== null && method !== 'GET') config.body = isFormData ? data : JSON.stringify(data);
              var url = path.startsWith('http') ? path : "".concat(API_BASE).concat(path);
              return fetch(url, config);
            };
            _context8.n = 1;
            return doFetch();
          case 1:
            res = _context8.v;
            if (!(res.status === 401 && !opts.noRedirect)) {
              _context8.n = 4;
              break;
            }
            _context8.n = 2;
            return trySilentRefresh();
          case 2:
            refreshed = _context8.v;
            if (!refreshed) {
              _context8.n = 4;
              break;
            }
            _context8.n = 3;
            return doFetch();
          case 3:
            res = _context8.v;
          case 4:
            if (!(res.status === 401 && !opts.noRedirect)) {
              _context8.n = 5;
              break;
            }
            clearAuth();
            window.location.href = '/app/login.html';
            return _context8.a(2, null);
          case 5:
            _context8.p = 5;
            _context8.n = 6;
            return res.json();
          case 6:
            json = _context8.v;
            _context8.n = 8;
            break;
          case 7:
            _context8.p = 7;
            _t3 = _context8.v;
            json = {
              ok: false,
              error: {
                message: 'Invalid response'
              }
            };
          case 8:
            if (!(res.status === 403 && json && json.error && json.error.code === 'NOT_CHECKED_IN' && !opts.noRedirect && window.location.pathname !== '/app/checkin.html')) {
              _context8.n = 9;
              break;
            }
            window.location.href = '/app/checkin.html';
            return _context8.a(2, null);
          case 9:
            if (!(!res.ok || (json && json.ok) === false)) {
              _context8.n = 10;
              break;
            }
            msg = json && json.error && json.error.message || json && json.message || "HTTP ".concat(res.status);
            err = new Error(msg);
            err.code = json && json.error && json.error.code || 'API_ERROR';
            err.status = res.status;
            err.details = json && json.error && json.error.details;
            throw err;
          case 10:
            return _context8.a(2, json);
        }
      }, _callee8, null, [[5, 7]]);
    }));
    return _request.apply(this, arguments);
  }
  var _get = function get(path, params) {
    var url = params ? "".concat(path, "?").concat(new URLSearchParams(params)) : path;
    return request('GET', url);
  };
  var post = function post(path, data) {
    return request('POST', path, data);
  };
  var patch = function patch(path, data) {
    return request('PATCH', path, data);
  };
  var put = function put(path, data) {
    return request('PUT', path, data);
  };
  var del = function del(path) {
    return request('DELETE', path);
  };
  var postFile = function postFile(path, formData) {
    return request('POST', path, formData);
  };

  // ─────────────── Auth ───────────────

  var auth = {
    login: function login(username, password) {
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee() {
        var res;
        return _regenerator().w(function (_context) {
          while (1) switch (_context.n) {
            case 0:
              _context.n = 1;
              return request('POST', '/auth/login', {
                username: username,
                password: password
              }, {
                noRedirect: true
              });
            case 1:
              res = _context.v;
              if (res) saveAuth(res.accessToken, res.user, res.refreshToken);
              return _context.a(2, res);
          }
        }, _callee);
      }))();
    },
    me: function me() {
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee2() {
        return _regenerator().w(function (_context2) {
          while (1) switch (_context2.n) {
            case 0:
              return _context2.a(2, _get('/auth/me'));
          }
        }, _callee2);
      }))();
    },
    logout: function logout(refreshToken) {
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee3() {
        var _t;
        return _regenerator().w(function (_context3) {
          while (1) switch (_context3.p = _context3.n) {
            case 0:
              _context3.p = 0;
              _context3.n = 1;
              return post('/auth/logout', {
                refreshToken: refreshToken || getRefreshToken()
              });
            case 1:
              _context3.n = 3;
              break;
            case 2:
              _context3.p = 2;
              _t = _context3.v;
            case 3:
              clearAuth();
            case 4:
              return _context3.a(2);
          }
        }, _callee3, null, [[0, 2]]);
      }))();
    },
    changePassword: function changePassword(currentPassword, newPassword) {
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee4() {
        return _regenerator().w(function (_context4) {
          while (1) switch (_context4.n) {
            case 0:
              return _context4.a(2, post('/auth/change-password', {
                currentPassword: currentPassword,
                newPassword: newPassword
              }));
          }
        }, _callee4);
      }))();
    }
  };

  // ─────────────── Users ───────────────

  var users = {
    list: function list(params) {
      return _get('/users', params);
    },
    get: function get(id) {
      return _get("/users/".concat(id));
    },
    create: function create(data) {
      return post('/users', data);
    },
    update: function update(id, d) {
      return patch("/users/".concat(id), d);
    },
    delete: function _delete(id) {
      return del("/users/".concat(id));
    }
  };

  // ─────────────── Clients ───────────────

  var clients = {
    list: function list(params) {
      return _get('/clients', params);
    },
    short: function short() {
      return _get('/clients/short');
    },
    get: function get(id) {
      return _get("/clients/".concat(id));
    },
    create: function create(data) {
      return post('/clients', data);
    },
    update: function update(id, d) {
      return patch("/clients/".concat(id), d);
    }
  };

  // ─────────────── Warehouses ───────────────

  var warehouses = {
    list: function list() {
      return _get('/warehouses');
    },
    get: function get(id) {
      return _get("/warehouses/".concat(id));
    },
    create: function create(data) {
      return post('/warehouses', data);
    },
    update: function update(id, d) {
      return patch("/warehouses/".concat(id), d);
    }
  };

  // ─────────────── Items ───────────────

  var items = {
    list: function list(p) {
      return _get('/items', p);
    },
    byBarcode: function byBarcode(b, clientId) {
      return _get('/items/by-barcode', {
        barcode: b,
        client_id: clientId
      });
    },
    byKiz: function byKiz(code, clientId) {
      return _get('/items/by-kiz', {
        code: code,
        client_id: clientId
      });
    },
    get: function get(id) {
      return _get("/items/".concat(id));
    },
    create: function create(d) {
      return post('/items', d);
    },
    update: function update(id, d) {
      return patch("/items/".concat(id), d);
    },
    delete: function _delete(id) {
      return del("/items/".concat(id));
    },
    bulkDelete: function bulkDelete(itemIds) {
      return post('/items/bulk-delete', {
        item_ids: itemIds
      });
    },
    printLabel: function printLabel(id) {
      var copies = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 1;
      return post("/items/".concat(id, "/print-label"), {
        copies: copies
      });
    },
    packagingMaterials: function packagingMaterials(id) {
      return _get("/items/".concat(id, "/packaging-materials"));
    },
    setPackagingMaterials: function setPackagingMaterials(id, materials) {
      return put("/items/".concat(id, "/packaging-materials"), {
        materials: materials
      });
    }
  };

  // ─────────────── Marking (Честный знак) ───────────────

  var marking = {
    summary: function summary(itemId) {
      return _get("/marking/items/".concat(itemId, "/codes/summary"));
    },
    listCodes: function listCodes(itemId, p) {
      return _get("/marking/items/".concat(itemId, "/codes"), p);
    },
    importCodes: function importCodes(itemId, codesText) {
      return post("/marking/items/".concat(itemId, "/codes/import"), {
        codes_text: codesText
      });
    },
    importCodesFile: function importCodesFile(itemId, file) {
      var fd = new FormData();
      fd.append('file', file);
      return postFile("/marking/items/".concat(itemId, "/codes/import-file"), fd);
    },
    deleteCode: function deleteCode(itemId, codeId) {
      return del("/marking/items/".concat(itemId, "/codes/").concat(codeId));
    },
    updateSettings: function updateSettings(itemId, d) {
      return patch("/marking/items/".concat(itemId, "/settings"), d);
    },
    bulkUpdateSettings: function bulkUpdateSettings(itemIds, d) {
      return patch('/marking/items/bulk-settings', _objectSpread({
        item_ids: itemIds
      }, d));
    },
    pendingOverrides: function pendingOverrides(p) {
      return _get('/marking/pending-manual-overrides', p);
    },
    exportForShipment: function exportForShipment(shipmentCode) {
      return _get('/marking/export', {
        shipment_code: shipmentCode
      });
    },
    shippedReport: function shippedReport(p) {
      return _get('/marking/shipped-report', p);
    },
    codesJournal: function codesJournal(p) {
      return _get('/marking/codes-journal', p);
    },
    logRejectedCode: function logRejectedCode(d) {
      return post('/marking/diagnostics/rejected-code', d);
    },
    withdrawalPending: function withdrawalPending(p) {
      return _get('/marking/withdrawal/pending', p);
    },
    withdrawalExport: function withdrawalExport(d) {
      return post('/marking/withdrawal/export', d || {});
    },
    withdrawalExports: function withdrawalExports(p) {
      return _get('/marking/withdrawal/exports', p);
    },
    withdrawalExportItems: function withdrawalExportItems(id) {
      return _get("/marking/withdrawal/exports/".concat(id));
    },
    reprintCode: function reprintCode(code) {
      return post('/marking/reprint-code', { code: code });
    },
    codeTimeline: function codeTimeline(code) {
      return _get('/marking/code-timeline', { code: code });
    }
  };

  // ─────────────── Locations ───────────────

  var locations = {
    list: function list(p) {
      return _get('/locations', p);
    },
    byCode: function byCode(code, warehouseId) {
      return _get('/locations/by-code', {
        code: code,
        warehouse_id: warehouseId
      });
    },
    get: function get(id) {
      return _get("/locations/".concat(id));
    },
    create: function create(d) {
      return post('/locations', d);
    },
    update: function update(id, d) {
      return patch("/locations/".concat(id), d);
    },
    delete: function _delete(id) {
      return del("/locations/".concat(id));
    },
    bulkCreate: function bulkCreate(d) {
      return post('/locations/bulk', d);
    },
    printLabels: function printLabels(locationIds) {
      return post('/locations/labels', {
        location_ids: locationIds
      });
    },
    bulkDimensions: function bulkDimensions(d) {
      return patch('/locations/bulk-dimensions', d);
    },
    fillReport: function fillReport(p) {
      return _get('/locations/fill-report', p);
    }
  };

  // ─────────────── Stock ───────────────

  var stock = {
    list: function list(p) {
      return _get('/stock', p);
    },
    byBarcode: function byBarcode(b, p) {
      return _get('/stock/by-barcode', _objectSpread({
        barcode: b
      }, p));
    },
    byLocation: function byLocation(code, p) {
      return _get('/stock/by-location', _objectSpread({
        location_code: code
      }, p));
    },
    movements: function movements(p) {
      return _get('/stock/movements', p);
    },
    adjust: function adjust(d) {
      return post('/stock/adjust', d);
    },
    move: function move(d) {
      return post('/stock/move', d);
    }
  };

  // ─────────────── Inbound Orders ───────────────

  var inbound = {
    list: function list(p) {
      return _get('/inbound', p);
    },
    byBarcode: function byBarcode(b) {
      return _get('/inbound/by-barcode', {
        barcode: b
      });
    },
    get: function get(id) {
      return _get("/inbound/".concat(id));
    },
    create: function create(d) {
      return post('/inbound', d);
    },
    confirm: function confirm(id) {
      return post("/inbound/".concat(id, "/confirm"));
    },
    cancel: function cancel(id) {
      return post("/inbound/".concat(id, "/cancel"));
    },
    closeShort: function closeShort(id, reason) {
      return post("/inbound/".concat(id, "/close-short"), {
        reason: reason || undefined
      });
    },
    updateDeliveryInfo: function updateDeliveryInfo(id, d) {
      return patch("/inbound/".concat(id, "/delivery-info"), d);
    },
    label: function label(id) {
      return _get("/inbound/".concat(id, "/label"));
    }
  };

  // ─────────────── Tenant (реквизиты своей компании) ───────────────

  var tenant = {
    profile: function profile() {
      return _get('/tenant/profile');
    },
    updateProfile: function updateProfile(d) {
      return patch('/tenant/profile', d);
    }
  };

  // ─────────────── Acceptance Acts (Акт приёмки товара) ───────────────

  var acts = {
    list: function list(p) {
      return _get('/acts', p);
    },
    get: function get(id) {
      return _get("/acts/".concat(id));
    },
    create: function create(d) {
      return post('/acts', d);
    },
    update: function update(id, d) {
      return patch("/acts/".concat(id), d);
    },
    freeLines: function freeLines(p) {
      return _get('/acts/free-lines', p);
    },
    uncovered: function uncovered(p) {
      return _get('/acts/uncovered', p);
    },
    share: function share(id, shared) {
      return post("/acts/".concat(id, "/share"), {
        shared: shared
      });
    }
  };

  // ─────────────── Receiving ───────────────

  var receiving = {
    accept: function accept(d) {
      return post('/receiving/accept', d);
    },
    acceptByInbound: function acceptByInbound(d) {
      return post('/receiving/accept-by-inbound', d);
    },
    history: function history(p) {
      return _get('/receiving/history', p);
    }
  };

  // ─────────────── Placement ───────────────

  var placement = {
    pending: function pending(p) {
      return _get('/placement/pending', p);
    },
    pendingByBarcode: function pendingByBarcode(barcode, p) {
      return _get('/placement/pending/barcode', _objectSpread({
        barcode: barcode
      }, p));
    },
    place: function place(d) {
      return post('/placement/place', d);
    },
    batch: function batch(d) {
      return post('/placement/batch', d);
    },
    history: function history(p) {
      return _get('/placement/history', p);
    },
    suggest: function suggest(p) {
      return _get('/placement/suggest', p);
    }
  };

  // ─────────────── Movement ───────────────

  var movement = {
    move: function move(d) {
      return post('/movement/move', d);
    },
    batch: function batch(d) {
      return post('/movement/batch', d);
    },
    history: function history(p) {
      return _get('/movement/history', p);
    },
    location: function location(p) {
      return _get('/movement/location', p);
    }
  };

  // ─────────────── Inventory ───────────────

  var inventory = {
    tasks: function tasks(p) {
      return _get('/inventory/tasks', p);
    },
    task: function task(id) {
      return _get("/inventory/tasks/".concat(id));
    },
    createTask: function createTask(d) {
      return post('/inventory/tasks', d);
    },
    createBatch: function createBatch(d) {
      return post('/inventory/tasks/batch', d);
    },
    createBatchMulti: function createBatchMulti(d) {
      return post('/inventory/tasks/batch-multi', d);
    },
    assign: function assign(id, d) {
      return post("/inventory/tasks/".concat(id, "/assign"), d);
    },
    count: function count(id, d) {
      return post("/inventory/tasks/".concat(id, "/count"), d);
    },
    close: function close(id, d) {
      return post("/inventory/tasks/".concat(id, "/close"), d);
    },
    discrepancies: function discrepancies(p) {
      return _get('/inventory/discrepancies', p);
    },
    assembleKit: function assembleKit(d) {
      return post('/inventory/assemble-kit', d);
    }
  };

  // ─────────────── Picking ───────────────

  var picking = {
    waves: function waves(p) {
      return _get('/picking/waves', p);
    },
    waveStatus: function waveStatus() {
      return _get('/picking/wave/status');
    },
    takeWave: function takeWave() {
      return post('/picking/wave/take');
    },
    closeWave: function closeWave(d) {
      return post('/picking/wave/close', d);
    },
    next: function next(p) {
      return _get('/picking/next', p);
    },
    scanLocation: function scanLocation(d) {
      return post('/picking/scan/location', d);
    },
    scanItem: function scanItem(d) {
      return post('/picking/scan/item', d);
    },
    scanItemQty: function scanItemQty(d) {
      return post('/picking/scan/item-qty', d);
    },
    skip: function skip(d) {
      return post('/picking/skip', d);
    },
    manualWave: function manualWave(d) {
      return post('/picking/manual-wave', d);
    },
    skipped: function skipped(p) {
      return _get('/picking/tasks/skipped', p);
    },
    requeue: function requeue(id) {
      return post("/picking/tasks/".concat(id, "/requeue"));
    }
  };

  // ─────────────── Packing ───────────────

  var packing = {
    next: function next() {
      return post('/packing/next');
    },
    current: function current() {
      return _get('/packing/current');
    },
    scanItem: function scanItem(d) {
      return post('/packing/scan-item', d);
    },
    confirm: function confirm(d) {
      return post('/packing/confirm', d);
    },
    stickerImage: function stickerImage(wbOrderId) {
      return _get("/packing/sticker-image/".concat(wbOrderId));
    }
  };

  // ─────────────── Shipping ───────────────

  var shipping = {
    board: function board(p) {
      return _get('/shipping/board', p);
    },
    header: function header(code) {
      return _get('/shipping/header', {
        shipment_code: code
      });
    },
    details: function details(code) {
      return _get('/shipping/details', {
        shipment_code: code
      });
    },
    confirm: function confirm(d) {
      return post('/shipping/confirm', d);
    },
    markDelivered: function markDelivered(code) {
      return post('/shipping/mark-delivered', {
        shipment_code: code
      });
    },
    cancel: function cancel(code, reason) {
      return post('/shipping/cancel', {
        shipment_code: code,
        reason: reason
      });
    },
    returnPicked: function returnPicked(code, barcode, qty, locationCode) {
      return post('/shipping/return-picked', {
        shipment_code: code,
        barcode: barcode,
        qty: qty,
        location_code: locationCode
      });
    }
  };

  // ─────────────── Overview ("Табло") ───────────────

  var overview = {
    funnel: function funnel() {
      return _get('/overview/funnel');
    }
  };

  // ─────────────── WB ───────────────

  var wb = {
    accounts: {
      list: function list(p) {
        return _get('/wb/accounts', p);
      },
      create: function create(d) {
        return post('/wb/accounts', d);
      },
      update: function update(id, d) {
        return patch("/wb/accounts/".concat(id), d);
      }
    },
    warehouses: {
      list: function list(accountId) {
        return _get("/wb/accounts/".concat(accountId, "/warehouses"));
      },
      update: function update(accountId, whId, d) {
        return patch("/wb/accounts/".concat(accountId, "/warehouses/").concat(whId), d);
      }
    },
    syncOrders: function syncOrders(d) {
      return post('/wb/sync-orders', d);
    },
    syncOrdersAll: function syncOrdersAll() {
      return post('/wb/sync-orders-all', {});
    },
    importItems: function importItems(d) {
      return post('/wb/import-items', d);
    },
    generateWave: function generateWave(d) {
      return post('/wb/generate-wave', d);
    },
    orders: function orders(p) {
      return _get('/wb/orders', p);
    },
    wbItems: function wbItems(p) {
      return _get('/wb/items', p);
    },
    reconcile: function reconcile() {
      return _get('/wb/reconcile');
    },
    tariffs: function tariffs() {
      return _get('/wb/tariffs');
    },
    acceptanceCoefficients: function acceptanceCoefficients() {
      return _get('/wb/acceptance-coefficients');
    }
  };

  // ─────────────── FBS-аналитика ───────────────

  var fbsAnalytics = {
    summary: function summary(p) {
      return _get('/fbs-analytics/summary', p);
    },
    speed: function speed(p) {
      return _get('/fbs-analytics/speed', p);
    },
    speedByClient: function speedByClient(p) {
      return _get('/fbs-analytics/speed-by-client', p);
    },
    refreshNow: function refreshNow() {
      return post('/fbs-analytics/refresh-now', {});
    },
    regionDelivery: function regionDelivery(p) {
      return _get('/fbs-analytics/region-delivery', p);
    },
    regionDeliveryFilters: function regionDeliveryFilters() {
      return _get('/fbs-analytics/region-delivery/filters');
    }
  };

  // ─────────────── Отчёт по дефицитам ───────────────

  var deficit = {
    report: function report(p) {
      return _get('/deficit/report', p);
    }
  };

  // ─────────────── Printing ───────────────

  var printing = {
    printers: {
      list: function list() {
        return _get('/printing/printers');
      },
      create: function create(d) {
        return post('/printing/printers', d);
      },
      update: function update(id, d) {
        return patch("/printing/printers/".concat(id), d);
      },
      issueAgentKey: function issueAgentKey(id) {
        return post("/printing/printers/".concat(id, "/agent-key"), {});
      },
      bulkImport: function bulkImport(printers) {
        var issueAgentKeys = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : true;
        return post('/printing/printers/bulk-import', {
          printers: printers,
          issue_agent_keys: issueAgentKeys
        });
      }
    },
    routes: {
      list: function list() {
        return _get('/printing/routes');
      },
      create: function create(d) {
        return post('/printing/routes', d);
      },
      update: function update(id, d) {
        return patch("/printing/routes/".concat(id), d);
      },
      delete: function _delete(id) {
        return del("/printing/routes/".concat(id));
      }
    },
    jobs: function jobs(p) {
      return _get('/printing/jobs', p);
    },
    updateJob: function updateJob(id, d) {
      return patch("/printing/jobs/".concat(id), d);
    },
    reprint: function reprint(jobId) {
      return post('/printing/jobs/reprint', {
        job_id: jobId
      });
    }
  };

  // ─────────────── Workstations (рабочие места) ───────────────

  var workstations = {
    list: function list() {
      return _get('/workstations');
    },
    create: function create(d) {
      return post('/workstations', d);
    },
    update: function update(id, d) {
      return patch("/workstations/".concat(id), d);
    },
    delete: function _delete(id) {
      return del("/workstations/".concat(id));
    },
    my: function my() {
      return _get('/workstations/my');
    },
    select: function select(station_code) {
      return post('/workstations/select', {
        station_code: station_code
      });
    },
    sticker: function sticker(id) {
      return _get("/workstations/".concat(id, "/sticker"));
    },
    bulkImport: function bulkImport(workstations) {
      return post('/workstations/bulk-import', {
        workstations: workstations
      });
    }
  };

  // ─────────────── Checkin (отметка на складе по QR) ───────────────

  var checkin = {
    token: function token() {
      return _get('/checkin/token');
    },
    // supervisor/admin — свежий QR для экрана
    scan: function scan(token) {
      return post('/checkin/scan', {
        token: token
      });
    },
    // сотрудник — отсканировал код
    status: function status() {
      return _get('/checkin/status');
    }
  };

  // ─────────────── Billing (биллинг фулфилмента) ───────────────

  var billing = {
    priceList: {
      list: function list(clientId) {
        return _get('/billing/price-list', clientId ? {
          client_id: clientId
        } : undefined);
      },
      upsert: function upsert(d) {
        return post('/billing/price-list', d);
      },
      delete: function _delete(id) {
        return del("/billing/price-list/".concat(id));
      }
    },
    charges: {
      list: function list(p) {
        return _get('/billing/charges', p);
      },
      add: function add(d) {
        return post('/billing/charges', d);
      },
      bulkDelete: function bulkDelete(chargeIds) {
        return post('/billing/charges/bulk-delete', {
          charge_ids: chargeIds
        });
      }
    },
    clientBalance: function clientBalance(clientId) {
      return _get("/billing/clients/".concat(clientId, "/balance"));
    },
    analytics: {
      revenue: function revenue(p) {
        return _get('/billing/analytics/revenue', p);
      },
      invoices: function invoices(p) {
        return _get('/billing/analytics/invoices', p);
      }
    },
    invoices: {
      list: function list(p) {
        return _get('/billing/invoices', p);
      },
      get: function get(id) {
        return _get("/billing/invoices/".concat(id));
      },
      create: function create(d) {
        return post('/billing/invoices', d);
      },
      updateStatus: function updateStatus(id, status, notes) {
        return patch("/billing/invoices/".concat(id, "/status"), {
          status: status,
          notes: notes
        });
      }
    }
  };

  // ─────────────── Consumables (расходные материалы) ───────────────

  var consumables = {
    list: function list(all) {
      return _get('/consumables', all ? {
        all: 'true'
      } : undefined);
    },
    upsert: function upsert(d) {
      return post('/consumables', d);
    },
    delete: function _delete(id) {
      return del("/consumables/".concat(id));
    },
    adjust: function adjust(id, delta, comment, refType) {
      return post("/consumables/".concat(id, "/adjust"), {
        delta: delta,
        comment: comment,
        ref_type: refType
      });
    },
    recordUsage: function recordUsage(id, d) {
      return post("/consumables/".concat(id, "/usage"), d);
    },
    usageHistory: function usageHistory(p) {
      return _get('/consumables/usage', p);
    }
  };

  // ─────────────── Payroll (сдельная ЗП) ───────────────

  var payroll = {
    rates: {
      list: function list() {
        return _get('/payroll/rates');
      },
      upsert: function upsert(d) {
        return post('/payroll/rates', d);
      },
      delete: function _delete(id) {
        return del("/payroll/rates/".concat(id));
      }
    },
    report: function report(dateFrom, dateTo, clientId) {
      return _get('/payroll/report', clientId ? {
        date_from: dateFrom,
        date_to: dateTo,
        client_id: clientId
      } : {
        date_from: dateFrom,
        date_to: dateTo
      });
    },
    analytics: function analytics(p) {
      return _get('/payroll/analytics', p);
    }
  };

  // ─────────────── Returns (возвраты) ───────────────

  var returns = {
    register: function register(d) {
      return post('/returns/register', d);
    },
    history: function history(p) {
      return _get('/returns/history', p);
    },
    summary: function summary(p) {
      return _get('/returns/summary', p);
    },
    byClient: function byClient(p) {
      return _get('/returns/by-client', p);
    },
    wbClaims: function wbClaims(p) {
      return _get('/wb/return-claims', p);
    }
  };

  // ─────────────── Seller ───────────────

  var seller = {
    profile: function profile() {
      return _get('/seller/profile');
    },
    inbound: {
      list: function list(p) {
        return _get('/seller/inbound', p);
      },
      get: function get(id) {
        return _get("/seller/inbound/".concat(id));
      },
      create: function create(d) {
        return post('/seller/inbound', d);
      },
      confirm: function confirm(id) {
        return post("/seller/inbound/".concat(id, "/confirm"));
      }
    },
    stock: function stock(p) {
      return _get('/seller/stock', p);
    },
    orders: function orders(p) {
      return _get('/seller/orders', p);
    },
    shipments: function shipments(p) {
      return _get('/seller/shipments', p);
    },
    items: function items(p) {
      return _get('/seller/items', p);
    },
    setItemCostPrice: function setItemCostPrice(itemId, costPrice) {
      return patch("/seller/items/".concat(itemId, "/cost-price"), {
        cost_price: costPrice
      });
    },
    setItemReorderThreshold: function setItemReorderThreshold(itemId, data) {
      return patch("/seller/items/".concat(itemId, "/reorder-threshold"), data);
    },
    markingSummary: function markingSummary(itemId) {
      return _get("/seller/items/".concat(itemId, "/marking/summary"));
    },
    markingCodes: function markingCodes(itemId, p) {
      return _get("/seller/items/".concat(itemId, "/marking/codes"), p);
    },
    importMarkingCodes: function importMarkingCodes(itemId, codesText) {
      return post("/seller/items/".concat(itemId, "/marking/codes/import"), {
        codes_text: codesText
      });
    },
    updateMarkingSettings: function updateMarkingSettings(itemId, d) {
      return patch("/seller/items/".concat(itemId, "/marking/settings"), d);
    },
    bulkUpdateMarkingSettings: function bulkUpdateMarkingSettings(itemIds, d) {
      return patch('/seller/items/marking/bulk-settings', _objectSpread({
        item_ids: itemIds
      }, d));
    },
    returns: function returns(p) {
      return _get('/seller/returns', p);
    },
    returnsSummary: function returnsSummary(p) {
      return _get('/seller/returns/summary', p);
    },
    wbReturnClaims: function wbReturnClaims(p) {
      return _get('/seller/wb-return-claims', p);
    },
    analytics: function analytics(p) {
      return _get('/seller/analytics/sales', p);
    },
    fbsAnalyticsSummary: function fbsAnalyticsSummary(p) {
      return _get('/seller/fbs-analytics/summary', p);
    },
    fbsAnalyticsSpeed: function fbsAnalyticsSpeed(p) {
      return _get('/seller/fbs-analytics/speed', p);
    },
    fbsAnalyticsRegionDelivery: function fbsAnalyticsRegionDelivery(p) {
      return _get('/seller/fbs-analytics/region-delivery', p);
    },
    fbsAnalyticsRegionDeliveryFilters: function fbsAnalyticsRegionDeliveryFilters() {
      return _get('/seller/fbs-analytics/region-delivery/filters');
    },
    history: function history(p) {
      return _get('/seller/history', p);
    },
    receivingHistory: function receivingHistory(p) {
      return _get('/seller/receiving-history', p);
    },
    acts: {
      list: function list(p) {
        return _get('/seller/acts', p);
      },
      get: function get(id) {
        return _get("/seller/acts/".concat(id));
      }
    },
    billing: function billing(p) {
      return _get('/seller/billing', p);
    },
    billingBalance: function billingBalance() {
      return _get('/seller/billing/balance');
    },
    billingInvoices: function billingInvoices(p) {
      return _get('/seller/billing/invoices', p);
    },
    billingInvoice: function billingInvoice(id) {
      return _get("/seller/billing/invoices/".concat(id));
    },
    wbWarehouses: {
      list: function list() {
        return _get('/seller/wb-warehouses');
      },
      sync: function sync() {
        return post('/seller/wb-warehouses/sync');
      },
      update: function update(id, data) {
        return patch("/seller/wb-warehouses/".concat(id), data);
      },
      setReserve: function setReserve(reservePct) {
        return patch('/seller/wb-warehouses/settings/reserve', {
          reserve_pct: reservePct
        });
      }
    },
    stockByWarehouse: function stockByWarehouse() {
      return _get('/seller/stock-by-warehouse');
    }
  };

  // ─────────────── Platform (Owner-admin) ───────────────

  var PLATFORM_TOKEN_KEY = 'wms2_platform_token';
  function getPlatformToken() {
    return localStorage.getItem(PLATFORM_TOKEN_KEY);
  }
  function savePlatformAuth(token) {
    localStorage.setItem(PLATFORM_TOKEN_KEY, token);
  }
  function clearPlatformAuth() {
    localStorage.removeItem(PLATFORM_TOKEN_KEY);
  }
  function isPlatformLoggedIn() {
    return !!getPlatformToken();
  }
  function platformRequest(_x3, _x4) {
    return _platformRequest.apply(this, arguments);
  }
  function _platformRequest() {
    _platformRequest = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee9(method, path) {
      var data,
        token,
        headers,
        res,
        json,
        _args9 = arguments;
      return _regenerator().w(function (_context9) {
        while (1) switch (_context9.n) {
          case 0:
            data = _args9.length > 2 && _args9[2] !== undefined ? _args9[2] : null;
            token = getPlatformToken();
            headers = {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-cache'
            };
            if (token) headers['Authorization'] = "Bearer ".concat(token);
            _context9.n = 1;
            return fetch("".concat(API_BASE).concat(path), {
              method: method,
              headers: headers,
              cache: 'no-store',
              body: data ? JSON.stringify(data) : undefined
            });
          case 1:
            res = _context9.v;
            _context9.n = 2;
            return res.json().catch(function () {
              return {};
            });
          case 2:
            json = _context9.v;
            if (res.ok) {
              _context9.n = 3;
              break;
            }
            throw new Error(json && json.error && json.error.message || "HTTP ".concat(res.status));
          case 3:
            return _context9.a(2, json);
        }
      }, _callee9);
    }));
    return _platformRequest.apply(this, arguments);
  }
  var platform = {
    login: function login(username, password) {
      return _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee5() {
        var res;
        return _regenerator().w(function (_context5) {
          while (1) switch (_context5.n) {
            case 0:
              _context5.n = 1;
              return platformRequest('POST', '/auth/platform/login', {
                username: username,
                password: password
              });
            case 1:
              res = _context5.v;
              if (res && res.token) savePlatformAuth(res.token);
              return _context5.a(2, res);
          }
        }, _callee5);
      }))();
    },
    logout: function logout() {
      clearPlatformAuth();
    },
    isLoggedIn: isPlatformLoggedIn,
    // Публичная самостоятельная регистрация — без авторизации, обычный post()
    register: function register(data) {
      return post('/platform/register', data);
    },
    tenants: {
      list: function list(p) {
        return platformRequest('GET', "/platform/tenants".concat(p ? '?' + new URLSearchParams(p) : ''));
      },
      get: function get(id) {
        return platformRequest('GET', "/platform/tenants/".concat(id));
      },
      create: function create(d) {
        return platformRequest('POST', '/platform/tenants', d);
      },
      update: function update(id, d) {
        return platformRequest('PATCH', "/platform/tenants/".concat(id), d);
      },
      setModule: function setModule(id, d) {
        return platformRequest('POST', "/platform/tenants/".concat(id, "/modules"), d);
      },
      extend: function extend(id, d) {
        return platformRequest('POST', "/platform/tenants/".concat(id, "/extend"), d);
      },
      subscriptions: function subscriptions(id) {
        return platformRequest('GET', "/platform/tenants/".concat(id, "/subscriptions"));
      },
      impersonate: function impersonate(id) {
        return platformRequest('POST', "/platform/tenants/".concat(id, "/impersonate"));
      }
    },
    plans: function plans() {
      return platformRequest('GET', '/platform/plans');
    },
    modules: function modules() {
      return platformRequest('GET', '/platform/modules');
    },
    stats: function stats() {
      return platformRequest('GET', '/platform/stats');
    },
    wbTariffs: {
      get: function get() {
        return platformRequest('GET', '/platform/wb-tariffs');
      },
      setToken: function setToken(api_token) {
        return platformRequest('PUT', '/platform/wb-tariffs/token', {
          api_token: api_token
        });
      },
      refresh: function refresh() {
        return platformRequest('POST', '/platform/wb-tariffs/refresh');
      }
    }
  };

  // ─────────────── Export ───────────────

  window.API = {
    // Core
    get: _get,
    post: post,
    patch: patch,
    put: put,
    del: del,
    request: request,
    // Auth
    auth: auth,
    getToken: getToken,
    getUser: getUser,
    saveAuth: saveAuth,
    clearAuth: clearAuth,
    isLoggedIn: isLoggedIn,
    // Modules
    users: users,
    clients: clients,
    warehouses: warehouses,
    items: items,
    locations: locations,
    stock: stock,
    inbound: inbound,
    receiving: receiving,
    placement: placement,
    movement: movement,
    inventory: inventory,
    picking: picking,
    packing: packing,
    shipping: shipping,
    wb: wb,
    printing: printing,
    overview: overview,
    workstations: workstations,
    checkin: checkin,
    billing: billing,
    consumables: consumables,
    payroll: payroll,
    marking: marking,
    returns: returns,
    seller: seller,
    platform: platform,
    tenant: tenant,
    acts: acts,
    fbsAnalytics: fbsAnalytics,
    deficit: deficit
  };
})(window);