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
      tbody.innerHTML = `<tr><td colspan="99" style="text-align:center;color:#888;padding:24px;">Нет данных</td></tr>`;
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

  // ─────────────── Scanner input helper ───────────────
  // TSD-friendly: Enter-triggered scan

  function onScan(inputSelector, callback) {
    const input = el(inputSelector);
    if (!input) return;
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const value = input.value.trim();
        if (!value) return;
        input.value = '';
        input.blur();
        try { await callback(value); } catch(err) { notify.err(err.message); }
        setTimeout(() => { input.focus(); }, 300);
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
        window.location.href = '/app/login.html';
      });
    }
  } catch (_) { /* ignore */ }

  // ─────────────── Export ───────────────

  window.UI = {
    toast, notify,
    el, els, show, hide, setText, setHTML, val, setVal, disable, enable,
    escHtml, setLoading,
    renderTable,
    requireAuth, requireRole,
    fmtDate, fmtDateTime, fmtMoney, fmtQty,
    onScan, scanInto, populateSelect, confirm,
  };

})(window);
