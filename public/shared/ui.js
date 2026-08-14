/**
 * BFC24 WMS v2 — Shared UI Utilities
 */
(function (window) {
  'use strict';

  // ─────────────── Notifications ───────────────

  let toastContainer = null;

  function getToastContainer() {
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.id = 'toast-container';
      toastContainer.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;';
      document.body.appendChild(toastContainer);
    }
    return toastContainer;
  }

  function toast(message, type = 'info', durationMs = 3000) {
    const colors = { success: '#22c55e', error: '#ef4444', warning: '#f59e0b', info: '#3b82f6' };
    const el = document.createElement('div');
    el.style.cssText = `background:${colors[type]||colors.info};color:#fff;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,0.2);max-width:90vw;text-align:center;pointer-events:auto;animation:fadeIn .15s ease;`;
    el.textContent = message;
    getToastContainer().appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, durationMs);
  }

  const notify = {
    ok:   (msg, ms) => toast(msg, 'success', ms),
    err:  (msg, ms) => toast(msg, 'error', ms||5000),
    warn: (msg, ms) => toast(msg, 'warning', ms),
    info: (msg, ms) => toast(msg, 'info', ms),
  };

  // ─────────────── DOM helpers ───────────────

  function el(selector) { return document.querySelector(selector); }
  function els(selector) { return [...document.querySelectorAll(selector)]; }
  function show(selector) { const e = el(selector); if (e) e.style.display = ''; }
  function hide(selector) { const e = el(selector); if (e) e.style.display = 'none'; }
  function setText(selector, text) { const e = el(selector); if (e) e.textContent = text; }
  function setHTML(selector, html) { const e = el(selector); if (e) e.innerHTML = html; }
  function val(selector) { const e = el(selector); return e ? e.value.trim() : ''; }
  function setVal(selector, v) { const e = el(selector); if (e) e.value = v || ''; }
  function disable(selector) { const e = el(selector); if (e) e.disabled = true; }
  function enable(selector)  { const e = el(selector); if (e) e.disabled = false; }

  function escHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
  // server/src/utils/validators.js. Между серийным номером и следующим блоком
  // должен быть ровно один служебный байт-разделитель GS1 (0x1D) - реальный
  // инцидент показал, что скан камерой телефона может выдать код правильной
  // длины, но с потерянным/задвоенным разделителем, который потом отклонит
  // WB. Даёт мгновенную обратную связь прямо в браузере, не дожидаясь сервера.
  function hasValidKizStructure(str) {
    let s = String(str || '').trim();
    if (/^\]d2/i.test(s)) s = s.slice(3);
    if (s.charCodeAt(0) === 0x1d) s = s.slice(1);
    if (!/^01\d{14}21/.test(s)) return false;
    const gsCount = (s.match(/\x1d/g) || []).length;
    return gsCount === 1;
  }

  // ─────────────── Loading state ───────────────

  function setLoading(selector, isLoading, originalText) {
    const e = el(selector);
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
    const tbody = el(tbodySelector);
    if (!tbody) return;
    if (!rows || !rows.length) {
      tbody.innerHTML = `<tr><td colspan="99" style="text-align:center;color:#64748b;padding:24px;">Нет данных</td></tr>`;
      return;
    }
    tbody.innerHTML = rows.map(renderRow).join('');
  }

  // ─────────────── Auth guard ───────────────

  function requireAuth(redirectTo = '/app/login.html') {
    if (!window.API || !window.API.isLoggedIn()) {
      window.location.href = redirectTo;
      return false;
    }
    return true;
  }

  function requireRole(allowedRoles) {
    const user = window.API?.getUser();
    if (!user) return false;
    if (typeof allowedRoles === 'string') allowedRoles = [allowedRoles];
    // Мульти-роли: у пользователя может быть несколько ролей одновременно
    // (основная + доп., см. users.html) — пропускаем, если есть пересечение.
    const userRoles = user.roles && user.roles.length ? user.roles : [user.role];
    return userRoles.includes('tenant_admin') || allowedRoles.some(r => userRoles.includes(r));
  }

  // ─────────────── Formatters ───────────────

  function fmtDate(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('ru-RU', { day:'2-digit', month:'2-digit', year:'numeric' });
  }

  function fmtDateTime(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
  }

  function fmtMoney(num, currency = 'RUB') {
    return new Intl.NumberFormat('ru-RU', { style:'currency', currency }).format(Number(num||0));
  }

  function fmtQty(n) { return Number(n||0).toLocaleString('ru-RU'); }

  // ─────────────── Звук при сканировании ───────────────
  // Один AudioContext на всю страницу (создавать новый на каждый бип и
  // расточительно, и в некоторых браузерах есть лимит на количество). Короткий
  // писк, как у обычного ТСД/кассового сканера — подтверждает, что код реально
  // считан, до того как успеет прийти ответ сервера. tone='ok' — короткий
  // высокий; tone='err' — чуть ниже и длиннее, для неудачного скана (совпадает
  // по смыслу с notify.err рядом).
  let _audioCtx = null;
  function beep(tone) {
    try {
      if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(()=>{});
      const isErr = tone === 'err';
      const now = _audioCtx.currentTime;
      const baseFreq = isErr ? 300 : 1700;
      const hold = isErr ? 0.2 : 0.16;
      const tail = 0.06;

      // Компрессор + make-up gain — тот же приём, что и в громких уведомлениях:
      // сначала "сплющиваем" динамику (компрессор), потом поднимаем общий
      // уровень выше исходного пика (makeup) — цифровой сигнал становится
      // громче на слух, чем просто одна нота на полной громкости.
      const comp = _audioCtx.createDynamicsCompressor();
      comp.threshold.setValueAtTime(-24, now);
      comp.knee.setValueAtTime(6, now);
      comp.ratio.setValueAtTime(12, now);
      comp.attack.setValueAtTime(0.001, now);
      comp.release.setValueAtTime(0.05, now);
      const makeup = _audioCtx.createGain();
      makeup.gain.setValueAtTime(4, now);
      comp.connect(makeup).connect(_audioCtx.destination);

      // Две гармоники (основная + октава выше) звучат громче и "плотнее" на
      // маленьком динамике телефона, чем одна чистая нота той же амплитуды.
      [baseFreq, baseFreq * 2].forEach((freq, i) => {
        const osc = _audioCtx.createOscillator();
        const gain = _audioCtx.createGain();
        osc.type = 'square';
        osc.frequency.value = freq;
        const peak = i === 0 ? 0.9 : 0.4;
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(peak, now + 0.005); // без щелчка на старте
        gain.gain.setValueAtTime(peak, now + hold);
        gain.gain.exponentialRampToValueAtTime(0.001, now + hold + tail);
        osc.connect(gain).connect(comp);
        osc.start(now);
        osc.stop(now + hold + tail + 0.02);
      });
    } catch (_) { /* звук не критичен для работы - тихо игнорируем (например, если Web Audio недоступен) */ }
  }

  // ─────────────── Scanner input helper ───────────────
  // TSD-friendly: Enter-triggered scan

  function onScan(inputSelector, callback) {
    const input = el(inputSelector);
    if (!input) return;
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const value = input.value.trim();
        if (!value) return;
        beep('ok');
        input.value = '';
        input.blur();
        try { await callback(value); } catch(err) { beep('err'); notify.err(err.message); }
        // Раньше это поле ВСЕГДА забирало фокус обратно себе через 300мс — удобно
        // для "сканируем в одно и то же поле подряд" (сборка/упаковка), но ломает
        // страницы, где колбэк намеренно переводит фокус на СЛЕДУЮЩЕЕ поле в цепочке
        // (например, приёмка: штрихкод → ячейка → DataMatrix) — через 300мс фокус
        // выдёргивался обратно на это поле, и оператору приходилось тыкать пальцем
        // в нужное поле вручную. Теперь: если колбэк уже переставил фокус на что-то
        // другое (а не оставил его на body/на этом же инпуте после blur()) — уважаем
        // это и ничего не трогаем.
        setTimeout(() => {
          const active = document.activeElement;
          if (!active || active === document.body || active === input) {
            input.focus();
          }
        }, 300);
      }
    });
    // Автофокус
    setTimeout(() => { input.focus(); }, 100);
  }

  // ─────────────── Camera scan → same code path as TSD/keyboard scan ───────────────
  // Открывает Scanner (камера), кладёт результат в поле и симулирует Enter —
  // так один и тот же onScan()-обработчик работает и для ТСД, и для камеры, и для руками введённого кода.

  function scanInto(inputSelector, title) {
    if (!window.Scanner) { notify.err('Модуль камеры-сканера не загружен'); return; }
    Scanner.open({
      title: title || 'Сканирование',
      onResult: (code) => {
        const input = el(inputSelector);
        if (!input) return;
        input.value = code;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      },
    });
  }

  // ─────────────── Select population ───────────────

  function populateSelect(selector, items, { valueKey = 'id', labelKey = 'client_name', emptyLabel = '— Выберите —' } = {}) {
    const sel = el(selector);
    if (!sel) return;
    sel.innerHTML = `<option value="">${emptyLabel}</option>` +
      (items || []).map(item => `<option value="${escHtml(item[valueKey])}">${escHtml(item[labelKey])}</option>`).join('');
  }

  // ─────────────── Confirm dialog ───────────────

  function confirm(message) {
    return window.confirm(message);
  }

  // ─────────────── CSS injection ───────────────

  const styleTag = document.createElement('style');
  styleTag.textContent = `@keyframes fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}`;
  document.head.appendChild(styleTag);

  // ─────────────── Назад на предыдущий экран ───────────────
  // Экраны могут ссылаться друг на друга с ?from=<ключ> (Табло → любой раздел,
  // Диспетчерская → детали отгрузки и т.п.). Без этого пришлось бы каждый раз
  // возвращаться в общее меню и заново открывать нужный экран — просто
  // подменяем "← Меню" на "← <откуда пришли>" в шапке. Работает автоматически
  // на любой странице, где подключён этот файл (ui.js идёт после разметки
  // шапки, элемент уже есть в DOM).
  const BACK_TARGETS = {
    overview:         { href: '/app/overview-board.html',  label: '← Табло' },
    'admin-dashboard':{ href: '/app/admin-dashboard.html', label: '← Диспетчерская' },
  };
  try {
    const params = new URLSearchParams(window.location.search);
    const target = BACK_TARGETS[params.get('from')];
    if (target) {
      const back = document.querySelector('.header a.btn-back');
      if (back) {
        back.href = target.href;
        back.textContent = target.label;
      }
    }
  } catch (_) { /* ignore */ }

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
    const _u = window.API && window.API.getUser && window.API.getUser();
    if (_u && _u.impersonated) {
      const bar = document.createElement('div');
      bar.id = 'impersonation-banner';
      bar.style.cssText = 'position:sticky;top:0;z-index:99999;background:#7c2d12;color:#fed7aa;'
        + 'padding:10px 14px;font-size:13px;font-weight:700;display:flex;align-items:center;'
        + 'justify-content:center;gap:12px;flex-wrap:wrap;text-align:center;border-bottom:2px solid #f97316;';
      bar.innerHTML = `⚠️ Режим просмотра клиента «${escHtml(_u.companyName || '')}» — вход через панель платформы, ничего не нажимайте зря`
        + `<button id="impersonation-exit" style="background:#f97316;color:#1a0a02;border:none;border-radius:6px;padding:4px 12px;font-weight:700;cursor:pointer;">Выйти</button>`;
      document.body.prepend(bar);
      document.getElementById('impersonation-exit').addEventListener('click', async () => {
        try { await window.API.auth.logout(); } catch (_) {}
        // Вкладка обычно открыта скриптом из панели платформы (window.open) —
        // после выхода её незачем оставлять открытой на экране логина чужого
        // клиента, просто закрываем. Если браузер не даст закрыть (бывает,
        // если вкладку успели перезагрузить руками) — тогда уже разлогиниваем
        // на экран входа как запасной вариант.
        window.close();
        setTimeout(() => { window.location.href = '/app/login.html'; }, 300);
      });
    }
  } catch (_) { /* ignore */ }

  // ─────────────── Рабочее место (маршрутизация печати по столам/зонам) ───────────────
  // Сотрудник сканирует код своего рабочего места (стол упаковки, зона сборки,
  // зона отгрузки) один раз — дальше print_job на любой скан штрихкода уходит
  // именно на принтер этого места (см. server/.../printing/printerResolver.js),
  // а не на общий маршрут по типу документа на весь склад. Показываем узкую
  // плашку с текущим местом только на "рабочих" экранах, где сканирование
  // штрихкода реально создаёт print_job — там важно видеть, куда сейчас идёт
  // печать. На админ-панелях/логине/платформе плашка не показывается.
  const WORKSTATION_PAGES = ['packing', 'picking', 'shipping', 'receiving', 'placement', 'movement', 'inbound'];

  async function initWorkstationBanner() {
    try {
      const page = (window.location.pathname.split('/').pop() || '').replace(/\.html$/, '');
      if (!WORKSTATION_PAGES.includes(page)) return;
      const u = window.API && window.API.getUser && window.API.getUser();
      if (!u || u.role === 'seller' || !window.API.workstations) return;

      const header = document.querySelector('.header');
      if (!header) return;

      const bar = document.createElement('div');
      bar.id = 'workstation-banner';
      bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;'
        + 'background:var(--card2,#f1f5f9);border:1px dashed var(--border,#e2e8f0);border-radius:10px;'
        + 'padding:8px 12px;margin:10px 0;font-size:13px;color:var(--muted,#64748b);flex-wrap:wrap;';
      header.insertAdjacentElement('afterend', bar);

      function scan() {
        if (!window.Scanner) { notify.err('Модуль камеры-сканера не загружен'); return; }
        Scanner.open({
          title: 'Скан кода рабочего места',
          onResult: async (code) => {
            beep('ok');
            try {
              await window.API.workstations.select(code);
              notify.ok('Рабочее место выбрано');
              await render();
            } catch (err) { beep('err'); notify.err(err.message); }
          },
        });
      }

      async function render() {
        let station = null;
        try { station = (await window.API.workstations.my()).station; } catch (_) { /* не блокируем экран */ }
        const label = station
          ? `Рабочее место: <b style="color:var(--text,#0f172a);">${escHtml(station.station_name)}</b>`
          : `Рабочее место не выбрано — печать пойдёт по общему маршруту склада`;
        bar.innerHTML = `<span>${label}</span>`
          + `<button id="ws-banner-scan" style="background:var(--accent,#0284c7);color:#fff;border:none;border-radius:8px;padding:6px 12px;font-weight:700;font-size:12px;cursor:pointer;">${station ? 'Сменить' : 'Выбрать'}</button>`;
        document.getElementById('ws-banner-scan').addEventListener('click', scan);
      }

      await render();
    } catch (_) { /* тихо не мешаем странице, если что-то пошло не так */ }
  }

  initWorkstationBanner();

  // ─────────────── Смена пароля ───────────────
  // Доступно любому залогиненному пользователю (сотрудник склада или seller) —
  // самостоятельная замена пароля, без обращения к владельцу платформы.
  // Бэкенд (POST /auth/change-password) уже существовал, но до этого нигде
  // не было экрана, который его вызывает.
  function openChangePasswordModal() {
    if (document.getElementById('cp-modal-overlay')) return; // уже открыта
    const overlay = document.createElement('div');
    overlay.id = 'cp-modal-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.6);z-index:9998;display:flex;align-items:center;justify-content:center;padding:16px;';
    const inputCss = 'width:100%;padding:12px 14px;background:var(--card2,#f1f5f9);border:2px solid var(--border,#e2e8f0);border-radius:10px;font-size:15px;outline:none;color:var(--text,#0f172a);box-sizing:border-box;';
    const labelCss = 'display:block;font-size:12px;font-weight:600;color:var(--muted,#64748b);text-transform:uppercase;letter-spacing:.4px;margin-bottom:6px;';
    overlay.innerHTML = `
      <div style="background:var(--card,#fff);border-radius:16px;padding:22px;width:100%;max-width:380px;box-sizing:border-box;">
        <div style="font-size:16px;font-weight:700;margin-bottom:16px;color:var(--text,#0f172a);">Сменить пароль</div>
        <div style="margin-bottom:12px;">
          <label style="${labelCss}">Текущий пароль</label>
          <input id="cp-current" type="password" autocomplete="current-password" style="${inputCss}"/>
        </div>
        <div style="margin-bottom:12px;">
          <label style="${labelCss}">Новый пароль</label>
          <input id="cp-new" type="password" autocomplete="new-password" style="${inputCss}"/>
        </div>
        <div style="margin-bottom:16px;">
          <label style="${labelCss}">Повторите новый пароль</label>
          <input id="cp-new2" type="password" autocomplete="new-password" style="${inputCss}"/>
        </div>
        <div id="cp-error" style="color:#dc2626;font-size:13px;margin-bottom:10px;display:none;"></div>
        <div style="display:flex;gap:10px;">
          <button id="cp-save" style="flex:1;padding:13px;background:var(--accent,#0284c7);color:#fff;border:none;border-radius:10px;font-weight:700;font-size:15px;cursor:pointer;">Сохранить</button>
          <button id="cp-cancel" style="flex:1;padding:13px;background:var(--card2,#f1f5f9);color:var(--text,#0f172a);border:2px solid var(--border,#e2e8f0);border-radius:10px;font-weight:700;font-size:15px;cursor:pointer;">Отмена</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.getElementById('cp-cancel').addEventListener('click', close);
    document.getElementById('cp-save').addEventListener('click', async () => {
      const cur = document.getElementById('cp-current').value;
      const nw  = document.getElementById('cp-new').value;
      const nw2 = document.getElementById('cp-new2').value;
      const errEl = document.getElementById('cp-error');
      errEl.style.display = 'none';
      if (!cur || !nw) { errEl.textContent = 'Заполните оба пароля'; errEl.style.display = 'block'; return; }
      if (nw.length < 8) { errEl.textContent = 'Новый пароль должен быть не короче 8 символов'; errEl.style.display = 'block'; return; }
      if (nw !== nw2) { errEl.textContent = 'Новые пароли не совпадают'; errEl.style.display = 'block'; return; }
      try {
        await window.API.auth.changePassword(cur, nw);
        notify.ok('Пароль изменён');
        close();
      } catch (e) {
        const msg = /current password is incorrect/i.test(e.message || '')
          ? 'Текущий пароль неверен'
          : (e.message || 'Не удалось сменить пароль');
        errEl.textContent = msg;
        errEl.style.display = 'block';
      }
    });
  }

  // ─────────────── Export ───────────────

  window.UI = {
    toast, notify,
    el, els, show, hide, setText, setHTML, val, setVal, disable, enable,
    escHtml, isValidKizCode, hasValidKizStructure, setLoading,
    renderTable,
    requireAuth, requireRole,
    fmtDate, fmtDateTime, fmtMoney, fmtQty,
    onScan, scanInto, populateSelect, confirm,
    openChangePasswordModal,
    beep,
  };

})(window);
