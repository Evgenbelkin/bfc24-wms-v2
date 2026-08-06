'use strict';

const QRCode = require('qrcode');
const bwipjs = require('bwip-js');

/**
 * Сгенерировать QR-код как SVG-строку (для печати через printer-agent,
 * который уже умеет рендерить SVG → PDF → на принтер).
 */
function generateQrSvg(text, { width = 240, margin = 1 } = {}) {
  return QRCode.toString(String(text), { type: 'svg', margin, width });
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * QR-код + подпись человекочитаемым текстом под ним (код отгрузки) — для
 * внутренней наклейки "pick_list_label", которая раньше состояла ТОЛЬКО из
 * QR-кода без единой видимой цифры/буквы: сотрудник не мог на глаз понять,
 * какой отгрузке принадлежит наклейка, приходилось сканировать каждую.
 * Печатается через тот же printer-agent пайплайн (SVG → PDF), что и обычный
 * generateQrSvg — просто это не голый QR, а составной SVG: вложенный <svg> с
 * QR-кодом сверху + <text> с кодом отгрузки снизу. Кириллица в <text>
 * рендерится агентом через зарегистрированный шрифт DejaVuSans (см.
 * printer-agent/agent.js ensureCyrillicFont) — тот же механизм, что и для
 * текста в стикерах WB, так что здесь ничего дополнительно настраивать не
 * нужно, если код отгрузки латиница/цифры (WB-GI-...) — тем более.
 * Размер подобран под общий формат этикетки 58×40мм, с которым уже печатают
 * все типы документов (см. dims в printer-agent/agent.js processJob) —
 * preserveAspectRatio:'xMidYMid meet' на стороне агента впишет по высоте.
 */
async function generateShipmentLabelSvg(shipmentCode, { qrSize = 260, width = 320, height = 360, fontSize = 34 } = {}) {
  const qrSvg = await QRCode.toString(String(shipmentCode), { type: 'svg', margin: 1, width: qrSize });
  const qrX = Math.round((width - qrSize) / 2);
  const textY = qrSize + 40;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">` +
    `<svg x="${qrX}" y="10" width="${qrSize}" height="${qrSize}">${qrSvg}</svg>` +
    `<text x="${width / 2}" y="${textY}" text-anchor="middle" font-family="sans-serif" ` +
    `font-weight="bold" font-size="${fontSize}">${escapeXml(shipmentCode)}</text>` +
    `</svg>`;
}

/**
 * Линейный штрихкод товара (Code128 — принимает ЛЮБУЮ строку/длину, в отличие
 * от EAN13, который требует ровно валидный по контрольной сумме код и упал бы
 * на части реальных баркодов WB) + название/артикул текстом сверху — для
 * печати из справочника товаров при приёмке (наклеил на товар — дальше сканером
 * читается как обычный магазинный штрихкод).
 * Цифры самого баркода рисует bwip-js через includetext (это ASCII, свой шрифт
 * встроен в саму библиотеку). Название товара - Cyrillic-текст, рендерится уже
 * НАШИМ <text> поверх, через тот же шрифт DejaVuSans, что и в остальных
 * составных этикетках (см. generateShipmentLabelSvg выше).
 */
function generateItemLabelSvg(barcode, itemName, { vendorCode = null, width = 400, height = 260, barcodeHeightMm = 10 } = {}) {
  const barcodeSvg = bwipjs.toSVG({
    bcid: 'code128',
    text: String(barcode),
    scale: 2,
    height: barcodeHeightMm,
    includetext: true,
    textxalign: 'center',
  });
  // bwip-js сам проставляет viewBox — вытаскиваем его, чтобы вписать без искажений
  const vbMatch = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(barcodeSvg);
  const bw = vbMatch ? Number(vbMatch[1]) : 300;
  const bh = vbMatch ? Number(vbMatch[2]) : 100;

  // ВАЖНО: раньше баркод оборачивался в <svg x y width height>, полагаясь на
  // авто-масштабирование вложенного SVG по его viewBox (как это делает браузер).
  // Агент печати рендерит через svg-to-pdfkit (см. printer-agent/agent.js),
  // а эта библиотека вложенные <svg> с пересчётом по viewBox нормально не
  // поддерживает — баркод печатался в "сыром" размере bwip-js без масштаба
  // и уезжал за край этикетки (штрихкод оказывался прижат к одному краю и
  // частично обрезан — отсюда и плохое считывание). Чиним явным
  // transform="translate() scale()" на <g> с СОДЕРЖИМЫМ баркода (а не
  // вложенным <svg>) — transform это базовая часть SVG, которую
  // svg-to-pdfkit поддерживает надёжно. Заодно даём поля по бокам, чтобы
  // штрихкод не растягивался на всю ширину этикетки и был по центру.
  const marginX = 28;
  const barcodeW = width - marginX * 2;
  const scale = barcodeW / bw;
  const barcodeH = Math.round(bh * scale);
  const barcodeX = marginX;
  const barcodeY = height - barcodeH - 14;

  const innerMatch = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(barcodeSvg);
  const barcodeInner = innerMatch ? innerMatch[1] : barcodeSvg;

  const titleLine = escapeXml(itemName || '');
  const subLine = vendorCode ? escapeXml(`Артикул: ${vendorCode}`) : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">` +
    `<text x="${width / 2}" y="34" text-anchor="middle" font-family="sans-serif" font-weight="bold" font-size="26">${titleLine}</text>` +
    (subLine ? `<text x="${width / 2}" y="62" text-anchor="middle" font-family="sans-serif" font-size="20">${subLine}</text>` : '') +
    `<g transform="translate(${barcodeX}, ${barcodeY}) scale(${scale})">${barcodeInner}</g>` +
    `</svg>`;
}

/**
 * Стикер "Честный знак" — код маркировки как Data Matrix (bwip-js bcid:
 * 'datamatrix') + название товара текстом сверху, для наклейки на физическую
 * единицу товара. Та же проблема и то же решение, что и в generateItemLabelSvg
 * выше: bwip-js отдаёт СВОЙ вложенный <svg width height viewBox>, а
 * svg-to-pdfkit (которым печатает printer-agent) не умеет авто-масштабировать
 * вложенные SVG по viewBox, как это делает браузер — поэтому вытаскиваем
 * внутреннее содержимое регуляркой и оборачиваем в <g transform="translate()
 * scale()">, а не в новый вложенный <svg>.
 */
function generateMarkingLabelSvg(code, itemName, { width = 400, height = 260 } = {}) {
  const dmSvg = bwipjs.toSVG({
    bcid: 'datamatrix',
    text: String(code),
    scale: 3,
  });
  const vbMatch = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(dmSvg);
  const dw = vbMatch ? Number(vbMatch[1]) : 100;
  const dh = vbMatch ? Number(vbMatch[2]) : 100;

  // Data Matrix квадратный — вписываем по высоте (после текста заголовка),
  // по центру ширины этикетки.
  const titleLine = escapeXml(itemName || '');
  const topMargin = 70; // место под заголовок сверху
  const bottomMargin = 14;
  const availH = height - topMargin - bottomMargin;
  const scale = Math.min(availH / dh, (width - 40) / dw);
  const dmW = dw * scale;
  const dmH = dh * scale;
  const dmX = (width - dmW) / 2;
  const dmY = topMargin;

  const innerMatch = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(dmSvg);
  const dmInner = innerMatch ? innerMatch[1] : dmSvg;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">` +
    `<text x="${width / 2}" y="34" text-anchor="middle" font-family="sans-serif" font-weight="bold" font-size="24">${titleLine}</text>` +
    `<text x="${width / 2}" y="58" text-anchor="middle" font-family="sans-serif" font-size="16">Честный знак</text>` +
    `<g transform="translate(${dmX}, ${dmY}) scale(${scale})">${dmInner}</g>` +
    `</svg>`;
}

/**
 * Компактный штрихкод ячейки хранения (Code128) для массовой печати наклеек
 * на стеллаж — только сам код (bwip-js includetext сам подписывает его под
 * штрихкодом своим шрифтом), без отдельного заголовка сверху, как у
 * generateItemLabelSvg — там заголовок нужен под название товара, здесь
 * печатают сразу пачками по 50-300 штук, и лишняя пустая строка сверху на
 * каждой только тратит место на листе.
 */
function generateLocationLabelSvg(locationCode, { width = 300, height = 130, barcodeHeightMm = 12 } = {}) {
  const barcodeSvg = bwipjs.toSVG({
    bcid: 'code128',
    text: String(locationCode),
    scale: 2,
    height: barcodeHeightMm,
    includetext: true,
    textxalign: 'center',
  });
  const vbMatch = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(barcodeSvg);
  const bw = vbMatch ? Number(vbMatch[1]) : 300;
  const bh = vbMatch ? Number(vbMatch[2]) : 100;

  const marginX = 16;
  const barcodeW = width - marginX * 2;
  const scale = barcodeW / bw;
  const barcodeH = Math.round(bh * scale);
  const barcodeX = marginX;
  const barcodeY = Math.round((height - barcodeH) / 2);

  const innerMatch = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(barcodeSvg);
  const barcodeInner = innerMatch ? innerMatch[1] : barcodeSvg;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">` +
    `<g transform="translate(${barcodeX}, ${barcodeY}) scale(${scale})">${barcodeInner}</g>` +
    `</svg>`;
}

module.exports = { generateQrSvg, generateShipmentLabelSvg, generateItemLabelSvg, generateMarkingLabelSvg, generateLocationLabelSvg };
