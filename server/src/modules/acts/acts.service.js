'use strict';

const { query, transaction } = require('../../config/database');
const { NotFoundError, ValidationError, ForbiddenError } = require('../../utils/errors');

// =============================================================================
// Acceptance Acts Service — Акт приёмки товара
//
// Акт формируется либо по заявке (inbound_order_id задан, строки — снимок
// wms.inbound_order_lines на момент формирования), либо без заявки (машина
// приехала без предварительной заявки, приняли свободной приёмкой — строки
// оператор собирает вручную, обычно подтягивая их из уже принятого через
// getFreeReceivingLinesForAct). В обоих случаях акт — самостоятельная
// сущность со своим набором строк, не завязанная жёстко на заявку.
// =============================================================================

const trim = (v, max) => (v ? String(v).trim().slice(0, max) : null);
const toIntOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};
const toNumOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function actFieldsFromInput(act, order = {}) {
  return {
    act_city: trim(act.act_city, 100),
    act_supplier: trim(act.act_supplier, 300),
    act_boxes_count: toIntOrNull(act.act_boxes_count),
    act_pallets_count: toIntOrNull(act.act_pallets_count),
    act_weight_kg: toNumOrNull(act.act_weight_kg),
    act_carrier: trim(act.act_carrier, 300),
    act_source_doc: trim(act.act_source_doc, 300),
    act_packaging_ok: act.act_packaging_ok === undefined || act.act_packaging_ok === null ? null : Boolean(act.act_packaging_ok),
    act_remarks: trim(act.act_remarks, 2000),
    act_client_signer: trim(act.act_client_signer, 200),
    act_operator_signer: trim(act.act_operator_signer, 200),
    driver_name: trim(act.driver_name, 200) ?? trim(order.driver_name, 200) ?? null,
    vehicle_make: trim(act.vehicle_make, 200) ?? trim(order.vehicle_make, 200) ?? null,
  };
}

/**
 * Сформировать акт. Если inboundOrderId задан — проверяем, что заявка
 * принадлежит tenant'у и клиенту. Строки приходят от вызывающей стороны
 * (роутер/фронтенд уже собрал их — из wms.inbound_order_lines для акта по
 * заявке, или вручную/из истории свободной приёмки для акта без заявки).
 */
async function createAct({ tenantId, warehouseId, clientId, userId, inboundOrderId = null, act = {}, lines = [], dateFrom = null, dateTo = null }) {
  if (!lines.length || !lines.some(l => Number(l.qty_received) > 0)) {
    throw new ValidationError('В акте должна быть хотя бы одна позиция с фактическим количеством > 0');
  }

  return transaction(async (client) => {
    let order = {};
    if (inboundOrderId) {
      const orderRes = await client.query(
        `SELECT id, order_number, client_id, driver_name, vehicle_make
         FROM wms.inbound_orders WHERE id=$1 AND tenant_id=$2`,
        [inboundOrderId, tenantId]
      );
      if (orderRes.rowCount === 0) throw new NotFoundError('InboundOrder', inboundOrderId);
      order = orderRes.rows[0];
      if (order.client_id !== clientId) throw new ForbiddenError('Order belongs to a different client');
    }

    const numberRes = await client.query(`SELECT wms.generate_act_number($1) AS n`, [tenantId]);
    const actNumber = trim(act.act_number, 100) || order.order_number || numberRes.rows[0].n;

    const f = actFieldsFromInput(act, order);
    const actRes = await client.query(
      `INSERT INTO wms.acceptance_acts
         (tenant_id, warehouse_id, client_id, inbound_order_id, act_number,
          act_city, act_supplier, act_boxes_count, act_pallets_count, act_weight_kg,
          act_carrier, act_source_doc, act_packaging_ok, act_remarks,
          act_client_signer, act_operator_signer, driver_name, vehicle_make, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [
        tenantId, warehouseId, clientId, inboundOrderId, actNumber,
        f.act_city, f.act_supplier, f.act_boxes_count, f.act_pallets_count, f.act_weight_kg,
        f.act_carrier, f.act_source_doc, f.act_packaging_ok, f.act_remarks,
        f.act_client_signer, f.act_operator_signer, f.driver_name, f.vehicle_make, userId,
      ]
    );
    const savedAct = actRes.rows[0];

    for (const l of lines) {
      await client.query(
        `INSERT INTO wms.acceptance_act_lines
           (act_id, tenant_id, item_id, barcode, item_name, qty_expected, qty_received, qty_damaged, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          savedAct.id, tenantId,
          l.item_id || null, trim(l.barcode, 200), trim(l.item_name, 300),
          toIntOrNull(l.qty_expected), toIntOrNull(l.qty_received) || 0, toIntOrNull(l.qty_damaged) || 0,
          trim(l.notes, 500),
        ]
      );
    }

    const linesRes = await client.query(
      `SELECT * FROM wms.acceptance_act_lines WHERE act_id=$1 ORDER BY id`, [savedAct.id]
    );

    // Помечаем покрытые этим актом receiving_tasks - см. комментарий в
    // миграции 040. Для акта по заявке - всё ещё непокрытое по этой заявке;
    // для акта без заявки - весь непокрытый "хвост" свободной приёмки по
    // этому клиенту (акт без заявки формируется как раз чтобы закрыть его
    // целиком перед уходом из модуля, см. requireNoUncoveredReceiving).
    if (inboundOrderId) {
      await client.query(
        `UPDATE wms.receiving_tasks SET act_id=$1
         WHERE tenant_id=$2 AND inbound_order_id=$3 AND act_id IS NULL`,
        [savedAct.id, tenantId, inboundOrderId]
      );
    } else if (dateFrom && dateTo) {
      // Помечаем покрытым ровно то, что оператор реально видел в форме акта
      // (тот же период dateFrom/dateTo, что и запрос /acts/free-lines перед
      // сохранением) - а не вообще всё непокрытое по клиенту когда-либо,
      // иначе можно было бы молча "закрыть" актом то, что в самом акте
      // никак не отражено (см. миграцию 040).
      await client.query(
        `UPDATE wms.receiving_tasks SET act_id=$1
         WHERE tenant_id=$2 AND client_id=$3 AND inbound_order_id IS NULL AND act_id IS NULL
           AND completed_at>=$4::date AND completed_at<($5::date+interval '1 day')`,
        [savedAct.id, tenantId, clientId, dateFrom, dateTo]
      );
    }

    return { act: savedAct, lines: linesRes.rows };
  });
}

/**
 * Есть ли по клиенту хоть одна фактически принятая (qty_received>0), но ещё
 * не покрытая актом приёмка - используется как гейт "нельзя выйти из модуля
 * приёмки / сменить клиента / закрыть заявку, пока не сформирован акт".
 * warehouseId опционален - на приёмке сотрудник обычно уже привязан к
 * конкретному складу, но клиент может принимать на разных складах, гейт
 * должен видеть непокрытое по клиенту в целом, а не только на одном складе.
 */
async function hasUncoveredReceiving({ tenantId, clientId, inboundOrderId = null, anySource = false }) {
  const params = [tenantId, clientId];
  // act_exempt=TRUE - приёмка, случившаяся до включения этого гейта (см.
  // миграцию 041) - её не требуем закрывать актом задним числом.
  let cond = `tenant_id=$1 AND client_id=$2 AND act_id IS NULL AND act_exempt=FALSE AND qty_received > 0`;
  if (anySource) {
    // Не важно, откуда - свободная приёмка или по любой заявке - используется
    // для гейта "нельзя выйти из модуля приёмки/сменить клиента вообще".
  } else if (inboundOrderId) {
    params.push(inboundOrderId);
    cond += ` AND inbound_order_id=$${params.length}`;
  } else {
    cond += ` AND inbound_order_id IS NULL`;
  }
  const r = await query(
    `SELECT COUNT(*)::int AS n FROM wms.receiving_tasks WHERE ${cond}`,
    params
  );
  return r.rows[0].n > 0;
}

/** Передать/отозвать акт в личный кабинет клиента - см. миграцию 040 и
 *  комментарий в seller.router.js про то, почему по умолчанию акты клиенту
 *  не видны. */
async function setActShared({ tenantId, actId, userId, shared }) {
  const r = await query(
    `UPDATE wms.acceptance_acts
     SET shared_with_client_at = CASE WHEN $3 THEN NOW() ELSE NULL END,
         shared_with_client_by = CASE WHEN $3 THEN $4 ELSE NULL END,
         updated_at = NOW()
     WHERE id=$1 AND tenant_id=$2
     RETURNING *`,
    [actId, tenantId, !!shared, userId]
  );
  if (r.rowCount === 0) throw new NotFoundError('AcceptanceAct', actId);
  return r.rows[0];
}

async function getAct({ tenantId, actId }) {
  const actRes = await query(
    `SELECT a.*, c.client_name, c.legal_name AS client_legal_name, c.inn AS client_inn, c.legal_address AS client_legal_address,
            w.warehouse_name, o.order_number
     FROM wms.acceptance_acts a
     JOIN wms.clients c ON c.id = a.client_id
     JOIN wms.warehouses w ON w.id = a.warehouse_id
     LEFT JOIN wms.inbound_orders o ON o.id = a.inbound_order_id
     WHERE a.id=$1 AND a.tenant_id=$2`,
    [actId, tenantId]
  );
  if (actRes.rowCount === 0) throw new NotFoundError('AcceptanceAct', actId);

  const linesRes = await query(
    `SELECT * FROM wms.acceptance_act_lines WHERE act_id=$1 ORDER BY id`, [actId]
  );
  return { act: actRes.rows[0], lines: linesRes.rows };
}

async function updateAct({ tenantId, actId, act = {}, lines = null }) {
  return transaction(async (client) => {
    const existing = await client.query(
      `SELECT id FROM wms.acceptance_acts WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
      [actId, tenantId]
    );
    if (existing.rowCount === 0) throw new NotFoundError('AcceptanceAct', actId);

    const f = actFieldsFromInput(act);
    const updated = await client.query(
      `UPDATE wms.acceptance_acts SET
         act_number=COALESCE($1, act_number),
         act_city=$2, act_supplier=$3, act_boxes_count=$4, act_pallets_count=$5, act_weight_kg=$6,
         act_carrier=$7, act_source_doc=$8, act_packaging_ok=$9, act_remarks=$10,
         act_client_signer=$11, act_operator_signer=$12, driver_name=$13, vehicle_make=$14,
         updated_at=NOW()
       WHERE id=$15
       RETURNING *`,
      [
        trim(act.act_number, 100),
        f.act_city, f.act_supplier, f.act_boxes_count, f.act_pallets_count, f.act_weight_kg,
        f.act_carrier, f.act_source_doc, f.act_packaging_ok, f.act_remarks,
        f.act_client_signer, f.act_operator_signer, f.driver_name, f.vehicle_make,
        actId,
      ]
    );

    if (Array.isArray(lines)) {
      if (!lines.length || !lines.some(l => Number(l.qty_received) > 0)) {
        throw new ValidationError('В акте должна быть хотя бы одна позиция с фактическим количеством > 0');
      }
      await client.query(`DELETE FROM wms.acceptance_act_lines WHERE act_id=$1`, [actId]);
      for (const l of lines) {
        await client.query(
          `INSERT INTO wms.acceptance_act_lines
             (act_id, tenant_id, item_id, barcode, item_name, qty_expected, qty_received, qty_damaged, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            actId, tenantId,
            l.item_id || null, trim(l.barcode, 200), trim(l.item_name, 300),
            toIntOrNull(l.qty_expected), toIntOrNull(l.qty_received) || 0, toIntOrNull(l.qty_damaged) || 0,
            trim(l.notes, 500),
          ]
        );
      }
    }

    const linesRes = await client.query(
      `SELECT * FROM wms.acceptance_act_lines WHERE act_id=$1 ORDER BY id`, [actId]
    );
    return { act: updated.rows[0], lines: linesRes.rows };
  });
}

async function listActs({ tenantId, clientId = null, inboundOrderId = null, dateFrom = null, dateTo = null, limit = 100, offset = 0, onlyShared = false }) {
  const params = [tenantId]; const conds = ['a.tenant_id=$1']; let idx = 2;
  if (clientId) { conds.push(`a.client_id=$${idx++}`); params.push(clientId); }
  if (inboundOrderId) { conds.push(`a.inbound_order_id=$${idx++}`); params.push(inboundOrderId); }
  if (dateFrom) { conds.push(`a.created_at>=$${idx++}::date`); params.push(dateFrom); }
  if (dateTo)   { conds.push(`a.created_at<($${idx++}::date+interval '1 day')`); params.push(dateTo); }
  if (onlyShared) { conds.push(`a.shared_with_client_at IS NOT NULL`); }
  params.push(Math.min(limit, 500), Math.max(offset, 0));
  const r = await query(
    `SELECT a.id, a.act_number, a.created_at, a.inbound_order_id, o.order_number,
            a.shared_with_client_at,
            c.client_name, (SELECT COUNT(*)::int FROM wms.acceptance_act_lines l WHERE l.act_id=a.id) AS lines_count
     FROM wms.acceptance_acts a
     JOIN wms.clients c ON c.id = a.client_id
     LEFT JOIN wms.inbound_orders o ON o.id = a.inbound_order_id
     WHERE ${conds.join(' AND ')}
     ORDER BY a.created_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params
  );
  return r.rows;
}

/**
 * Позиции для черновика акта "без заявки" — агрегируем то, что реально
 * приняли свободной приёмкой (wms.receiving_tasks, inbound_order_id IS NULL)
 * за период по клиенту. Оператор может дальше руками поправить количество/
 * добавить или убрать строки перед сохранением акта.
 */
async function getFreeReceivingLinesForAct({ tenantId, clientId, warehouseId = null, dateFrom, dateTo }) {
  if (!dateFrom || !dateTo) throw new ValidationError('date_from and date_to are required');
  const params = [tenantId, clientId, dateFrom, dateTo];
  let cond = `rt.tenant_id=$1 AND rt.client_id=$2 AND rt.inbound_order_id IS NULL
              AND rt.completed_at>=$3::date AND rt.completed_at<($4::date+interval '1 day')`;
  if (warehouseId) { params.push(warehouseId); cond += ` AND rt.warehouse_id=$${params.length}`; }

  const r = await query(
    `SELECT rt.item_id, rt.barcode, COALESCE(MAX(i.item_name), rt.barcode) AS item_name,
            SUM(rt.qty_received)::int AS qty_received
     FROM wms.receiving_tasks rt
     LEFT JOIN wms.items i ON i.id = rt.item_id
     WHERE ${cond}
     GROUP BY rt.item_id, rt.barcode
     ORDER BY item_name`,
    params
  );
  return r.rows;
}

module.exports = { createAct, getAct, updateAct, listActs, getFreeReceivingLinesForAct, hasUncoveredReceiving, setActShared };
