'use strict';

require('dotenv').config();

const axios    = require('axios');
const fs       = require('fs');
const path     = require('path');
const { spawn } = require('child_process');
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
// Было 1500 — на упаковке это ощущалось как заметное ожидание стикера после
// скана. Опрос (/printer-agent/jobs) очень дешёвый на сервере (один индексный
// запрос по printer_id+status), поэтому дефолт снижен до 500 — при желании
// станция всё ещё может переопределить через POLL_INTERVAL_MS в своём .env.
const POLL_MS     = Number(process.env.POLL_INTERVAL_MS || 500);
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

// НАСТОЯЩАЯ причина обрезанного/пропавшего текста ("1 шт.", "Москва_Запад-Юг"
// на shipping_qr, и т.п.) - найдено экспериментально: подставляли ASCII-текст
// вместо кириллического на ТЕХ ЖЕ координатах с ТЕМ ЖЕ transform - рендерился
// полностью и верно. Значит дело не в transform/повороте (это была ложная
// связь - в одном из тестов заодно поменял и текст на латиницу, и transform,
// решил что дело в transform). Настоящая причина - PDFKit по умолчанию
// использует встроенный шрифт Helvetica, в котором НЕТ кириллических глифов;
// svg-to-pdfkit ничего не переопределяет (у текста в SVG от WB нет
// font-family, берётся дефолт 'sans-serif', которого просто нет среди
// зарегистрированных в PDFKit шрифтов). Кириллические символы рендерятся
// как ничего (нулевая ширина) - остаются видны только цифры/точки/дефисы,
// что и было на фото у пользователя. Фикс - регистрируем шрифт с кириллицей
// (DejaVu Sans, см. fonts/DejaVuSans.ttf) под именем 'sans-serif' до вызова
// SVGtoPDF.
// Читаем файл шрифта В ПАМЯТЬ один раз при старте процесса агента (а не на
// каждое задание) - на случай, если повторное чтение файла с диска на
// каждый job добавляло свою нестабильность/задержку (например сразу после
// распаковки zip, пока антивирус ещё сканирует новые файлы).
const CYRILLIC_FONT_PATH = path.join(__dirname, 'fonts', 'DejaVuSans.ttf');
let cyrillicFontBuffer = null;
let cyrillicFontWarned = false;
try {
  if (fs.existsSync(CYRILLIC_FONT_PATH)) cyrillicFontBuffer = fs.readFileSync(CYRILLIC_FONT_PATH);
} catch (_) {}
function ensureCyrillicFont(doc) {
  if (cyrillicFontBuffer) {
    doc.registerFont('sans-serif', cyrillicFontBuffer);
  } else if (!cyrillicFontWarned) {
    console.error(`[FONT] ${CYRILLIC_FONT_PATH} not found - кириллица в стикерах не будет печататься!`);
    cyrillicFontWarned = true; // не спамить в лог на каждой job
  }
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
    ensureCyrillicFont(doc);
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
// НАСТОЯЩАЯ причина кривой печати (найдено через исходники pdf-to-printer +
// документацию SumatraPDF, см. https://www.sumatrapdfreader.org/docs/Command-line-arguments):
// pdf-to-printer под капотом просто дёргает `SumatraPDF.exe -print-to <printer>
// -print-settings <...> file.pdf`. Если НЕ передать paperSize, SumatraPDF при
// печати из командной строки берёт размер бумаги ТЕКУЩИЙ ПО УМОЛЧАНИЮ В ДРАЙВЕРЕ
// принтера - а не размер страницы самого PDF. Кастомный Stock "58x40",
// заведённый через утилиту Xprinter, не входит в список paperSizes, который
// возвращает getPrinters() (там только 76x130/72x130/1x1.5/1.25x2.5) - то есть
// движок печати в принципе не может сослаться на него по имени. В итоге реальные
// задания печати уходили на какой-то ДРУГОЙ (больший/несовпадающий) размер
// бумаги драйвера, и scale:'noscale' тут не спасал - он просто не давал
// содержимое растянуть под этот неправильный размер, из-за чего сверху выходили
// то поля по бокам, то съезд на вторую этикетку.
// Печать из браузера этой проблемы никогда не имела, потому что там всегда
// используются ТЕКУЩИЕ настройки диалога печати драйвера, а не CLI-дефолт.
// Исправление - явно указывать paperSize кастомным размером в мм, СОВПАДАЮЩИМ
// с реальным размером PDF-страницы (см. `paper=76mm x 130mm` в документации
// SumatraPDF, поддерживает произвольные WxH в мм).
//
// ПРОДОЛЖЕНИЕ: пробовали ещё передавать SumatraPDF свой orientation=landscape,
// чтобы подстроиться под Orientation:1 (Portrait) из диагностики
// Win32_PrinterConfiguration - эмпирически не сработало (фото показало тот же
// результат, что и без этого флага), т.е. этот RAW-драйвер его не учитывает.
// Убрали. Разворот содержимого теперь делаем сами внутри PDF (см. rotate90 в
// processJob/buildPdf) - это не зависит от того, что умеет или не умеет
// драйвер, и подтверждено рабочим локальным рендером.
//
// ПРОДОЛЖЕНИЕ (скриншот диалога настроек драйвера Xprinter, вкладка Page
// Setup -> Stock): у принтера есть ИМЕНОВАННЫЙ вариант "58x40(58.0 mm x 40.0
// mm)" - именно он выбран и используется при печати из браузера. Наш код
// передавал не это имя, а свою кастомную строку размера "58mm x 40mm" -
// это создаёт generic custom-size в DEVMODE, а не выбирает именованный Stock
// из драйвера, в котором (в отличие от generic custom size) может быть
// зашита калибровка датчика зазора между этикетками конкретно под этот
// Stock.
//
// ВАЖНО: имя Stock ("58x40") зависит от КОНКРЕТНОЙ модели/экземпляра
// принтера и от того, как именно назвал его тот, кто настраивал драйвер -
// у другого принтера (другая модель, другой склад) это имя почти наверняка
// будет другим или его не будет вовсе.
//
// ПРОДОЛЖЕНИЕ (после разбора с ChatGPT, см. printer-agent/README-print-fix.md):
// bundled в pdf-to-printer SumatraPDF - версия 3.4.6, в ней ещё нет флага
// `disable-auto-rotation` (появился в 3.5). У SumatraPDF есть СВОЯ логика
// автоповорота страницы (если PDF шире чем выше - крутит на 90°) поверх той
// ориентации, которую в это же мгновение сообщает драйвер - а состояние
// драйвера (DEVMODE) может быть НЕ до конца нормализовано на первом задании
// после запуска агента/после смены настроек и "устаканиться" только к
// повторному заданию - отсюда именно нестабильность "то криво то нет" на
// ОДНОМ и том же файле. Плюс наш paperSize (что кастомный, что по имени)
// - это отдельная попытка драйвера сопоставить форму, которая тоже может
// разъезжаться с уже выбранным в драйвере Stock.
//
// Фикс на этом уровне:
// 1) Используем СВОЙ, более новый SumatraPDF.exe (printer-agent/bin/, кладёт
//    туда сам администратор склада - см. install.bat/README-print-fix.md,
//    т.к. скачивать бинарник с сайта автоматически при установке агента
//    неудобно/небезопасно) - в нём есть disable-auto-rotation.
// 2) НЕ передаём paper=/paperSize вообще - вместо этого формат "58x40" (или
//    любой другой, специфичный для конкретного принтера) должен быть
//    настроен как ПОСТОЯННЫЙ default в самой Windows (Свойства принтера ->
//    Настройка печати/Printing Preferences, И ОТДЕЛЬНО Свойства принтера ->
//    Дополнительно -> Параметры печати по умолчанию/Printing Defaults - это
//    два РАЗНЫХ места в Windows, и именно "Printing Defaults" использует
//    печать "в фоне"/без интерактивного диалога, как у нас) - см.
//    README-print-fix.md. Тогда agent просто не трогает размер бумаги, и
//    печать идёт с уже настроенным в драйвере форматом - как при печати из
//    браузера.
// 3) Если кастомный SumatraPDF.exe не положен в bin/ - используем старый
//    bundled из pdf-to-printer как раньше (без disable-auto-rotation, но
//    тоже без paperSize).
const CUSTOM_SUMATRA_PATH = path.join(__dirname, 'bin', 'SumatraPDF.exe');

function runSumatra(sumatraPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(sumatraPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) reject(new Error(`SumatraPDF exited with code ${code}: ${stderr.trim()}`));
      else resolve();
    });
  });
}

let loggedSumatraChoice = false;
async function printPdf(pdfPath, printerName) {
  if (!fs.existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);
  const useCustomSumatra = fs.existsSync(CUSTOM_SUMATRA_PATH);
  if (!loggedSumatraChoice) {
    console.log(useCustomSumatra
      ? `[SUMATRA] используем свой ${CUSTOM_SUMATRA_PATH} (disable-auto-rotation доступен)`
      : `[SUMATRA] bin/SumatraPDF.exe не найден - используем старый bundled из pdf-to-printer (без disable-auto-rotation). См. README-print-fix.md`);
    loggedSumatraChoice = true;
  }
  if (useCustomSumatra) {
    await runSumatra(CUSTOM_SUMATRA_PATH, [
      '-print-to', printerName,
      '-silent',
      '-print-settings', 'noscale,disable-auto-rotation',
      pdfPath,
    ]);
  } else {
    // Старый bundled Sumatra (3.4.6) - без disable-auto-rotation, и без
    // paperSize (см. комментарий выше - формат должен быть default'ом в
    // самой Windows, а не переопределяться на каждое задание).
    await print(pdfPath, { printer: printerName, scale: 'noscale' });
  }
}

// Удалить temp файлы
function cleanupTmp(files) {
  for (const f of files) {
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch(_) {}
  }
}

// "Остывание" принтера между заданиями - см. комментарий в processJob() про
// то, откуда взялась гипотеза (одно и то же задание печатается криво "сразу"
// и чисто "повтором" много позже). PRINTER_COOLDOWN_MS настраивается через
// .env на случай, если 800мс для конкретной модели/скорости печати мало или
// много - подбирается опытным путём на месте, без пересборки кода.
const PRINTER_COOLDOWN_MS = Number(process.env.PRINTER_COOLDOWN_MS || 800);
const lastPrintAtByPrinter = new Map();
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitForPrinterCooldown(printerId) {
  const last = lastPrintAtByPrinter.get(printerId);
  if (!last) return;
  const elapsed = Date.now() - last;
  if (elapsed < PRINTER_COOLDOWN_MS) {
    const wait = PRINTER_COOLDOWN_MS - elapsed;
    console.log(`[PRINTER ${printerId}] cooldown wait ${wait}ms`);
    await sleep(wait);
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
    // печать можно было посмотреть, что РЕАЛЬНО пришло с сервера, не гадая
    // вслепую.
    const debugBase = path.join(DEBUG_DIR, `job-${job.id}-${job.doc_type}-${Date.now()}`);
    try { fs.writeFileSync(`${debugBase}.svg`, svgText, 'utf8'); } catch (_) {}

    // Все три типа документа (стикер WB, внутренняя наклейка сборки, QR поставки)
    // печатаются на одном и том же физическом рулоне термоэтикеток 58×40мм —
    // раньше QR-документы (shipping_qr, pick_list_label) рендерились в PDF-страницу
    // 58×58 (квадрат), что не совпадает с реальной этикеткой. QR — квадратное
    // содержимое, preserveAspectRatio:'xMidYMid meet' в buildPdf вписывает его по
    // высоте 40мм без обрезки, просто с полями по бокам — так что единый размер
    // безопасен для всех типов документов.
    // ВАЖНО (уточнено пользователем по референсу): текст на стикерах/QR от WB
    // ДОЛЖЕН быть вертикальным - это их штатный вид (WB.ru печатает так же).
    // <g transform="rotate(270) translate(-400 0)"> в их SVG - это и есть
    // правильная, ожидаемая ориентация, а не баг. Пробовали гасить её своим
    // rotate90 - это НЕПРАВИЛЬНО, результат получал двойной поворот и почти
    // весь уезжал за край страницы (см. фото - пусто, обрезанный QR). Рендерим
    // SVG "как есть", без какого-либо дополнительного поворота с нашей стороны.
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
    // ОПРОВЕРГНУТО пользователем по временным меткам debug-файлов (разница
    // между заданиями была 3+ минуты, не миллисекунды) - гипотеза "принтер не
    // успевает остыть между заданиями" была неверной. Паузу оставляем как
    // дешёвый защитный минимум на будущее (не мешает, если она не нужна), но
    // она не основной фикс.
    await waitForPrinterCooldown(job.printer_id);
    // См. подробный комментарий у printPdf()/README-print-fix.md - разбирались
    // с ChatGPT: причина нестабильной печати, похоже, в собственной логике
    // автоповорота старого SumatraPDF (3.4.6) поверх состояния драйвера,
    // которое не всегда успевает нормализоваться к первому заданию. Формат
    // бумаги (paper_size_name из карточки принтера) больше НЕ передаём при
    // печати - вместо этого он должен быть настроен как default прямо в
    // Windows (см. README-print-fix.md). Поле в БД/панели оставляем на
    // будущее (вдруг для другого принтера/драйвера понадобится), но agent.js
    // сейчас его не использует.
    await printPdf(pdfPath, printerName);
    lastPrintAtByPrinter.set(job.printer_id, Date.now());

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
