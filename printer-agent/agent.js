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
const API_TOKEN   = process.env.AGENT_TOKEN  || '';
const PRINTER_ID  = Number(process.env.PRINTER_ID || 0);
const POLL_MS     = Number(process.env.POLL_INTERVAL_MS || 1500);
const TMP_DIR     = path.join(__dirname, 'tmp');

if (!API_TOKEN) { console.error('AGENT_TOKEN is not set'); process.exit(1); }
if (!PRINTER_ID){ console.error('PRINTER_ID is not set'); process.exit(1); }

console.log('=== BFC24 WMS v2 Printer Agent ===');
console.log('API:', API_BASE);
console.log('PRINTER_ID:', PRINTER_ID);
console.log('POLL_INTERVAL_MS:', POLL_MS);

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const api = axios.create({
  baseURL: API_BASE,
  headers: { Authorization: `Bearer ${API_TOKEN}`, Accept: 'application/json' },
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
function buildPdf(svgText, pdfPath, { widthMm = 58, heightMm = 40 } = {}) {
  return new Promise((resolve, reject) => {
    const w = mmToPt(widthMm);
    const h = mmToPt(heightMm);
    const doc = new PDFDocument({ size: [w, h], margin: 0, autoFirstPage: true });
    const stream = fs.createWriteStream(pdfPath);
    doc.pipe(stream);
    SVGtoPDF(doc, svgText, 0, 0, { width: w, height: h, preserveAspectRatio: 'xMidYMid meet' });
    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

// Отправить на принтер
async function printPdf(pdfPath, printerName) {
  if (!fs.existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);
  await print(pdfPath, { printer: printerName });
}

// Удалить temp файлы
function cleanupTmp(files) {
  for (const f of files) {
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch(_) {}
  }
}

// Обновить статус job
async function markJob(jobId, status, errorText = null) {
  await api.patch(`/printing/jobs/${jobId}`, { status, error_text: errorText });
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

    // Размер по типу документа
    const SQUARE_DOC_TYPES = ['shipping_qr', 'pick_list_label'];
    const dims = SQUARE_DOC_TYPES.includes(job.doc_type) ? { widthMm: 58, heightMm: 58 } : { widthMm: 58, heightMm: 40 };

    await buildPdf(svgText, pdfPath, dims);

    const printerName = job.printer_name || job.device_name || 'Xprinter XP-D365B';
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
    const res = await api.get('/printing/jobs', {
      params: { printer_id: PRINTER_ID, status: 'new', limit: 10 },
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
