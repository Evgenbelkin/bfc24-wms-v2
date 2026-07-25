'use strict';

require('dotenv').config();

const axios    = require('axios');
const fs       = require('fs');
const path     = require('path');
const PDFDocument = require('pdfkit');
const SVGtoPDF = require('svg-to-pdfkit');
const { print }  = require('pdf-to-printer');

// =============================================================================
// BFC24 WMS v2 — Printer Agent
// Polling-based: каждые poll_interval_ms проверяет новые print_jobs через API
// SVG → PDF через pdfkit + svg-to-pdfkit (без зависимости от Chrome)
// Temp-файлы удаляются после успешной печати
// =============================================================================

const API_BASE    = process.env.API_BASE_URL || 'http://localhost:3001/api/v2';
const AGENT_KEY    = process.env.AGENT_KEY   || '';
const POLL_MS     = Number(process.env.POLL_INTERVAL_MS || 1500);
const TMP_DIR     = path.join(__dirname, 'tmp');
// Отладочная копия последних напечатанных документов (сырой SVG от сервера +
// готовый PDF) — не чистится автоматически как tmp/, держим последние
// DEBUG_KEEP штук, чтобы при вопросах "почему стикер съехал" можно было
// открыть файл и посмотреть, что реально пришло и что получилось на выходе,
// вместо гадания вслепую.
const DEBUG_DIR   = path.join(__dirname, 'debug');
const DEBUG_KEEP  = 20;

// AGENT_KEY имеет вид pk_{printerId}_{secret} — печатается один раз в панели
// принтеров при выпуске (кнопка "Выпустить ключ агента"). Он не привязан к
// учётке сотрудника и не истекает по времени — в отличие от старой схемы
// с Bearer-токеном логина, здесь агент не встанет молча через пару часов.
if (!AGENT_KEY) { console.error('AGENT_KEY is not set (см. панель принтеров → кнопка "Выпустить ключ агента")'); process.exit(1); }
const PRINTER_ID_MATCH = /^pk_(\d+)_/.exec(AGENT_KEY);
if (!PRINTER_ID_MATCH) { console.error('AGENT_KEY has unexpected format (expected pk_{id}_{secret})'); process.exit(1); }
const PRINTER_ID = Number(PRINTER_ID_MATCH[1]);

console.log('=== BFC24 WMS v2 Printer Agent ===');
console.log('API:', API_BASE);
console.log('PRINTER_ID:', PRINTER_ID, '(из AGENT_KEY)');
console.log('POLL_INTERVAL_MS:', POLL_MS);

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });

function pruneDebugDir() {
  try {
    const files = fs.readdirSync(DEBUG_DIR)
      .map(f => ({ f, t: fs.statSync(path.join(DEBUG_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(DEBUG_KEEP)) fs.unlinkSync(path.join(DEBUG_DIR, f));
  } catch (_) {}
}

const api = axios.create({
  baseURL: API_BASE,
  headers: { 'X-Agent-Key': AGENT_KEY, Accept: 'application/json' },
  timeout: 15_000,
});

function mmToPt(mm) { return (mm * 72) / 25.4; }

// Декодировать SVG из payload
function decodeSvg(payload) {
  if (!payload) return null;
  const raw = payload.wb_sticker || payload.sticker || payload.base64 || payload.qr_base64 || null;
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.startsWith('<svg') || s.startsWith('<?xml')) return s;
  // base64
  const pure = s.startsWith('data:') ? s.slice(s.indexOf(',') + 1) : s;
  try {
    const decoded = Buffer.from(pure, 'base64').toString('utf8');
    if (decoded.includes('<svg') || decoded.includes('</svg>')) return decoded;
  } catch(_) {}
  return null;
}

// SVG → PDF файл
// rotate90: содержимое рисуется как будто холст перевёрнут (h x w) и
// поворачивается на 90° по часовой, чтобы лечь в физическую страницу w x h -
// оставлено на будущее, сейчас не используется (см. коммит с разбором
// реальных SVG от WB - у них разворот уже встроен в сам SVG).
// marginMm: у прямых термопринтеров обычно есть недопечатываемая полоса
// у края этикетки (1-3мм) - контент WB рассчитан впритык к краю viewBox
// (без своих отступов), поэтому нижние строки текста физически обрезались
// принтером. Отступ съедает немного места под QR, но гарантирует, что
// ничего не уходит в мёртвую зону у края.
function buildPdf(svgText, pdfPath, { widthMm = 58, heightMm = 40, rotate90 = false, marginMm = 1.5 } = {}) {
  return new Promise((resolve, reject) => {
    const w = mmToPt(widthMm);
    const h = mmToPt(heightMm);
    const m = mmToPt(marginMm);
    const doc = new PDFDocument({ size: [w, h], margin: 0, autoFirstPage: true });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);
    if (rotate90) {
      doc.save();
      doc.translate(w, 0);
      doc.rotate(90);
      SVGtoPDF(doc, svgText, m, m, { width: h - 2 * m, height: w - 2 * m, preserveAspectRatio: 'xMidYMid meet' });
      doc.restore();
    } else {
      SVGtoPDF(doc, svgText, m, m, { width: w - 2 * m, height: h - 2 * m, preserveAspectRatio: 'xMidYMid meet' });
    }
    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

// Отправить на принтер
// scale:'noscale' - ОБЯЗАТЕЛЬНО. Без этого SumatraPDF (движок печати внутри
// pdf-to-printer) сам решает, подгонять ли наш PDF под текущий размер бумаги
// в драйвере - именно это и рвало печать (растягивало на 2 этикетки, крутило
// и т.п.), хотя наш PDF всегда ровно 58х40мм. При печати из браузера этой
// проблемы нет, потому что браузер обычно шлёт на печать в масштабе 100%.
async function printPdf(pdfPath, printerName) {
  if (!fs.existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);
  await print(pdfPath, { printer: printerName, scale: 'noscale' });
}

// Удалить temp файлы
function cleanupTmp(files) {
  for (const f of files) {
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch(_) {}
  }
}

// Обновить статус job
async function markJob(jobId, status, errorText = null) {
  await api.patch(`/printer-agent/jobs/${jobId}`, { status, error_text: errorText });
}

// Обработать один job
async function processJob(job) {
  const pdfPath = path.join(TMP_DIR, `job-${job.id}-${Date.now()}.pdf`);
  console.log(`[JOB ${job.id}] doc_type=${job.doc_type} printer=${job.printer_name}`);

  try {
    await markJob(job.id, 'processing');

    let payload = {};
    if (job.payload_json) {
      payload = typeof job.payload_json === 'object' ? job.payload_json : JSON.parse(job.payload_json);
    }

    const svgText = decodeSvg(payload);
    if (!svgText) throw new Error('No SVG/sticker in payload_json');

    // Сохраняем сырой SVG "как есть" в debug/ — чтобы при жалобах на кривую
    // печать (сдвиг, обрезка и т.п.) можно было посмотреть, что РЕАЛЬНО пришло
    // с сервера, не гадая вслепую.
    const debugBase = path.join(DEBUG_DIR, `job-${job.id}-${job.doc_type}-${Date.now()}`);
    try { fs.writeFileSync(`${debugBase}.svg`, svgText, 'utf8'); } catch (_) {}

    // Все три типа документа (стикер WB, внутренняя наклейка сборки, QR поставки)
    // печатаются на одном и том же физическом рулоне термоэтикеток 58×40мм —
    // раньше QR-документы (shipping_qr, pick_list_label) рендерились в PDF-страницу
    // 58×58 (квадрат), что не совпадает с реальной этикеткой. QR — квадратное
    // содержимое, preserveAspectRatio:'xMidYMid meet' в buildPdf вписывает его по
    // высоте 40мм без обрезки, просто с полями по бокам — так что единый размер
    // безопасен для всех типов документов.
    // Настоящая причина кривой печати была не в размере страницы и не в
    // драйвере (печать тех же SVG прямо из браузера всегда была верной с
    // исходными настройками принтера) - а в том, что printPdf() не запрещал
    // SumatraPDF масштабировать/подгонять PDF под бумагу (см. scale:'noscale'
    // в printPdf). Возвращаем страницу к изначальному, математически
    // проверенному по реальным SVG от WB размеру: 58х40 landscape без
    // поворота - драйвер принтера тоже должен быть на исходных настройках
    // (Stock 58x40, Orientation 0-Portrait).
    const dims = { widthMm: 58, heightMm: 40 };

    await buildPdf(svgText, pdfPath, dims);
    try { fs.copyFileSync(pdfPath, `${debugBase}.pdf`); } catch (_) {}
    pruneDebugDir();

    // ВАЖНО: printer_name — это просто ярлык из WMS ("XP365B"), который
    // придумывает пользователь, а не реальное имя принтера в Windows.
    // Реальное имя (то, что видно в Параметры → Принтеры и сканеры) — это
    // device_name ("Точное имя устройства" в карточке принтера). Раньше
    // приоритет был перепутан, из-за чего печать пыталась уйти на
    // несуществующий в Windows принтер "XP365B" и тихо проваливалась.
    const printerName = job.device_name || job.printer_name || 'Xprinter XP-D365B';
    await printPdf(pdfPath, printerName);

    await markJob(job.id, 'printed');
    console.log(`[JOB ${job.id}] PRINTED OK`);
  } finally {
    cleanupTmp([pdfPath]);
  }
}

// Главный цикл опроса
let isProcessing = false;

async function checkJobs() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const res = await api.get('/printer-agent/jobs', {
      params: { status: 'new', limit: 10 },
      validateStatus: () => true,
    });

    if (res.status >= 400) {
      console.error(`[POLL] API error ${res.status}:`, res.data);
      return;
    }

    const jobs = Array.isArray(res.data?.data) ? res.data.data : [];

    for (const job of jobs) {
      if (job.status !== 'new') continue;
      if (Number(job.printer_id) !== PRINTER_ID) continue;

      try {
        await processJob(job);
      } catch (err) {
        const msg = err.message || String(err);
        console.error(`[JOB ${job.id}] ERROR:`, msg);
        try { await markJob(job.id, 'error', msg.slice(0, 2000)); } catch(_) {}
      }
    }
  } catch (err) {
    console.error('[POLL] Error:', err.message || err);
  } finally {
    isProcessing = false;
  }
}

// Запуск
checkJobs();
setInterval(checkJobs, POLL_MS);
