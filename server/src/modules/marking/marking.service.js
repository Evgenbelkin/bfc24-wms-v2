'use strict';

const { query, transaction } = require('../../config/database');
const { resolvePrinter } = require('../printing/printerResolver');
const { generateMarkingLabelSvg } = require('../../utils/qrcode');
const { ValidationError } = require('../../utils/errors');

// =============================================================================
// Marking Service — локальный учёт кодов "Честный знак"
// Только локальный учёт (без ЦРПТ), без агрегации (код = 1 физическая единица).
// Коды заранее импортируются оператором в пул на конкретный товар, затем
// раздаются по одному при приёмке/упаковке (см. allocateAndPrint).
// =============================================================================

/** Разобрать текстовый блок кодов (по одному на строку) в массив без пустых/дублей */
function parseCodesText(raw) {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
  return [...new Set(lines)];
}

/** Импортировать коды в пул на товар */
async function importCodes({ tenantId, itemId, createdBy, codesText }) {
  const codes = parseCodesText(codesText);
  if (codes.length === 0) throw new ValidationError('Нет ни одного кода для импорта');

  const itemRes = await query(`SELECT id FROM wms.items WHERE id=$1 AND tenant_id=$2`, [itemId, tenantId]);
  if (itemRes.rowCount === 0) throw new ValidationError('Item not found');

  let imported = 0;
  for (const code of codes) {
    const r = await query(
      `INSERT INTO wms.marking_codes (tenant_id, item_id, code, created_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, code) DO NOTHING
       RETURNING id`,
      [tenantId, itemId, code, createdBy]
    );
    if (r.rowCount > 0) imported++;
  }
  return { imported, duplicates: codes.length - imported, total_in_batch: codes.length };
}

/** Сводка по товару: сколько кодов свободно / использовано */
async function getCodesSummary({ tenantId, itemId }) {
  const r = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status='available')::int AS available,
       COUNT(*) FILTER (WHERE status='used')::int       AS used,
       COUNT(*)::int AS total
     FROM wms.marking_codes WHERE tenant_id=$1 AND item_id=$2`,
    [tenantId, itemId]
  );
  return r.rows[0];
}

/** Список кодов (для просмотра/отладки) */
async function listCodes({ tenantId, itemId, status = null, limit = 200, offset = 0 }) {
  const params = [tenantId, itemId];
  let cond = 'tenant_id=$1 AND item_id=$2';
  if (status) { cond += ` AND status=$3`; params.push(status); }
  params.push(Math.min(limit, 1000), Math.max(offset, 0));
  const r = await query(
    `SELECT id, code, status, used_at, used_ref_type, used_ref_id, created_at
     FROM wms.marking_codes WHERE ${cond}
     ORDER BY id
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return r.rows;
}

/** Нужно ли маркировать этот товар на данном этапе ('receiving' | 'packing') */
function shouldMarkAt(item, stage) {
  return !!(item && item.requires_marking && (item.marking_trigger || 'packing') === stage);
}

/**
 * Аллоцировать qty кодов из пула товара и создать print_job на каждый
 * (doc_type='marking_code') — рядом с обычным стикером товара/ВБ, чтобы оба
 * распечатывались одним и тем же действием сканирования.
 *
 * ЖЁСТКАЯ БЛОКИРОВКА (решение пользователя): если кодов в пуле не хватает,
 * либо не настроен принтер для doc_type='marking_code' — операция (приёмка/
 * упаковка) должна целиком блокироваться, а не продолжаться без стикера ЧЗ.
 * Поэтому здесь бросаем ValidationError вместо soft-fail лога — вызывающий
 * код (packing.service.js/receiving.service.js) НЕ оборачивает этот вызов в
 * try/catch, чтобы ошибка откатила всю транзакцию приёмки/упаковки целиком.
 *
 * dbClient — если передан (client внутри уже открытой транзакции, как в
 * packing.service.js:scanItem, или receiving.service.js), используем его —
 * тогда откат марки произойдёт вместе с откатом всей остальной операции.
 * Если не передан — открываем свою транзакцию только на аллокацию+печать.
 */
async function allocateAndPrint({
  tenantId, clientId, itemId, itemBarcode, itemName,
  qty = 1, refType, refId, userId, employeeId = null, dbClient = null,
}) {
  const q = Math.max(1, Math.round(Number(qty) || 1));

  const doAllocateAndPrint = async (client) => {
    // SELECT ... FOR UPDATE SKIP LOCKED + UPDATE обязаны выполняться в ОДНОЙ
    // транзакции — иначе лок снимается между запросами, и два параллельных
    // скана могут забрать один и тот же код.
    const pickRes = await client.query(
      `SELECT id, code FROM wms.marking_codes
       WHERE tenant_id=$1 AND item_id=$2 AND status='available'
       ORDER BY id LIMIT $3
       FOR UPDATE SKIP LOCKED`,
      [tenantId, itemId, q]
    );
    if (pickRes.rowCount < q) {
      // НИЧЕГО не резервируем при недостаче — коды остаются available,
      // операция должна быть полностью отменена и повторена после пополнения пула.
      throw new ValidationError(
        `Товар помечен как требующий маркировки "Честный знак", но в пуле недостаточно кодов ` +
        `(нужно ${q}, доступно ${pickRes.rowCount}). Загрузите коды в пул (в справочнике товара ` +
        `или в кабинете клиента) и повторите операцию.`
      );
    }

    const resolved = await resolvePrinter(client.query.bind(client), {
      tenantId, docType: 'marking_code', employeeId: employeeId || userId, clientId,
    });
    if (!resolved) {
      throw new ValidationError(
        `Не найден принтер для печати кода маркировки "Честный знак" (doc_type=marking_code) — ` +
        `настройте маршрут печати в панели принтеров или рабочее место сотрудника со своим принтером.`
      );
    }

    const ids = pickRes.rows.map(r => r.id);
    await client.query(
      `UPDATE wms.marking_codes SET status='used', used_at=NOW(),
         used_ref_type=$1, used_ref_id=$2, used_by=$3
       WHERE id = ANY($4::bigint[])`,
      [refType, refId, userId, ids]
    );

    const jobIds = [];
    for (const row of pickRes.rows) {
      const svg = generateMarkingLabelSvg(row.code, itemName);
      const jobCode = `MARK-${itemId}-${row.id}-${Date.now()}`;
      const pjRes = await client.query(
        `INSERT INTO wms.print_jobs
           (tenant_id,job_code,printer_id,route_id,doc_type,entity_type,entity_id,copies,payload_json,status,created_by)
         VALUES($1,$2,$3,$4,'marking_code','item',$5,1,$6::jsonb,'new',$7)
         RETURNING id`,
        [
          tenantId, jobCode, resolved.printerId, resolved.routeId, itemId,
          JSON.stringify({ sticker: svg, code: row.code, barcode: itemBarcode, item_name: itemName }),
          userId,
        ]
      );
      jobIds.push(pjRes.rows[0].id);
    }

    const remainingRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM wms.marking_codes WHERE tenant_id=$1 AND item_id=$2 AND status='available'`,
      [tenantId, itemId]
    );

    return { allocated: ids.length, shortfall: 0, printed: jobIds.length, jobIds, remaining: remainingRes.rows[0].n };
  };

  return dbClient ? doAllocateAndPrint(dbClient) : transaction(doAllocateAndPrint);
}

module.exports = {
  parseCodesText, importCodes, getCodesSummary, listCodes,
  shouldMarkAt, allocateAndPrint,
};
