'use strict';

const crypto = require('crypto');
const config = require('../config');

// =============================================================================
// Короткоживущий подписанный токен для QR-чек-ина сотрудников на складе.
//
// Тот же принцип, что и в agentKey.js для printer-agent: HMAC-SHA256 вместо
// чего-то более тяжёлого, и никакого обращения к БД ни на выпуск токена, ни
// на его проверку — токен целиком самодостаточен (timestamp + подпись), а
// "протух" он или нет решается сравнением с текущим временем. Экран старшего
// смены дёргает /checkin/token каждые ~60 секунд и просто рисует новый QR —
// хранить что-либо на сервере ради этого не нужно.
//
// Модель безопасности здесь — не "одноразовый токен от подделки", а "человек
// физически стоял рядом с экраном в последние ~90 секунд". Для складского
// чек-ина этого достаточно; создавать более тяжёлую защиту (nonce в БД,
// single-use) избыточно ровно по той же логике, что и agentKey.js.
// =============================================================================

const CHECKIN_TOKEN_TTL_MS = 90 * 1000; // окно на "поднести телефон и отсканировать"
const CLOCK_SKEW_MS = 5 * 1000;         // небольшой запас на рассинхрон часов клиент/сервер

function sign(ts) {
  return crypto.createHmac('sha256', config.jwt.secret)
    .update(`checkin:${ts}`)
    .digest('hex')
    .slice(0, 32);
}

function signCheckinToken(ts = Date.now()) {
  return `${ts}.${sign(ts)}`;
}

function verifyCheckinToken(token) {
  if (!token || typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;

  const ts = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!Number.isFinite(ts) || !sig) return false;

  const age = Date.now() - ts;
  if (age > CHECKIN_TOKEN_TTL_MS || age < -CLOCK_SKEW_MS) return false;

  const expected = sign(ts);
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { signCheckinToken, verifyCheckinToken, CHECKIN_TOKEN_TTL_MS };
