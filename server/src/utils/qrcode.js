'use strict';

const QRCode = require('qrcode');

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

module.exports = { generateQrSvg, generateShipmentLabelSvg };
