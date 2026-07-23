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

  const DEFAULT_FORMATS = ['code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code', 'code_39'];

  let currentStream = null;

  function vibrate(ms) {
    try { navigator.vibrate && navigator.vibrate(ms); } catch (_) {}
  }

  function stopStream() {
    if (currentStream) {
      currentStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
      currentStream = null;
    }
  }

  function buildOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'scanner-overlay';
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(2,6,23,.96);z-index:10000;' +
      'display:flex;justify-content:center;padding:14px;overflow-y:auto;';
    overlay.innerHTML = `
      <div style="width:100%;max-width:480px;display:flex;flex-direction:column;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
          <div id="scanner-title" style="color:#f1f5f9;font-size:16px;font-weight:700;"></div>
          <button id="scanner-close-btn" type="button"
            style="background:#7f1d1d;color:#fca5a5;border:none;border-radius:8px;padding:10px 16px;font-weight:700;font-size:14px;">✕ Закрыть</button>
        </div>
        <div style="position:relative;width:100%;background:#000;border-radius:14px;overflow:hidden;min-height:200px;">
          <video id="scanner-video" playsinline autoplay muted style="width:100%;display:block;"></video>
          <div style="position:absolute;left:10%;right:10%;top:30%;bottom:30%;border:3px solid rgba(56,189,248,.7);border-radius:12px;pointer-events:none;"></div>
        </div>
        <div id="scanner-status" style="color:#94a3b8;font-size:13px;text-align:center;margin:10px 0;min-height:18px;"></div>
        <div style="margin-top:8px;">
          <div style="color:#64748b;font-size:12px;margin-bottom:6px;">Не сканируется? Введите код вручную:</div>
          <div style="display:flex;gap:8px;">
            <input id="scanner-manual-input" type="text" placeholder="Код..."
              autocomplete="off" autocapitalize="off"
              style="flex:1;padding:14px;background:#0f172a;border:2px solid #334155;border-radius:10px;color:#f1f5f9;font-size:16px;outline:none;"/>
            <button id="scanner-manual-btn" type="button"
              style="padding:14px 20px;background:#2563eb;color:#fff;border:none;border-radius:10px;font-weight:700;font-size:15px;">OK</button>
          </div>
        </div>
      </div>
    `;
    return overlay;
  }

  /**
   * @param {object} opts
   * @param {string} opts.title
   * @param {string[]} [opts.formats]
   * @param {(code:string)=>void} opts.onResult
   * @param {()=>void} [opts.onCancel]
   */
  async function open(opts) {
    const { title = 'Сканирование', formats = DEFAULT_FORMATS, onResult, onCancel } = opts || {};

    const overlay = buildOverlay();
    document.body.appendChild(overlay);

    const titleEl   = overlay.querySelector('#scanner-title');
    const statusEl  = overlay.querySelector('#scanner-status');
    const video     = overlay.querySelector('#scanner-video');
    const manualIn  = overlay.querySelector('#scanner-manual-input');
    const manualBtn = overlay.querySelector('#scanner-manual-btn');
    const closeBtn  = overlay.querySelector('#scanner-close-btn');

    titleEl.textContent = title;

    let closed = false;
    let detecting = false;

    function teardown() {
      detecting = false;
      stopStream();
      overlay.remove();
    }

    function finish(value) {
      if (closed) return;
      closed = true;
      teardown();
      if (onResult) onResult(value);
    }

    function cancel() {
      if (closed) return;
      closed = true;
      teardown();
      if (onCancel) onCancel();
    }

    closeBtn.addEventListener('click', cancel);
    manualBtn.addEventListener('click', () => {
      const v = manualIn.value.trim();
      if (v) finish(v);
    });
    manualIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = manualIn.value.trim();
        if (v) finish(v);
      }
    });

    if (!('BarcodeDetector' in window)) {
      statusEl.textContent = 'Этот браузер не умеет сканировать камерой — используйте поле ввода ниже (или откройте страницу в Chrome на Android)';
      setTimeout(() => manualIn.focus(), 150);
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
    } catch (err) {
      statusEl.textContent = 'Нет доступа к камере (' + (err.name || err.message || 'ошибка') + ') — используйте поле ввода ниже';
      setTimeout(() => manualIn.focus(), 150);
      return;
    }

    if (closed) { // модалку успели закрыть, пока ждали разрешение камеры
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    currentStream = stream;
    video.srcObject = stream;
    try { await video.play(); } catch (_) {}

    let detector;
    try {
      detector = new window.BarcodeDetector({ formats });
    } catch (_) {
      detector = new window.BarcodeDetector();
    }

    detecting = true;
    statusEl.textContent = 'Наведите камеру на штрихкод или QR';

    const tick = async () => {
      if (!detecting) return;
      try {
        const codes = await detector.detect(video);
        if (codes && codes.length > 0 && codes[0].rawValue) {
          vibrate(80);
          finish(codes[0].rawValue);
          return;
        }
      } catch (_) {
        // detect() может кидать пока кадр ещё не готов — просто пробуем следующий тик
      }
      if (detecting) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  window.Scanner = { open };
})(window);
