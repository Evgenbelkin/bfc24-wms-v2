'use strict';

const QRCode = require('qrcode');

/**
 * Сгенерировать QR-код как SVG-строку (для печати через printer-agent,
 * который уже умеет рендерить SVG → PDF → на принтер).
 */
function generateQrSvg(text, { width = 240, margin = 1 } = {}) {
  return QRCode.toString(String(text), { type: 'svg', margin, width });
}

module.exports = { generateQrSvg };
