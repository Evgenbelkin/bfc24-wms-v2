function _regenerator() { /*! regenerator-runtime -- Copyright (c) 2014-present, Facebook, Inc. -- license (MIT): https://github.com/babel/babel/blob/main/packages/babel-helpers/LICENSE */ var e, t, r = "function" == typeof Symbol ? Symbol : {}, n = r.iterator || "@@iterator", o = r.toStringTag || "@@toStringTag"; function i(r, n, o, i) { var c = n && n.prototype instanceof Generator ? n : Generator, u = Object.create(c.prototype); return _regeneratorDefine2(u, "_invoke", function (r, n, o) { var i, c, u, f = 0, p = o || [], y = !1, G = { p: 0, n: 0, v: e, a: d, f: d.bind(e, 4), d: function d(t, r) { return i = t, c = 0, u = e, G.n = r, a; } }; function d(r, n) { for (c = r, u = n, t = 0; !y && f && !o && t < p.length; t++) { var o, i = p[t], d = G.p, l = i[2]; r > 3 ? (o = l === n) && (u = i[(c = i[4]) ? 5 : (c = 3, 3)], i[4] = i[5] = e) : i[0] <= d && ((o = r < 2 && d < i[1]) ? (c = 0, G.v = n, G.n = i[1]) : d < l && (o = r < 3 || i[0] > n || n > l) && (i[4] = r, i[5] = n, G.n = l, c = 0)); } if (o || r > 1) return a; throw y = !0, n; } return function (o, p, l) { if (f > 1) throw TypeError("Generator is already running"); for (y && 1 === p && d(p, l), c = p, u = l; (t = c < 2 ? e : u) || !y;) { i || (c ? c < 3 ? (c > 1 && (G.n = -1), d(c, u)) : G.n = u : G.v = u); try { if (f = 2, i) { if (c || (o = "next"), t = i[o]) { if (!(t = t.call(i, u))) throw TypeError("iterator result is not an object"); if (!t.done) return t; u = t.value, c < 2 && (c = 0); } else 1 === c && (t = i.return) && t.call(i), c < 2 && (u = TypeError("The iterator does not provide a '" + o + "' method"), c = 1); i = e; } else if ((t = (y = G.n < 0) ? u : r.call(n, G)) !== a) break; } catch (t) { i = e, c = 1, u = t; } finally { f = 1; } } return { value: t, done: y }; }; }(r, o, i), !0), u; } var a = {}; function Generator() {} function GeneratorFunction() {} function GeneratorFunctionPrototype() {} t = Object.getPrototypeOf; var c = [][n] ? t(t([][n]())) : (_regeneratorDefine2(t = {}, n, function () { return this; }), t), u = GeneratorFunctionPrototype.prototype = Generator.prototype = Object.create(c); function f(e) { return Object.setPrototypeOf ? Object.setPrototypeOf(e, GeneratorFunctionPrototype) : (e.__proto__ = GeneratorFunctionPrototype, _regeneratorDefine2(e, o, "GeneratorFunction")), e.prototype = Object.create(u), e; } return GeneratorFunction.prototype = GeneratorFunctionPrototype, _regeneratorDefine2(u, "constructor", GeneratorFunctionPrototype), _regeneratorDefine2(GeneratorFunctionPrototype, "constructor", GeneratorFunction), GeneratorFunction.displayName = "GeneratorFunction", _regeneratorDefine2(GeneratorFunctionPrototype, o, "GeneratorFunction"), _regeneratorDefine2(u), _regeneratorDefine2(u, o, "Generator"), _regeneratorDefine2(u, n, function () { return this; }), _regeneratorDefine2(u, "toString", function () { return "[object Generator]"; }), (_regenerator = function _regenerator() { return { w: i, m: f }; })(); }
function _regeneratorDefine2(e, r, n, t) { var i = Object.defineProperty; try { i({}, "", {}); } catch (e) { i = 0; } _regeneratorDefine2 = function _regeneratorDefine(e, r, n, t) { function o(r, n) { _regeneratorDefine2(e, r, function (e) { return this._invoke(r, n, e); }); } r ? i ? i(e, r, { value: n, enumerable: !t, configurable: !t, writable: !t }) : e[r] = n : (o("next", 0), o("throw", 1), o("return", 2)); }, _regeneratorDefine2(e, r, n, t); }
function asyncGeneratorStep(n, t, e, r, o, a, c) { try { var i = n[a](c), u = i.value; } catch (n) { return void e(n); } i.done ? t(u) : Promise.resolve(u).then(r, o); }
function _asyncToGenerator(n) { return function () { var t = this, e = arguments; return new Promise(function (r, o) { var a = n.apply(t, e); function _next(n) { asyncGeneratorStep(a, r, o, _next, _throw, "next", n); } function _throw(n) { asyncGeneratorStep(a, r, o, _next, _throw, "throw", n); } _next(void 0); }); }; }
/**
 * BFC24 WMS v2 — Camera Scanner
 *
 * Сканирование штрихкодов/QR прямо с камеры телефона, без ТСД.
 * Использует нативный BarcodeDetector (Chrome/Edge/Android WebView).
 * Если браузер его не поддерживает (типично — iOS Safari) — модалка
 * всё равно открывается, но только с полем ручного ввода, ничего не ломается.
 *
 * Использование:
 *   Scanner.open({
 *     title: 'Скан ячейки',
 *     onResult: (code) => { ... },
 *     onCancel: () => { ... }, // необязательно
 *   });
 */
(function (window) {
  'use strict';

  // data_matrix добавлен отдельно — это формат кодов "Честный знак" (КИЗ),
  // без него камера телефона их физически не распознаёт, даже наведясь точно.
  var DEFAULT_FORMATS = ['code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code', 'code_39', 'data_matrix'];
  var currentStream = null;
  function vibrate(ms) {
    try {
      navigator.vibrate && navigator.vibrate(ms);
    } catch (_) {}
  }
  function stopStream() {
    if (currentStream) {
      currentStream.getTracks().forEach(function (t) {
        try {
          t.stop();
        } catch (_) {}
      });
      currentStream = null;
    }
  }
  function buildOverlay() {
    var overlay = document.createElement('div');
    overlay.id = 'scanner-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(2,6,23,.96);z-index:10000;' + 'display:flex;justify-content:center;padding:14px;overflow-y:auto;';
    overlay.innerHTML = "\n      <div style=\"width:100%;max-width:480px;display:flex;flex-direction:column;\">\n        <div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;\">\n          <div id=\"scanner-title\" style=\"color:#f1f5f9;font-size:16px;font-weight:700;\"></div>\n          <button id=\"scanner-close-btn\" type=\"button\"\n            style=\"background:#7f1d1d;color:#fca5a5;border:none;border-radius:8px;padding:10px 16px;font-weight:700;font-size:14px;\">\u2715 \u0417\u0430\u043A\u0440\u044B\u0442\u044C</button>\n        </div>\n        <div style=\"position:relative;width:100%;background:#000;border-radius:14px;overflow:hidden;min-height:200px;\">\n          <video id=\"scanner-video\" playsinline autoplay muted style=\"width:100%;display:block;\"></video>\n          <div style=\"position:absolute;left:10%;right:10%;top:30%;bottom:30%;border:3px solid rgba(56,189,248,.7);border-radius:12px;pointer-events:none;\"></div>\n        </div>\n        <div id=\"scanner-status\" style=\"color:#94a3b8;font-size:13px;text-align:center;margin:10px 0;min-height:18px;\"></div>\n        <div style=\"margin-top:8px;\">\n          <div style=\"color:#64748b;font-size:12px;margin-bottom:6px;\">\u041D\u0435 \u0441\u043A\u0430\u043D\u0438\u0440\u0443\u0435\u0442\u0441\u044F? \u0412\u0432\u0435\u0434\u0438\u0442\u0435 \u043A\u043E\u0434 \u0432\u0440\u0443\u0447\u043D\u0443\u044E:</div>\n          <div style=\"display:flex;gap:8px;\">\n            <input id=\"scanner-manual-input\" type=\"text\" placeholder=\"\u041A\u043E\u0434...\"\n              autocomplete=\"off\" autocapitalize=\"off\"\n              style=\"flex:1;padding:14px;background:#0f172a;border:2px solid #334155;border-radius:10px;color:#f1f5f9;font-size:16px;outline:none;\"/>\n            <button id=\"scanner-manual-btn\" type=\"button\"\n              style=\"padding:14px 20px;background:#2563eb;color:#fff;border:none;border-radius:10px;font-weight:700;font-size:15px;\">OK</button>\n          </div>\n        </div>\n      </div>\n    ";
    return overlay;
  }

  /**
   * @param {object} opts
   * @param {string} opts.title
   * @param {string[]} [opts.formats]
   * @param {(code:string)=>void} opts.onResult
   * @param {()=>void} [opts.onCancel]
   */
  function open(_x) {
    return _open.apply(this, arguments);
  }
  function _open() {
    _open = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee(opts) {
      var _t;
      return _regenerator().w(function (_context) {
        while (1) switch (_context.p = _context.n) {
          case 0:
            _context.p = 0;
            _context.n = 1;
            return openInternal(opts);
          case 1:
            _context.n = 3;
            break;
          case 2:
            _context.p = 2;
            _t = _context.v;
            // Что угодно неожиданное (querySelector вернул null, DOM ещё не готов и т.п.) —
            // не проглатываем молча, иначе снаружи выглядит как "кнопка ничего не делает".
            console.error('[Scanner.open] failed:', _t);
            if (window.UI && UI.notify) UI.notify.err('Не удалось открыть камеру: ' + (_t.message || _t));else alert('Не удалось открыть камеру: ' + (_t.message || _t));
          case 3:
            return _context.a(2);
        }
      }, _callee, null, [[0, 2]]);
    }));
    return _open.apply(this, arguments);
  }
  function openInternal(_x2) {
    return _openInternal.apply(this, arguments);
  }
  function _openInternal() {
    _openInternal = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee3(opts) {
      var _ref, _ref$title, title, _ref$formats, formats, onResult, onCancel, overlay, titleEl, statusEl, video, manualIn, manualBtn, closeBtn, closed, detecting, teardown, finish, cancel, stream, detector, _tick, _t3, _t4;
      return _regenerator().w(function (_context3) {
        while (1) switch (_context3.p = _context3.n) {
          case 0:
            cancel = function _cancel() {
              if (closed) return;
              closed = true;
              teardown();
              if (onCancel) onCancel();
            };
            finish = function _finish(value) {
              if (closed) return;
              closed = true;
              teardown();
              if (onResult) onResult(value);
            };
            teardown = function _teardown() {
              detecting = false;
              stopStream();
              overlay.remove();
            };
            _ref = opts || {}, _ref$title = _ref.title, title = _ref$title === void 0 ? 'Сканирование' : _ref$title, _ref$formats = _ref.formats, formats = _ref$formats === void 0 ? DEFAULT_FORMATS : _ref$formats, onResult = _ref.onResult, onCancel = _ref.onCancel;
            overlay = buildOverlay();
            document.body.appendChild(overlay);
            titleEl = overlay.querySelector('#scanner-title');
            statusEl = overlay.querySelector('#scanner-status');
            video = overlay.querySelector('#scanner-video');
            manualIn = overlay.querySelector('#scanner-manual-input');
            manualBtn = overlay.querySelector('#scanner-manual-btn');
            closeBtn = overlay.querySelector('#scanner-close-btn');
            titleEl.textContent = title;
            closed = false;
            detecting = false;
            closeBtn.addEventListener('click', cancel);
            manualBtn.addEventListener('click', function () {
              var v = manualIn.value.trim();
              if (v) finish(v);
            });
            manualIn.addEventListener('keydown', function (e) {
              if (e.key === 'Enter') {
                var v = manualIn.value.trim();
                if (v) finish(v);
              }
            });
            if ('BarcodeDetector' in window) {
              _context3.n = 1;
              break;
            }
            statusEl.textContent = 'Этот браузер не умеет сканировать камерой — используйте поле ввода ниже (или откройте страницу в Chrome на Android)';
            setTimeout(function () {
              return manualIn.focus();
            }, 150);
            return _context3.a(2);
          case 1:
            _context3.p = 1;
            _context3.n = 2;
            return navigator.mediaDevices.getUserMedia({
              video: {
                facingMode: {
                  ideal: 'environment'
                }
              },
              audio: false
            });
          case 2:
            stream = _context3.v;
            _context3.n = 4;
            break;
          case 3:
            _context3.p = 3;
            _t3 = _context3.v;
            statusEl.textContent = 'Нет доступа к камере (' + (_t3.name || _t3.message || 'ошибка') + ') — используйте поле ввода ниже';
            setTimeout(function () {
              return manualIn.focus();
            }, 150);
            return _context3.a(2);
          case 4:
            if (!closed) {
              _context3.n = 5;
              break;
            }
            // модалку успели закрыть, пока ждали разрешение камеры
            stream.getTracks().forEach(function (t) {
              return t.stop();
            });
            return _context3.a(2);
          case 5:
            currentStream = stream;
            video.srcObject = stream;
            _context3.p = 6;
            _context3.n = 7;
            return video.play();
          case 7:
            _context3.n = 9;
            break;
          case 8:
            _context3.p = 8;
            _t4 = _context3.v;
          case 9:
            try {
              detector = new window.BarcodeDetector({
                formats: formats
              });
            } catch (_) {
              detector = new window.BarcodeDetector();
            }
            detecting = true;
            statusEl.textContent = 'Наведите камеру на штрихкод или QR';
            _tick = /*#__PURE__*/function () {
              var _ref2 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee2() {
                var codes, _t2;
                return _regenerator().w(function (_context2) {
                  while (1) switch (_context2.p = _context2.n) {
                    case 0:
                      if (detecting) {
                        _context2.n = 1;
                        break;
                      }
                      return _context2.a(2);
                    case 1:
                      _context2.p = 1;
                      _context2.n = 2;
                      return detector.detect(video);
                    case 2:
                      codes = _context2.v;
                      if (!(codes && codes.length > 0 && codes[0].rawValue)) {
                        _context2.n = 3;
                        break;
                      }
                      vibrate(80);
                      finish(codes[0].rawValue);
                      return _context2.a(2);
                    case 3:
                      _context2.n = 5;
                      break;
                    case 4:
                      _context2.p = 4;
                      _t2 = _context2.v;
                    case 5:
                      if (detecting) requestAnimationFrame(_tick);
                    case 6:
                      return _context2.a(2);
                  }
                }, _callee2, null, [[1, 4]]);
              }));
              return function tick() {
                return _ref2.apply(this, arguments);
              };
            }();
            requestAnimationFrame(_tick);
          case 10:
            return _context3.a(2);
        }
      }, _callee3, null, [[6, 8], [1, 3]]);
    }));
    return _openInternal.apply(this, arguments);
  }
  window.Scanner = {
    open: open
  };
})(window);