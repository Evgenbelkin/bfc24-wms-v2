'use strict';

const { query, transaction } = require('../../config/database');
const { resolvePrinter } = require('../printing/printerResolver');
const { generateMarkingLabelSvg } = require('../../utils/qrcode');
const { ValidationError } = require('../../utils/errors');
const logger = require('../../utils/logger');

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
 * dbClient — если передан (client внутри уже открытой транзакции, как в
 * packing.service.js:scanItem), используем его; иначе — обычный pool query
 * (для fire-and-forget вызова после коммита, как в receiving.service.js).
 * Soft-fail: любая ошибка здесь не должна ломать основную операцию — вызывающий
 * код сам оборачивает в try/catch, но на всякий случай не бросаем ничего
 * критичного дальше самих валидационных ошибок вызова.
 */
async function allocateAndPrint({
  tenantId, clientId, itemId, itemBarcode, itemName,
  qty = 1, refType, refId, userId, employeeId = null, dbClient = null,
}) {
  const q = Math.max(1, Math.round(Number(qty) || 1));

  // SELECT ... FOR UPDATE SKIP LOCKED + UPDATE обязаны выполняться в ОДНОЙ
  // транзакции — иначе между ними лок снимается (каждый query() вне
  // transaction() — это своя неявная транзакция), и два параллельных вызова
  // могут забрать один и тот же код. Если вызывающий код уже внутри своей
  // транзакции (packing.service.js передаёт dbClient=client) — используем её.
  // Если нет (receiving вызывает fire-and-forget после коммита) — открываем
  // свою короткую транзакцию только на аллокацию.
  const pickAndReserve = async (client) => {
    const pickRes = await client.query(
      `SELECT id, code FROM wms.marking_codes
       WHERE tenant_id=$1 AND item_id=$2 AND status='available'
       ORDER BY id LIMIT $3
       FOR UPDATE SKIP LOCKED`,
      [tenantId, itemId, q]
    );
    if (pickRes.rowCount === 0) return [];
    const ids = pickRes.rows.map(r => r.id);
    await client.query(
      `UPDATE wms.marking_codes SET status='used', used_at=NOW(),
         used_ref_type=$1, used_ref_id=$2, used_by=$3
       WHERE id = ANY($4::bigint[])`,
      [refType, refId, userId, ids]
    );
    return pickRes.rows;
  };

  const allocatedRows = dbClient
    ? await pickAndReserve(dbClient)
    : await transaction(pickAndReserve);

  if (allocatedRows.length === 0) {
    logger.warn({ tenantId, itemId }, 'Marking: нет свободных кодов в пуле для товара');
    return { allocated: 0, shortfall: q, printed: 0, jobIds: [] };
  }
  const ids = allocatedRows.map(r => r.id);

  const runQuery = dbClient ? dbClient.query.bind(dbClient) : (sql, params) => query(sql, params);
  const resolved = await resolvePrinter(runQuery, {
    tenantId, docType: 'marking_code', employeeId: employeeId || userId, clientId,
  });

  const jobIds = [];
  if (resolved) {
    for (const row of allocatedRows) {
      try {
        const svg = generateMarkingLabelSvg(row.code, itemName);
        const jobCode = `MARK-${itemId}-${row.id}-${Date.now()}`;
        const pjRes = await runQuery(
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
      } catch (err) {
        logger.warn({ err, tenantId, itemId, codeId: row.id }, 'Marking: print_job creation failed (soft-fail)');
      }
    }
  } else {
    logger.warn({ tenantId, itemId }, 'Marking: printer route для doc_type=marking_code не найден — коды зарезервированы, но не напечатаны');
  }

  return { allocated: ids.length, shortfall: q - ids.length, printed: jobIds.length, jobIds };
}

module.exports = {
  parseCodesText, importCodes, getCodesSummary, listCodes,
  shouldMarkAt, allocateAndPrint,
};
