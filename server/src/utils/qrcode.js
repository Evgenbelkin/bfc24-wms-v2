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
 * Линейный штрихкод (Code128) с номером поставки + количеством ШК в ней —
 * для внутренней наклейки "pick_list_label". Раньше здесь был QR-код (см.
 * историю коммитов) — заменили 01.09.2026 по просьбе владельца: часть ТСД
 * на складе (обычные лазерные 1D-сканеры) физически не умеют считывать QR,
 * а линейный штрихкод — гарантированно. Заодно добавили количество ШК в
 * поставке текстом (раньше на наклейке было только "какой это отгрузке" без
 * "сколько внутри").
 * Тот же приём вписывания без обрезки, что и в generateItemLabelSvg ниже —
 * transform="translate() scale()" на <g> с содержимым штрихкода, а НЕ вложенный
 * <svg width height>: движок печати агента (svg-to-pdfkit) не умеет
 * авто-масштабировать вложенные <svg> по их viewBox, как это делает браузер —
 * без этого приёма штрихкод рисовался в "сыром" размере bwip-js без
 * масштаба и уезжал за край этикетки. Кириллица в <text> (сам текст
 * "Кол-во ШК: N" пишется латиницей/цифрами специально, чтобы не зависеть от
 * шрифта) рендерится агентом через зарегистрированный DejaVuSans (см.
 * printer-agent/agent.js ensureCyrillicFont).
 * qty — необязательный (для обратной совместимости с местами, где количество
 * ещё не подсчитано) — если не передан, вторая строка просто не рисуется.
 */
function generateShipmentLabelSvg(shipmentCode, qty = null, { width = 400, height = 280 } = {}) {
  const barcodeSvg = bwipjs.toSVG({
    bcid: 'code128',
    text: String(shipmentCode),
    scale: 2,
    height: 10,
    includetext: true,
    textxalign: 'center',
  });
  const vbMatch = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(barcodeSvg);
  const bw = vbMatch ? Number(vbMatch[1]) : 300;
  const bh = vbMatch ? Number(vbMatch[2]) : 100;
  const marginX = 24;
  const barcodeW = width - marginX * 2;
  const scale = barcodeW / bw;
  const barcodeH = Math.round(bh * scale);
  const barcodeX = marginX;
  const barcodeY = height - barcodeH - 16;
  const innerMatch = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(barcodeSvg);
  const barcodeInner = innerMatch ? innerMatch[1] : barcodeSvg;

  const qtyLine = (qty === null || qty === undefined)
    ? ''
    : `<text x="${width / 2}" y="80" text-anchor="middle" font-family="sans-serif" font-size="24">Кол-во ШК: ${escapeXml(qty)}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">` +
    `<text x="${width / 2}" y="46" text-anchor="middle" font-family="sans-serif" font-weight="bold" font-size="34">${escapeXml(shipmentCode)}</text>` +
    qtyLine +
    `<g transform="translate(${barcodeX}, ${barcodeY}) scale(${scale})">${barcodeInner}</g>` +
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
// Название товара раньше рисовалось ОДНОЙ строкой фиксированным font-size=26
// без переноса - у длинных названий текст просто уезжал за края этикетки
// (в SVG нет автопереноса/autofit, как в HTML). Тут грубая, но рабочая
// прикидка: подбираем шрифт помельче и переносим на до 2 строк по количеству
// символов, оценивая среднюю ширину символа жирного кириллического текста
// как ~0.62 от размера шрифта - не идеальная типографика, но гарантированно
// не даёт тексту вылезти за viewBox. Если и в 2 строки при самом мелком
// шрифте не влезает - обрезаем последнюю строку многоточием.
function wrapItemTitle(text, { width = 400, marginX = 20, maxLines = 2 } = {}) {
  const usableWidth = width - marginX * 2;
  const fontSizes = [26, 22, 18];
  const avgCharWidthFactor = 0.62;
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { fontSize: fontSizes[0], lines: [''] };

  function wrapAt(maxCharsPerLine) {
    const lines = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length <= maxCharsPerLine) { current = candidate; continue; }
      if (current) lines.push(current);
      current = word.length > maxCharsPerLine ? word.slice(0, maxCharsPerLine) : word;
    }
    if (current) lines.push(current);
    return lines;
  }

  for (const fontSize of fontSizes) {
    const maxCharsPerLine = Math.max(6, Math.floor(usableWidth / (fontSize * avgCharWidthFactor)));
    const lines = wrapAt(maxCharsPerLine);
    if (lines.length <= maxLines) return { fontSize, lines };
  }
  const fontSize = fontSizes[fontSizes.length - 1];
  const maxCharsPerLine = Math.max(6, Math.floor(usableWidth / (fontSize * avgCharWidthFactor)));
  const lines = wrapAt(maxCharsPerLine).slice(0, maxLines);
  const last = lines[maxLines - 1] || '';
  lines[maxLines - 1] = (last.length > maxCharsPerLine - 1 ? last.slice(0, maxCharsPerLine - 1).replace(/\s+$/, '') : last) + '…';
  return { fontSize, lines };
}

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

  const { fontSize: titleFontSize, lines: titleLines } = wrapItemTitle(itemName, { width });
  const lineHeight = titleFontSize + 6;
  const titleStartY = titleFontSize + 6;
  const titleSvg = titleLines.map((line, i) =>
    `<text x="${width / 2}" y="${titleStartY + i * lineHeight}" text-anchor="middle" font-family="sans-serif" font-weight="bold" font-size="${titleFontSize}">${escapeXml(line)}</text>`
  ).join('');
  const subLineY = titleStartY + (titleLines.length - 1) * lineHeight + 28;
  const subLine = vendorCode ? escapeXml(`Артикул: ${vendorCode}`) : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">` +
    titleSvg +
    (subLine ? `<text x="${width / 2}" y="${subLineY}" text-anchor="middle" font-family="sans-serif" font-size="20">${subLine}</text>` : '') +
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
 * Штрихкод заявки на поставку — печатается со склада для водителя, у которого
 * нет собственной распечатки (штрихкод сканируется на приёмке через
 * "По заявке" вместо ручного ввода). В отличие от generateShipmentLabelSvg,
 * где в QR/тексте кодируется ОДНА и та же строка, здесь два РАЗНЫХ значения:
 * в сам QR зашивается длинный технический barcode (то, что реально сканирует
 * receiving.html), а под ним человекочитаемым текстом — короткий order_number
 * (то, по чему кладовщик и водитель узнают заявку глазами). Печать QR, а не
 * Code128 (как у ячеек) — потому что barcode заявки длинный
 * буквенно-цифровой (IN29D7F576BAC04C12AEFCAA74735DED71), и Code128 на него
 * получился бы неоправданно широким для этикетки.
 */
async function generateInboundOrderLabelSvg(barcode, orderNumber, { qrSize = 260, width = 320, height = 360, fontSize = 30 } = {}) {
  const qrSvg = await QRCode.toString(String(barcode), { type: 'svg', margin: 1, width: qrSize });
  const qrX = Math.round((width - qrSize) / 2);
  const textY = qrSize + 40;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">` +
    `<svg x="${qrX}" y="10" width="${qrSize}" height="${qrSize}">${qrSvg}</svg>` +
    `<text x="${width / 2}" y="${textY}" text-anchor="middle" font-family="sans-serif" ` +
    `font-weight="bold" font-size="${fontSize}">${escapeXml(orderNumber)}</text>` +
    `</svg>`;
}

/**
 * Компактный штрихкод ячейки хранения (Code128) для массовой печати наклеек
 * на стеллаж, без отдельного заголовка сверху, как у generateItemLabelSvg —
 * там заголовок нужен под название товара, здесь печатают сразу пачками по
 * 50-300 штук, и лишняя пустая строка сверху на каждой только тратит место
 * на листе. Код под штрихкодом рисуем СВОИМ жирным <text> (а не встроенной
 * подписью bwip-js через includetext) — родной шрифт bwip-js для
 * человекочитаемой подписи тонкий и мелкий, плохо читается на наклейке
 * издалека; так толщину/размер можно задать явно.
 */
function generateLocationLabelSvg(locationCode, { width = 300, height = 150, barcodeHeightMm = 12, fontSize = 34 } = {}) {
  const code = String(locationCode);
  const barcodeSvg = bwipjs.toSVG({
    bcid: 'code128',
    text: code,
    scale: 2,
    height: barcodeHeightMm,
    includetext: false,
  });
  const vbMatch = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(barcodeSvg);
  const bw = vbMatch ? Number(vbMatch[1]) : 300;
  const bh = vbMatch ? Number(vbMatch[2]) : 80;

  const marginX = 16;
  const textAreaH = fontSize + 18; // место под жирный код снизу
  const barcodeAreaH = height - textAreaH;
  const barcodeW = width - marginX * 2;
  const scale = Math.min(barcodeW / bw, barcodeAreaH / bh);
  const barcodeH = bh * scale;
  const barcodeX = (width - bw * scale) / 2;
  const barcodeY = Math.round((barcodeAreaH - barcodeH) / 2);

  const innerMatch = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(barcodeSvg);
  const barcodeInner = innerMatch ? innerMatch[1] : barcodeSvg;

  const textY = barcodeAreaH + fontSize;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">` +
    `<g transform="translate(${barcodeX}, ${barcodeY}) scale(${scale})">${barcodeInner}</g>` +
    `<text x="${width / 2}" y="${textY}" text-anchor="middle" font-family="sans-serif" font-weight="bold" font-size="${fontSize}">${escapeXml(code)}</text>` +
    `</svg>`;
}

module.exports = { generateQrSvg, generateShipmentLabelSvg, generateItemLabelSvg, generateMarkingLabelSvg, generateLocationLabelSvg, generateInboundOrderLabelSvg };
