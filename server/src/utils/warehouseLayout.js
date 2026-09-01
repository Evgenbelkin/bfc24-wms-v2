'use strict';

/**
 * Порядок обхода склада по коду ячейки вида "A-<ряд>-<позиция>" (например
 * A-01-01 .. A-01-20) — где буква (+ необязательный номер зоны, слитно:
 * A, A1, A12...) это стеллаж/зона, второе число это ряд (уровень полки по
 * высоте — не требует лишней ходьбы), третье число — позиция ВДОЛЬ стеллажа
 * (собственно ходьба). Идти нужно по позиции — она первична, ряд вторичен.
 *
 * Вынесено из picking.service.js в общий модуль 01.09.2026 — та же логика
 * понадобилась в placement.service.js (подсказка ближайшей свободной ячейки
 * при размещении), дублировать её там было бы риском разъехаться местами.
 */
function locationWalkKey(code) {
  const raw = String(code || '').trim().toUpperCase();
  const m = /^([A-ZА-Я]+)(\d*)-(\d+)-(\d+)$/.exec(raw);
  if (!m) return { pattern: false, raw };
  return {
    pattern: true,
    zoneLetter: m[1],
    zoneNum: m[2] ? parseInt(m[2], 10) : null,
    row: parseInt(m[3], 10),
    position: parseInt(m[4], 10),
  };
}

function compareWalkKeys(a, b) {
  if (a.pattern && b.pattern) {
    if (a.zoneLetter !== b.zoneLetter) return a.zoneLetter < b.zoneLetter ? -1 : 1;
    const an = a.zoneNum === null ? -1 : a.zoneNum;
    const bn = b.zoneNum === null ? -1 : b.zoneNum;
    if (an !== bn) return an - bn;
    if (a.position !== b.position) return a.position - b.position;
    return a.row - b.row;
  }
  if (a.pattern !== b.pattern) return a.pattern ? -1 : 1;
  return a.raw < b.raw ? -1 : (a.raw > b.raw ? 1 : 0);
}

module.exports = { locationWalkKey, compareWalkKeys };
