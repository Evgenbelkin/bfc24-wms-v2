function _regenerator() { /*! regenerator-runtime -- Copyright (c) 2014-present, Facebook, Inc. -- license (MIT): https://github.com/babel/babel/blob/main/packages/babel-helpers/LICENSE */ var e, t, r = "function" == typeof Symbol ? Symbol : {}, n = r.iterator || "@@iterator", o = r.toStringTag || "@@toStringTag"; function i(r, n, o, i) { var c = n && n.prototype instanceof Generator ? n : Generator, u = Object.create(c.prototype); return _regeneratorDefine2(u, "_invoke", function (r, n, o) { var i, c, u, f = 0, p = o || [], y = !1, G = { p: 0, n: 0, v: e, a: d, f: d.bind(e, 4), d: function d(t, r) { return i = t, c = 0, u = e, G.n = r, a; } }; function d(r, n) { for (c = r, u = n, t = 0; !y && f && !o && t < p.length; t++) { var o, i = p[t], d = G.p, l = i[2]; r > 3 ? (o = l === n) && (u = i[(c = i[4]) ? 5 : (c = 3, 3)], i[4] = i[5] = e) : i[0] <= d && ((o = r < 2 && d < i[1]) ? (c = 0, G.v = n, G.n = i[1]) : d < l && (o = r < 3 || i[0] > n || n > l) && (i[4] = r, i[5] = n, G.n = l, c = 0)); } if (o || r > 1) return a; throw y = !0, n; } return function (o, p, l) { if (f > 1) throw TypeError("Generator is already running"); for (y && 1 === p && d(p, l), c = p, u = l; (t = c < 2 ? e : u) || !y;) { i || (c ? c < 3 ? (c > 1 && (G.n = -1), d(c, u)) : G.n = u : G.v = u); try { if (f = 2, i) { if (c || (o = "next"), t = i[o]) { if (!(t = t.call(i, u))) throw TypeError("iterator result is not an object"); if (!t.done) return t; u = t.value, c < 2 && (c = 0); } else 1 === c && (t = i.return) && t.call(i), c < 2 && (u = TypeError("The iterator does not provide a '" + o + "' method"), c = 1); i = e; } else if ((t = (y = G.n < 0) ? u : r.call(n, G)) !== a) break; } catch (t) { i = e, c = 1, u = t; } finally { f = 1; } } return { value: t, done: y }; }; }(r, o, i), !0), u; } var a = {}; function Generator() {} function GeneratorFunction() {} function GeneratorFunctionPrototype() {} t = Object.getPrototypeOf; var c = [][n] ? t(t([][n]())) : (_regeneratorDefine2(t = {}, n, function () { return this; }), t), u = GeneratorFunctionPrototype.prototype = Generator.prototype = Object.create(c); function f(e) { return Object.setPrototypeOf ? Object.setPrototypeOf(e, GeneratorFunctionPrototype) : (e.__proto__ = GeneratorFunctionPrototype, _regeneratorDefine2(e, o, "GeneratorFunction")), e.prototype = Object.create(u), e; } return GeneratorFunction.prototype = GeneratorFunctionPrototype, _regeneratorDefine2(u, "constructor", GeneratorFunctionPrototype), _regeneratorDefine2(GeneratorFunctionPrototype, "constructor", GeneratorFunction), GeneratorFunction.displayName = "GeneratorFunction", _regeneratorDefine2(GeneratorFunctionPrototype, o, "GeneratorFunction"), _regeneratorDefine2(u), _regeneratorDefine2(u, o, "Generator"), _regeneratorDefine2(u, n, function () { return this; }), _regeneratorDefine2(u, "toString", function () { return "[object Generator]"; }), (_regenerator = function _regenerator() { return { w: i, m: f }; })(); }
function _regeneratorDefine2(e, r, n, t) { var i = Object.defineProperty; try { i({}, "", {}); } catch (e) { i = 0; } _regeneratorDefine2 = function _regeneratorDefine(e, r, n, t) { function o(r, n) { _regeneratorDefine2(e, r, function (e) { return this._invoke(r, n, e); }); } r ? i ? i(e, r, { value: n, enumerable: !t, configurable: !t, writable: !t }) : e[r] = n : (o("next", 0), o("throw", 1), o("return", 2)); }, _regeneratorDefine2(e, r, n, t); }
function asyncGeneratorStep(n, t, e, r, o, a, c) { try { var i = n[a](c), u = i.value; } catch (n) { return void e(n); } i.done ? t(u) : Promise.resolve(u).then(r, o); }
function _asyncToGenerator(n) { return function () { var t = this, e = arguments; return new Promise(function (r, o) { var a = n.apply(t, e); function _next(n) { asyncGeneratorStep(a, r, o, _next, _throw, "next", n); } function _throw(n) { asyncGeneratorStep(a, r, o, _next, _throw, "throw", n); } _next(void 0); }); }; }
function _toConsumableArray(r) { return _arrayWithoutHoles(r) || _iterableToArray(r) || _unsupportedIterableToArray(r) || _nonIterableSpread(); }
function _nonIterableSpread() { throw new TypeError("Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method."); }
function _unsupportedIterableToArray(r, a) { if (r) { if ("string" == typeof r) return _arrayLikeToArray(r, a); var t = {}.toString.call(r).slice(8, -1); return "Object" === t && r.constructor && (t = r.constructor.name), "Map" === t || "Set" === t ? Array.from(r) : "Arguments" === t || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(t) ? _arrayLikeToArray(r, a) : void 0; } }
function _iterableToArray(r) { if ("undefined" != typeof Symbol && null != r[Symbol.iterator] || null != r["@@iterator"]) return Array.from(r); }
function _arrayWithoutHoles(r) { if (Array.isArray(r)) return _arrayLikeToArray(r); }
function _arrayLikeToArray(r, a) { (null == a || a > r.length) && (a = r.length); for (var e = 0, n = Array(a); e < a; e++) n[e] = r[e]; return n; }
/**
 * BFC24 WMS v2 — Shared UI Utilities
 */
(function (window) {
  'use strict';

  // ─────────────── Notifications ───────────────
  var toastContainer = null;
  function getToastContainer() {
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.id = 'toast-container';
      toastContainer.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;';
      document.body.appendChild(toastContainer);
    }
    return toastContainer;
  }
  function toast(message) {
    var type = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 'info';
    var durationMs = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : 3000;
    var colors = {
      success: '#22c55e',
      error: '#ef4444',
      warning: '#f59e0b',
      info: '#3b82f6'
    };
    var el = document.createElement('div');
    el.style.cssText = "background:".concat(colors[type] || colors.info, ";color:#fff;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,0.2);max-width:90vw;text-align:center;pointer-events:auto;animation:fadeIn .15s ease;");
    el.textContent = message;
    getToastContainer().appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transition = 'opacity .3s';
      setTimeout(function () {
        return el.remove();
      }, 300);
    }, durationMs);
  }
  var notify = {
    ok: function ok(msg, ms) {
      return toast(msg, 'success', ms);
    },
    err: function err(msg, ms) {
      return toast(msg, 'error', ms || 5000);
    },
    warn: function warn(msg, ms) {
      return toast(msg, 'warning', ms);
    },
    info: function info(msg, ms) {
      return toast(msg, 'info', ms);
    }
  };

  // ─────────────── DOM helpers ───────────────

  function el(selector) {
    return document.querySelector(selector);
  }
  function els(selector) {
    return _toConsumableArray(document.querySelectorAll(selector));
  }
  function show(selector) {
    var e = el(selector);
    if (e) e.style.display = '';
  }
  function hide(selector) {
    var e = el(selector);
    if (e) e.style.display = 'none';
  }
  function setText(selector, text) {
    var e = el(selector);
    if (e) e.textContent = text;
  }
  function setHTML(selector, html) {
    var e = el(selector);
    if (e) e.innerHTML = html;
  }
  function val(selector) {
    var e = el(selector);
    return e ? e.value.trim() : '';
  }
  function setVal(selector, v) {
    var e = el(selector);
    if (e) e.value = v || '';
  }
  function disable(selector) {
    var e = el(selector);
    if (e) e.disabled = true;
  }
  function enable(selector) {
    var e = el(selector);
    if (e) e.disabled = false;
  }
  function escHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Похоже ли значение на код "Честный знак" (КИЗ), а не на обычный
  // товарный штрихкод - зеркалит isValidKizCode из server/src/utils/
  // validators.js (см. там подробный комментарий про длину GS1 DataMatrix).
  // Используется в полях сканирования КИЗ, чтобы отсекать промах мимо поля
  // ДО похода на сервер - сразу гудок ошибки и понятное сообщение.
  function isValidKizCode(str) {
    return String(str || '').trim().length >= 25;
  }

  // Проверка структуры (не только длины) — зеркалит hasValidKizStructure из
  // server/src/utils/validators.js. Два варианта: лёгкая промышленность
  // (одежда) — фиксированные длины полей, разделитель GS1 не нужен вовсе,
  // весь код ровно 83 символа; остальные категории — переменный серийный
  // номер, первый разделитель (0x1D) после него ОБЯЗАТЕЛЕН, второй (перед
  // AI92) — опционален, некоторые кодировщики его тоже ставят, оба варианта
  // валидны. Реальный инцидент показал, что скан камерой телефона может
  // выдать код без обязательного первого разделителя — такой потом отклонит WB.
  // Даёт мгновенную обратную связь прямо в браузере, не дожидаясь сервера.
  function hasValidKizStructure(str) {
    var s = String(str || '').trim();
    if (/^\]d2/i.test(s)) s = s.slice(3);
    if (s.charCodeAt(0) === 0x1d) s = s.slice(1);
    if (!/^01\d{14}21/.test(s)) return false;
    var rest = s.slice(18);
    if (/^.{13}91.{4}92.{44}$/.test(rest) && rest.indexOf('\x1d') === -1) return true;
    var gsIdx = rest.indexOf('\x1d');
    if (gsIdx === -1) return false;
    var serial = rest.slice(0, gsIdx);
    if (!serial) return false;
    var tail = rest.slice(gsIdx + 1).replace(/\x1d/g, '');
    return /^91.{4}92.{44}$/.test(tail);
  }

  // ─────────────── Loading state ───────────────

  function setLoading(selector, isLoading, originalText) {
    var e = el(selector);
    if (!e) return;
    if (isLoading) {
      e._orig = e.textContent;
      e.textContent = 'Загрузка...';
      e.disabled = true;
    } else {
      e.textContent = originalText || e._orig || 'OK';
      e.disabled = false;
    }
  }

  // ─────────────── Tables ───────────────

  function renderTable(tbodySelector, rows, renderRow) {
    var tbody = el(tbodySelector);
    if (!tbody) return;
    if (!rows || !rows.length) {
      tbody.innerHTML = "<tr><td colspan=\"99\" style=\"text-align:center;color:#64748b;padding:24px;\">\u041D\u0435\u0442 \u0434\u0430\u043D\u043D\u044B\u0445</td></tr>";
      return;
    }
    tbody.innerHTML = rows.map(renderRow).join('');
  }

  // ─────────────── Auth guard ───────────────

  function requireAuth() {
    var redirectTo = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : '/app/login.html';
    if (!window.API || !window.API.isLoggedIn()) {
      window.location.href = redirectTo;
      return false;
    }
    return true;
  }
  function requireRole(allowedRoles) {
    var user = window.API && window.API.getUser();
    if (!user) return false;
    if (typeof allowedRoles === 'string') allowedRoles = [allowedRoles];
    // Мульти-роли: у пользователя может быть несколько ролей одновременно
    // (основная + доп., см. users.html) — пропускаем, если есть пересечение.
    var userRoles = user.roles && user.roles.length ? user.roles : [user.role];
    return userRoles.includes('tenant_admin') || allowedRoles.some(function (r) {
      return userRoles.includes(r);
    });
  }

  // ─────────────── Formatters ───────────────

  function fmtDate(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    });
  }
  function fmtDateTime(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
  function fmtMoney(num) {
    var currency = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 'RUB';
    return new Intl.NumberFormat('ru-RU', {
      style: 'currency',
      currency: currency
    }).format(Number(num || 0));
  }
  function fmtQty(n) {
    return Number(n || 0).toLocaleString('ru-RU');
  }

  // ─────────────── Звук при сканировании ───────────────
  // Один AudioContext на всю страницу (создавать новый на каждый бип и
  // расточительно, и в некоторых браузерах есть лимит на количество). Короткий
  // писк, как у обычного ТСД/кассового сканера — подтверждает, что код реально
  // считан, до того как успеет прийти ответ сервера. tone='ok' — короткий
  // высокий; tone='err' — чуть ниже и длиннее, для неудачного скана (совпадает
  // по смыслу с notify.err рядом).
  var _audioCtx = null;
  function beep(tone) {
    try {
      if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(function () {});
      var isErr = tone === 'err';
      var now = _audioCtx.currentTime;
      var baseFreq = isErr ? 300 : 1700;
      var hold = isErr ? 0.2 : 0.16;
      var tail = 0.06;

      // Компрессор + make-up gain — тот же приём, что и в громких уведомлениях:
      // сначала "сплющиваем" динамику (компрессор), потом поднимаем общий
      // уровень выше исходного пика (makeup) — цифровой сигнал становится
      // громче на слух, чем просто одна нота на полной громкости.
      var comp = _audioCtx.createDynamicsCompressor();
      comp.threshold.setValueAtTime(-24, now);
      comp.knee.setValueAtTime(6, now);
      comp.ratio.setValueAtTime(12, now);
      comp.attack.setValueAtTime(0.001, now);
      comp.release.setValueAtTime(0.05, now);
      var makeup = _audioCtx.createGain();
      makeup.gain.setValueAtTime(4, now);
      comp.connect(makeup).connect(_audioCtx.destination);

      // Две гармоники (основная + октава выше) звучат громче и "плотнее" на
      // маленьком динамике телефона, чем одна чистая нота той же амплитуды.
      [baseFreq, baseFreq * 2].forEach(function (freq, i) {
        var osc = _audioCtx.createOscillator();
        var gain = _audioCtx.createGain();
        osc.type = 'square';
        osc.frequency.value = freq;
        var peak = i === 0 ? 0.9 : 0.4;
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(peak, now + 0.005); // без щелчка на старте
        gain.gain.setValueAtTime(peak, now + hold);
        gain.gain.exponentialRampToValueAtTime(0.001, now + hold + tail);
        osc.connect(gain).connect(comp);
        osc.start(now);
        osc.stop(now + hold + tail + 0.02);
      });
    } catch (_) {/* звук не критичен для работы - тихо игнорируем (например, если Web Audio недоступен) */}
  }

  // ─────────────── Голосовое сопровождение (Web Speech API) ───────────────
  // Проговаривает короткие фразы ("Принято", "Ошибка", "Отсканируйте товар")
  // синтезом речи браузера — не нужен сервер/интернет-API, работает в Chrome
  // из коробки. Включено по умолчанию, но это личная настройка КОНКРЕТНОГО
  // рабочего места/устройства (не сотрудника и не тенанта) — на одном столе
  // упаковки голос может мешать, на другом наоборот нужен - поэтому храним
  // переключатель в localStorage этого браузера, а не в БД.
  var VOICE_STORAGE_KEY = 'wms_voice_enabled';
  function voiceEnabled() {
    var v = localStorage.getItem(VOICE_STORAGE_KEY);
    return v === null ? true : v === '1';
  }
  function setVoiceEnabled(on) {
    localStorage.setItem(VOICE_STORAGE_KEY, on ? '1' : '0');
  }
  function toggleVoice() {
    var next = !voiceEnabled();
    setVoiceEnabled(next);
    if (next) speak('Голос включён');
    return next;
  }

  // Браузер обычно даёт на выбор НЕСКОЛЬКО голосов для русского - локальный
  // системный (SAPI на Windows и т.п., звучит грубо/невнятно - похоже на это
  // и жаловались: "короб" слышится как "краб") и "облачный" (в Chrome обычно
  // содержит "Google" в названии - звучит заметно чище и понятнее). Явно
  // выбираем такой, если он есть, вместо того чтобы полагаться на выбор
  // браузера по умолчанию (Chrome по умолчанию нередко берёт как раз
  // локальный). Список голосов иногда грузится асинхронно (пустой при первом
  // обращении) - подписываемся на voiceschanged и кэшируем результат.
  var _cachedVoices = null;
  function pickRuVoice() {
    if (!window.speechSynthesis) return null;
    var voices = _cachedVoices || window.speechSynthesis.getVoices();
    if (!voices || !voices.length) return null;
    _cachedVoices = voices;
    var ru = voices.filter(function (v) {
      return /^ru/i.test(v.lang);
    });
    if (!ru.length) return null;
    return ru.find(function (v) {
      return /google/i.test(v.name);
    }) || ru.find(function (v) {
      return /online|natural|neural/i.test(v.name);
    }) || ru[0];
  }
  if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = function () {
      _cachedVoices = window.speechSynthesis.getVoices();
    };
  }
  function speak(text) {
    try {
      if (!voiceEnabled()) return;
      if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) return;
      // Обрываем предыдущую фразу, если она ещё договаривается - иначе при
      // частых сканах фразы копятся в очереди и голос начинает отставать от
      // реальных действий на экране.
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(String(text || ''));
      u.lang = 'ru-RU';
      // Чуть медленнее обычного (1.0) - на скорости 1.05+ голоса низкого
      // качества "смазывают" окончания слов, из-за чего "короб" превращается
      // в невнятное "краб".
      u.rate = 0.92;
      u.pitch = 1;
      var voice = pickRuVoice();
      if (voice) u.voice = voice;
      window.speechSynthesis.speak(u);
    } catch (_) {/* синтез речи не критичен - тихо игнорируем */}
  }

  // ─────────────── Scanner input helper ───────────────
  // TSD-friendly: Enter-triggered scan

  // На части ТСД (например Атол Smart.Lite со старым WebView) атрибут
  // inputmode="none" на самих полях не подавляет экранную клавиатуру -
  // она всё равно всплывает при каждом фокусе, хотя ввод идёт только со
  // сканера. Стандартный кросс-браузерный трюк: сделать поле readonly
  // ПЕРЕД focus() (тогда Android не показывает клавиатуру) и сразу же
  // снять readonly (тогда поле снова принимает ввод от сканера/клавиатуры).
  function focusNoKeyboard(input) {
    if (!input) return;
    try {
      input.setAttribute('readonly', 'readonly');
      input.focus();
      setTimeout(function () {
        input.removeAttribute('readonly');
      }, 50);
    } catch (e) {
      input.focus();
    }
  }

  function onScan(inputSelector, callback) {
    var input = el(inputSelector);
    if (!input) return;
    input.addEventListener('keydown', /*#__PURE__*/function () {
      var _ref = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee(e) {
        var value, _t;
        return _regenerator().w(function (_context) {
          while (1) switch (_context.p = _context.n) {
            case 0:
              if (!(e.key === 'Enter')) {
                _context.n = 6;
                break;
              }
              value = input.value.trim();
              if (value) {
                _context.n = 1;
                break;
              }
              return _context.a(2);
            case 1:
              beep('ok');
              input.value = '';
              input.blur();
              _context.p = 2;
              _context.n = 3;
              return callback(value);
            case 3:
              _context.n = 5;
              break;
            case 4:
              _context.p = 4;
              _t = _context.v;
              beep('err');
              notify.err(_t.message);
            case 5:
              // Раньше это поле ВСЕГДА забирало фокус обратно себе через 300мс — удобно
              // для "сканируем в одно и то же поле подряд" (сборка/упаковка), но ломает
              // страницы, где колбэк намеренно переводит фокус на СЛЕДУЮЩЕЕ поле в цепочке
              // (например, приёмка: штрихкод → ячейка → DataMatrix) — через 300мс фокус
              // выдёргивался обратно на это поле, и оператору приходилось тыкать пальцем
              // в нужное поле вручную. Теперь: если колбэк уже переставил фокус на что-то
              // другое (а не оставил его на body/на этом же инпуте после blur()) — уважаем
              // это и ничего не трогаем.
              setTimeout(function () {
                var active = document.activeElement;
                if (!active || active === document.body || active === input) {
                  focusNoKeyboard(input);
                }
              }, 300);
            case 6:
              return _context.a(2);
          }
        }, _callee, null, [[2, 4]]);
      }));
      return function (_x) {
        return _ref.apply(this, arguments);
      };
    }());
    // Автофокус
    setTimeout(function () {
      focusNoKeyboard(input);
    }, 100);
  }

  // ─────────────── Camera scan → same code path as TSD/keyboard scan ───────────────
  // Открывает Scanner (камера), кладёт результат в поле и симулирует Enter —
  // так один и тот же onScan()-обработчик работает и для ТСД, и для камеры, и для руками введённого кода.

  function scanInto(inputSelector, title) {
    if (!window.Scanner) {
      notify.err('Модуль камеры-сканера не загружен');
      return;
    }
    Scanner.open({
      title: title || 'Сканирование',
      onResult: function onResult(code) {
        var input = el(inputSelector);
        if (!input) return;
        input.value = code;
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true
        }));
      }
    });
  }

  // ─────────────── Select population ───────────────

  function populateSelect(selector, items) {
    var _ref2 = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {},
      _ref2$valueKey = _ref2.valueKey,
      valueKey = _ref2$valueKey === void 0 ? 'id' : _ref2$valueKey,
      _ref2$labelKey = _ref2.labelKey,
      labelKey = _ref2$labelKey === void 0 ? 'client_name' : _ref2$labelKey,
      _ref2$emptyLabel = _ref2.emptyLabel,
      emptyLabel = _ref2$emptyLabel === void 0 ? '— Выберите —' : _ref2$emptyLabel;
    var sel = el(selector);
    if (!sel) return;
    sel.innerHTML = "<option value=\"\">".concat(emptyLabel, "</option>") + (items || []).map(function (item) {
      return "<option value=\"".concat(escHtml(item[valueKey]), "\">").concat(escHtml(item[labelKey]), "</option>");
    }).join('');
  }

  // ─────────────── Confirm dialog ───────────────

  function confirm(message) {
    return window.confirm(message);
  }

  // ─────────────── CSS injection ───────────────

  var styleTag = document.createElement('style');
  styleTag.textContent = "@keyframes fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}";
  document.head.appendChild(styleTag);

  // ─────────────── Назад на предыдущий экран ───────────────
  // Экраны могут ссылаться друг на друга с ?from=<ключ> (Табло → любой раздел,
  // Диспетчерская → детали отгрузки и т.п.). Без этого пришлось бы каждый раз
  // возвращаться в общее меню и заново открывать нужный экран — просто
  // подменяем "← Меню" на "← <откуда пришли>" в шапке. Работает автоматически
  // на любой странице, где подключён этот файл (ui.js идёт после разметки
  // шапки, элемент уже есть в DOM).
  var BACK_TARGETS = {
    overview: {
      href: '/app/overview-board.html',
      label: '← Табло'
    },
    'admin-dashboard': {
      href: '/app/admin-dashboard.html',
      label: '← Диспетчерская'
    }
  };
  try {
    var params = new URLSearchParams(window.location.search);
    var target = BACK_TARGETS[params.get('from')];
    if (target) {
      var back = document.querySelector('.header a.btn-back');
      if (back) {
        back.href = target.href;
        back.textContent = target.label;
      }
    }
  } catch (_) {/* ignore */}

  // ─────────────── Плашка "вошли как клиент" ───────────────
  // Владелец платформы может зайти на склад клиента одной кнопкой из
  // /platform/dashboard.html ("Войти на склад клиента") — тогда backend
  // помечает user.impersonated=true. Этот флаг живёт в localStorage вместе
  // с остальным user-объектом и НЕ теряется при тихом обновлении access-токена
  // (silent-refresh в api.js трогает только сами токены, не wms2_user), так что
  // плашка держится всю сессию, пока явно не выйти. Показываем на каждом
  // экране склада — чтобы не забыть, что это чужие реальные данные, и не
  // тыкать там что попало "просто посмотреть".
  try {
    var _u = window.API && window.API.getUser && window.API.getUser();
    if (_u && _u.impersonated) {
      var bar = document.createElement('div');
      bar.id = 'impersonation-banner';
      bar.style.cssText = 'position:sticky;top:0;z-index:99999;background:#7c2d12;color:#fed7aa;' + 'padding:10px 14px;font-size:13px;font-weight:700;display:flex;align-items:center;' + 'justify-content:center;gap:12px;flex-wrap:wrap;text-align:center;border-bottom:2px solid #f97316;';
      bar.innerHTML = "\u26A0\uFE0F \u0420\u0435\u0436\u0438\u043C \u043F\u0440\u043E\u0441\u043C\u043E\u0442\u0440\u0430 \u043A\u043B\u0438\u0435\u043D\u0442\u0430 \xAB".concat(escHtml(_u.companyName || ''), "\xBB \u2014 \u0432\u0445\u043E\u0434 \u0447\u0435\u0440\u0435\u0437 \u043F\u0430\u043D\u0435\u043B\u044C \u043F\u043B\u0430\u0442\u0444\u043E\u0440\u043C\u044B, \u043D\u0438\u0447\u0435\u0433\u043E \u043D\u0435 \u043D\u0430\u0436\u0438\u043C\u0430\u0439\u0442\u0435 \u0437\u0440\u044F") + "<button id=\"impersonation-exit\" style=\"background:#f97316;color:#1a0a02;border:none;border-radius:6px;padding:4px 12px;font-weight:700;cursor:pointer;\">\u0412\u044B\u0439\u0442\u0438</button>";
      document.body.prepend(bar);
      document.getElementById('impersonation-exit').addEventListener('click', /*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee2() {
        var _t2;
        return _regenerator().w(function (_context2) {
          while (1) switch (_context2.p = _context2.n) {
            case 0:
              _context2.p = 0;
              _context2.n = 1;
              return window.API.auth.logout();
            case 1:
              _context2.n = 3;
              break;
            case 2:
              _context2.p = 2;
              _t2 = _context2.v;
            case 3:
              // Вкладка обычно открыта скриптом из панели платформы (window.open) —
              // после выхода её незачем оставлять открытой на экране логина чужого
              // клиента, просто закрываем. Если браузер не даст закрыть (бывает,
              // если вкладку успели перезагрузить руками) — тогда уже разлогиниваем
              // на экран входа как запасной вариант.
              window.close();
              setTimeout(function () {
                window.location.href = '/app/login.html';
              }, 300);
            case 4:
              return _context2.a(2);
          }
        }, _callee2, null, [[0, 2]]);
      })));
    }
  } catch (_) {/* ignore */}

  // ─────────────── Рабочее место (маршрутизация печати по столам/зонам) ───────────────
  // Сотрудник сканирует код своего рабочего места (стол упаковки, зона сборки,
  // зона отгрузки) один раз — дальше print_job на любой скан штрихкода уходит
  // именно на принтер этого места (см. server/.../printing/printerResolver.js),
  // а не на общий маршрут по типу документа на весь склад. Показываем узкую
  // плашку с текущим местом только на "рабочих" экранах, где сканирование
  // штрихкода реально создаёт print_job — там важно видеть, куда сейчас идёт
  // печать. На админ-панелях/логине/платформе плашка не показывается.
  var WORKSTATION_PAGES = ['packing', 'picking', 'shipping', 'receiving', 'placement', 'movement', 'inbound'];
  function initWorkstationBanner() {
    return _initWorkstationBanner.apply(this, arguments);
  }
  function _initWorkstationBanner() {
    _initWorkstationBanner = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee6() {
      var scan, render, page, u, header, _bar, _t6;
      return _regenerator().w(function (_context6) {
        while (1) switch (_context6.p = _context6.n) {
          case 0:
            _context6.p = 0;
            scan = function scan() {
              if (!window.Scanner) {
                notify.err('Модуль камеры-сканера не загружен');
                return;
              }
              Scanner.open({
                title: 'Скан кода рабочего места',
                onResult: function () {
                  var _onResult = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee4(code) {
                    var _t4;
                    return _regenerator().w(function (_context4) {
                      while (1) switch (_context4.p = _context4.n) {
                        case 0:
                          beep('ok');
                          _context4.p = 1;
                          _context4.n = 2;
                          return window.API.workstations.select(code);
                        case 2:
                          notify.ok('Рабочее место выбрано');
                          _context4.n = 3;
                          return render();
                        case 3:
                          _context4.n = 5;
                          break;
                        case 4:
                          _context4.p = 4;
                          _t4 = _context4.v;
                          beep('err');
                          notify.err(_t4.message);
                        case 5:
                          return _context4.a(2);
                      }
                    }, _callee4, null, [[1, 4]]);
                  }));
                  function onResult(_x2) {
                    return _onResult.apply(this, arguments);
                  }
                  return onResult;
                }()
              });
            };
            render = /*#__PURE__*/function () {
              var _ref5 = _asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee5() {
                var station, label, _t5;
                return _regenerator().w(function (_context5) {
                  while (1) switch (_context5.p = _context5.n) {
                    case 0:
                      station = null;
                      _context5.p = 1;
                      _context5.n = 2;
                      return window.API.workstations.my();
                    case 2:
                      station = _context5.v.station;
                      _context5.n = 4;
                      break;
                    case 3:
                      _context5.p = 3;
                      _t5 = _context5.v;
                    case 4:
                      label = station ? "\u0420\u0430\u0431\u043E\u0447\u0435\u0435 \u043C\u0435\u0441\u0442\u043E: <b style=\"color:var(--text,#0f172a);\">".concat(escHtml(station.station_name), "</b>") : "\u0420\u0430\u0431\u043E\u0447\u0435\u0435 \u043C\u0435\u0441\u0442\u043E \u043D\u0435 \u0432\u044B\u0431\u0440\u0430\u043D\u043E \u2014 \u043F\u0435\u0447\u0430\u0442\u044C \u043F\u043E\u0439\u0434\u0451\u0442 \u043F\u043E \u043E\u0431\u0449\u0435\u043C\u0443 \u043C\u0430\u0440\u0448\u0440\u0443\u0442\u0443 \u0441\u043A\u043B\u0430\u0434\u0430";
                      _bar.innerHTML = "<span>".concat(label, "</span>") + "<button id=\"ws-banner-scan\" style=\"background:var(--accent,#0284c7);color:#fff;border:none;border-radius:8px;padding:6px 12px;font-weight:700;font-size:12px;cursor:pointer;\">".concat(station ? 'Сменить' : 'Выбрать', "</button>");
                      document.getElementById('ws-banner-scan').addEventListener('click', scan);
                    case 5:
                      return _context5.a(2);
                  }
                }, _callee5, null, [[1, 3]]);
              }));
              return function render() {
                return _ref5.apply(this, arguments);
              };
            }();
            page = (window.location.pathname.split('/').pop() || '').replace(/\.html$/, '');
            if (WORKSTATION_PAGES.includes(page)) {
              _context6.n = 1;
              break;
            }
            return _context6.a(2);
          case 1:
            u = window.API && window.API.getUser && window.API.getUser();
            if (!(!u || u.role === 'seller' || !window.API.workstations)) {
              _context6.n = 2;
              break;
            }
            return _context6.a(2);
          case 2:
            header = document.querySelector('.header');
            if (header) {
              _context6.n = 3;
              break;
            }
            return _context6.a(2);
          case 3:
            _bar = document.createElement('div');
            _bar.id = 'workstation-banner';
            _bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;' + 'background:var(--card2,#f1f5f9);border:1px dashed var(--border,#e2e8f0);border-radius:10px;' + 'padding:8px 12px;margin:10px 0;font-size:13px;color:var(--muted,#64748b);flex-wrap:wrap;';
            header.insertAdjacentElement('afterend', _bar);
            _context6.n = 4;
            return render();
          case 4:
            _context6.n = 6;
            break;
          case 5:
            _context6.p = 5;
            _t6 = _context6.v;
          case 6:
            return _context6.a(2);
        }
      }, _callee6, null, [[0, 5]]);
    }));
    return _initWorkstationBanner.apply(this, arguments);
  }
  initWorkstationBanner();

  // ─────────────── Смена пароля ───────────────
  // Доступно любому залогиненному пользователю (сотрудник склада или seller) —
  // самостоятельная замена пароля, без обращения к владельцу платформы.
  // Бэкенд (POST /auth/change-password) уже существовал, но до этого нигде
  // не было экрана, который его вызывает.
  function openChangePasswordModal() {
    if (document.getElementById('cp-modal-overlay')) return; // уже открыта
    var overlay = document.createElement('div');
    overlay.id = 'cp-modal-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);z-index:9998;display:flex;align-items:center;justify-content:center;padding:16px;';
    var inputCss = 'width:100%;padding:12px 14px;background:var(--card2,#f1f5f9);border:2px solid var(--border,#e2e8f0);border-radius:10px;font-size:15px;outline:none;color:var(--text,#0f172a);box-sizing:border-box;';
    var labelCss = 'display:block;font-size:12px;font-weight:600;color:var(--muted,#64748b);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px;';
    overlay.innerHTML = "\n      <div style=\"background:var(--card,#fff);border-radius:16px;padding:22px;width:100%;max-width:380px;box-sizing:border-box;\">\n        <div style=\"font-size:16px;font-weight:700;margin-bottom:16px;color:var(--text,#0f172a);\">\u0421\u043C\u0435\u043D\u0438\u0442\u044C \u043F\u0430\u0440\u043E\u043B\u044C</div>\n        <div style=\"margin-bottom:12px;\">\n          <label style=\"".concat(labelCss, "\">\u0422\u0435\u043A\u0443\u0449\u0438\u0439 \u043F\u0430\u0440\u043E\u043B\u044C</label>\n          <input id=\"cp-current\" type=\"password\" autocomplete=\"current-password\" style=\"").concat(inputCss, "\"/>\n        </div>\n        <div style=\"margin-bottom:12px;\">\n          <label style=\"").concat(labelCss, "\">\u041D\u043E\u0432\u044B\u0439 \u043F\u0430\u0440\u043E\u043B\u044C</label>\n          <input id=\"cp-new\" type=\"password\" autocomplete=\"new-password\" style=\"").concat(inputCss, "\"/>\n        </div>\n        <div style=\"margin-bottom:16px;\">\n          <label style=\"").concat(labelCss, "\">\u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u043D\u043E\u0432\u044B\u0439 \u043F\u0430\u0440\u043E\u043B\u044C</label>\n          <input id=\"cp-new2\" type=\"password\" autocomplete=\"new-password\" style=\"").concat(inputCss, "\"/>\n        </div>\n        <div id=\"cp-error\" style=\"color:#dc2626;font-size:13px;margin-bottom:10px;display:none;\"></div>\n        <div style=\"display:flex;gap:10px;\">\n          <button id=\"cp-save\" style=\"flex:1;padding:13px;background:var(--accent,#0284c7);color:#fff;border:none;border-radius:10px;font-weight:700;font-size:15px;cursor:pointer;\">\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C</button>\n          <button id=\"cp-cancel\" style=\"flex:1;padding:13px;background:var(--card2,#f1f5f9);color:var(--text,#0f172a);border:2px solid var(--border,#e2e8f0);border-radius:10px;font-weight:700;font-size:15px;cursor:pointer;\">\u041E\u0442\u043C\u0435\u043D\u0430</button>\n        </div>\n      </div>\n    ");
    document.body.appendChild(overlay);
    var close = function close() {
      return overlay.remove();
    };
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });
    document.getElementById('cp-cancel').addEventListener('click', close);
    document.getElementById('cp-save').addEventListener('click', /*#__PURE__*/_asyncToGenerator(/*#__PURE__*/_regenerator().m(function _callee3() {
      var cur, nw, nw2, errEl, msg, _t3;
      return _regenerator().w(function (_context3) {
        while (1) switch (_context3.p = _context3.n) {
          case 0:
            cur = document.getElementById('cp-current').value;
            nw = document.getElementById('cp-new').value;
            nw2 = document.getElementById('cp-new2').value;
            errEl = document.getElementById('cp-error');
            errEl.style.display = 'none';
            if (!(!cur || !nw)) {
              _context3.n = 1;
              break;
            }
            errEl.textContent = 'Заполните оба пароля';
            errEl.style.display = 'block';
            return _context3.a(2);
          case 1:
            if (!(nw.length < 8)) {
              _context3.n = 2;
              break;
            }
            errEl.textContent = 'Новый пароль должен быть не короче 8 символов';
            errEl.style.display = 'block';
            return _context3.a(2);
          case 2:
            if (!(nw !== nw2)) {
              _context3.n = 3;
              break;
            }
            errEl.textContent = 'Новые пароли не совпадают';
            errEl.style.display = 'block';
            return _context3.a(2);
          case 3:
            _context3.p = 3;
            _context3.n = 4;
            return window.API.auth.changePassword(cur, nw);
          case 4:
            notify.ok('Пароль изменён');
            close();
            _context3.n = 6;
            break;
          case 5:
            _context3.p = 5;
            _t3 = _context3.v;
            msg = /current password is incorrect/i.test(_t3.message || '') ? 'Текущий пароль неверен' : _t3.message || 'Не удалось сменить пароль';
            errEl.textContent = msg;
            errEl.style.display = 'block';
          case 6:
            return _context3.a(2);
        }
      }, _callee3, null, [[3, 5]]);
    })));
  }

  // ─────────────── Export ───────────────

  window.UI = {
    toast: toast,
    notify: notify,
    el: el,
    els: els,
    show: show,
    hide: hide,
    setText: setText,
    setHTML: setHTML,
    val: val,
    setVal: setVal,
    disable: disable,
    enable: enable,
    escHtml: escHtml,
    isValidKizCode: isValidKizCode,
    hasValidKizStructure: hasValidKizStructure,
    setLoading: setLoading,
    renderTable: renderTable,
    requireAuth: requireAuth,
    requireRole: requireRole,
    fmtDate: fmtDate,
    fmtDateTime: fmtDateTime,
    fmtMoney: fmtMoney,
    fmtQty: fmtQty,
    onScan: onScan,
    scanInto: scanInto,
    focusNoKeyboard: focusNoKeyboard,
    populateSelect: populateSelect,
    confirm: confirm,
    openChangePasswordModal: openChangePasswordModal,
    beep: beep,
    speak: speak,
    voiceEnabled: voiceEnabled,
    setVoiceEnabled: setVoiceEnabled,
    toggleVoice: toggleVoice
  };
})(window);