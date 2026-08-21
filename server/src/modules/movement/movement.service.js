'use strict';

const { query, transaction } = require('../../config/database');
const ledger = require('../stock/stock.ledger');
const {
  NotFoundError,
  ValidationError,
  InsufficientStockError,
} = require('../../utils/errors');
const { validateBarcode, validateQty } = require('../../utils/validators');
const logger = require('../../utils/logger');
const { triggerRedistributionForClient } = require('../wb/wb.service');

// =============================================================================
// Movement Service
//
// Внутреннее перемещение между любыми ячейками (rack↔rack, rack↔buffer, etc.)
// В отличие от placement — нет ограничений на тип FROM/TO ячейки.
//
// API:
//   moveItem          — переместить qty единиц barcode из A в B
//   moveBatch         — пакетное перемещение
//   listMovements     — история перемещений (movement_type='move')
//   getLocationStock  — актуальный остаток по ячейке для предварительной проверки
// =============================================================================

/**
 * Переместить товар из одной ячейки в другую
 */
async function moveItem({
  tenantId,
  warehouseId,
  clientId,
  barcode,
  fromLocationCode,
  toLocationCode,
  qty,
  userId,
  comment,
}) {
  const b = validateBarcode(barcode);
  const q = validateQty(qty, 'qty');

  if (!fromLocationCode || !toLocationCode) {
    throw new ValidationError('from_location_code and to_location_code are required');
  }

  const fromCode = String(fromLocationCode).trim().toUpperCase();
  const toCode   = String(toLocationCode).trim().toUpperCase();
  if (fromCode === toCode) throw new ValidationError('From and to locations must differ');

  const result = await transaction(async (client) => {
    // Резолвим FROM
    const fromRes = await client.query(
      `SELECT id, location_code, location_type, is_active FROM wms.locations
       WHERE tenant_id=$1 AND warehouse_id=$2 AND location_code=$3 LIMIT 1`,
      [tenantId, warehouseId, fromCode]
    );
    if (fromRes.rowCount === 0) throw new NotFoundError(`Location '${fromCode}'`);
    const fromLoc = fromRes.rows[0];
    if (!fromLoc.is_active) throw new ValidationError(`Location '${fromCode}' is inactive`);

    // Резолвим TO
    const toRes = await client.query(
      `SELECT id, location_code, location_type, is_active FROM wms.locations
       WHERE tenant_id=$1 AND warehouse_id=$2 AND location_code=$3 LIMIT 1`,
      [tenantId, warehouseId, toCode]
    );
    if (toRes.rowCount === 0) throw new NotFoundError(`Location '${toCode}'`);
    const toLoc = toRes.rows[0];
    if (!toLoc.is_active) throw new ValidationError(`Location '${toCode}' is inactive`);

    // item_id
    const itemRes = await client.query(
      `SELECT id FROM wms.items WHERE tenant_id=$1 AND client_id=$2 AND barcode=$3 LIMIT 1`,
      [tenantId, clientId, b]
    );
    if (itemRes.rowCount === 0) throw new NotFoundError(`Item '${b}'`);
    const itemId = itemRes.rows[0].id;

    // Проверяем остаток WITH LOCK
    const balRes = await client.query(
      `SELECT qty_on_hand, qty_available FROM wms.stock_balances
       WHERE tenant_id=$1 AND warehouse_id=$2 AND client_id=$3 AND item_id=$4 AND location_id=$5
       FOR UPDATE`,
      [tenantId, warehouseId, clientId, itemId, fromLoc.id]
    );
    const available = balRes.rowCount > 0 ? Number(balRes.rows[0].qty_available) : 0;
    if (available < q) throw new InsufficientStockError(available, q, itemId, fromLoc.id);

    // Получаем avg_cost для переноса себестоимости
    const avgCost = balRes.rowCount > 0 && balRes.rows[0].avg_cost
      ? Number(balRes.rows[0].avg_cost) : null;

    // Движение: одна запись, qty отрицательное на FROM, положительное на TO
    // Используем одну запись с both location_id (from→to)
    await client.query(
      `INSERT INTO wms.stock_movements
         (tenant_id,warehouse_id,client_id,item_id,barcode,movement_type,qty,
          from_location_id,from_location_code,to_location_id,to_location_code,
          unit_cost,ref_type,user_id,comment)
       VALUES($1,$2,$3,$4,$5,'move',$6,$7,$8,$9,$10,$11,'move',$12,$13)`,
      [tenantId, warehouseId, clientId, itemId, b, -q,
       fromLoc.id, fromLoc.location_code, toLoc.id, toLoc.location_code,
       avgCost, userId, comment || null]
    );
    // Уменьшаем FROM
    await client.query(
      `SELECT * FROM wms.apply_stock_movement($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, warehouseId, clientId, itemId, fromLoc.id, b, -q, null]
    );

    // Движение TO: отдельная запись с qty>0
    await client.query(
      `INSERT INTO wms.stock_movements
         (tenant_id,warehouse_id,client_id,item_id,barcode,movement_type,qty,
          from_location_id,from_location_code,to_location_id,to_location_code,
          unit_cost,ref_type,user_id,comment)
       VALUES($1,$2,$3,$4,$5,'move',$6,$7,$8,$9,$10,$11,'move',$12,$13)`,
      [tenantId, warehouseId, clientId, itemId, b, q,
       fromLoc.id, fromLoc.location_code, toLoc.id, toLoc.location_code,
       avgCost, userId, comment || null]
    );
    // Увеличиваем TO
    await client.query(
      `SELECT * FROM wms.apply_stock_movement($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, warehouseId, clientId, itemId, toLoc.id, b, q, avgCost]
    );

    logger.info({ tenantId, clientId, barcode: b, qty: q, from: fromCode, to: toCode }, 'Movement done');

    return {
      barcode: b, qty: q, itemId,
      fromLocationId:   fromLoc.id, fromLocationCode: fromLoc.location_code,
      toLocationId:     toLoc.id,   toLocationCode:   toLoc.location_code,
    };
  });

  // Остаток для WB считается ТОЛЬКО по ячейкам отбора (is_pick_location) -
  // перемещение между любыми ячейками (в отличие от placement, тут разрешено
  // rack↔rack, buffer↔rack и т.п.) точно так же может выводить товар из
  // ячейки отбора в обычную и обратно, меняя доступное для WB количество без
  // изменения физического остатка. См. тот же фикс в placement.service.js.
  logger.info({ tenantId, clientId, barcode: b }, 'Movement triggered WB redistribution');
  triggerRedistributionForClient({ tenantId, clientId, barcodes: [b] });

  return result;
}

/**
 * Пакетное перемещение — все строки в одной транзакции
 */
async function moveBatch({ tenantId, warehouseId, clientId, lines, userId }) {
  if (!lines || !lines.length) throw new ValidationError('lines array is required');

  const result = await transaction(async (client) => {
    const results = [];

    for (const line of lines) {
      const b = validateBarcode(line.barcode);
      const q = validateQty(line.qty || 1, 'qty');
      const fromCode = String(line.from_location_code).trim().toUpperCase();
      const toCode   = String(line.to_location_code).trim().toUpperCase();
      if (fromCode === toCode) throw new ValidationError(`Line barcode=${b}: from=to`);

      const fromRes = await client.query(
        `SELECT id, location_code FROM wms.locations
         WHERE tenant_id=$1 AND warehouse_id=$2 AND location_code=$3 AND is_active=TRUE LIMIT 1`,
        [tenantId, warehouseId, fromCode]
      );
      if (fromRes.rowCount === 0) throw new NotFoundError(`Location '${fromCode}'`);
      const fromLoc = fromRes.rows[0];

      const toRes = await client.query(
        `SELECT id, location_code FROM wms.locations
         WHERE tenant_id=$1 AND warehouse_id=$2 AND location_code=$3 AND is_active=TRUE LIMIT 1`,
        [tenantId, warehouseId, toCode]
      );
      if (toRes.rowCount === 0) throw new NotFoundError(`Location '${toCode}'`);
      const toLoc = toRes.rows[0];

      const itemRes = await client.query(
        `SELECT id FROM wms.items WHERE tenant_id=$1 AND client_id=$2 AND barcode=$3 LIMIT 1`,
        [tenantId, clientId, b]
      );
      if (itemRes.rowCount === 0) throw new NotFoundError(`Item '${b}'`);
      const itemId = itemRes.rows[0].id;

      const balRes = await client.query(
        `SELECT qty_available, avg_cost FROM wms.stock_balances
         WHERE tenant_id=$1 AND warehouse_id=$2 AND client_id=$3 AND item_id=$4 AND location_id=$5
         FOR UPDATE`,
        [tenantId, warehouseId, clientId, itemId, fromLoc.id]
      );
      const available = balRes.rowCount > 0 ? Number(balRes.rows[0].qty_available) : 0;
      if (available < q) throw new InsufficientStockError(available, q, itemId, fromLoc.id);
      const avgCost = balRes.rowCount > 0 ? balRes.rows[0].avg_cost : null;

      await client.query(
        `INSERT INTO wms.stock_movements
           (tenant_id,warehouse_id,client_id,item_id,barcode,movement_type,qty,
            from_location_id,from_location_code,to_location_id,to_location_code,unit_cost,ref_type,user_id)
         VALUES($1,$2,$3,$4,$5,'move',$6,$7,$8,$9,$10,$11,'move',$12)`,
        [tenantId,warehouseId,clientId,itemId,b,-q,fromLoc.id,fromLoc.location_code,toLoc.id,toLoc.location_code,avgCost,userId]
      );
      await client.query(
        `SELECT * FROM wms.apply_stock_movement($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenantId,warehouseId,clientId,itemId,fromLoc.id,b,-q,null]
      );
      await client.query(
        `INSERT INTO wms.stock_movements
           (tenant_id,warehouse_id,client_id,item_id,barcode,movement_type,qty,
            from_location_id,from_location_code,to_location_id,to_location_code,unit_cost,ref_type,user_id)
         VALUES($1,$2,$3,$4,$5,'move',$6,$7,$8,$9,$10,$11,'move',$12)`,
        [tenantId,warehouseId,clientId,itemId,b,q,fromLoc.id,fromLoc.location_code,toLoc.id,toLoc.location_code,avgCost,userId]
      );
      await client.query(
        `SELECT * FROM wms.apply_stock_movement($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenantId,warehouseId,clientId,itemId,toLoc.id,b,q,avgCost]
      );

      results.push({ barcode: b, qty: q, fromLocationCode: fromLoc.location_code, toLocationCode: toLoc.location_code });
    }

    return { moved: results.length, results };
  });

  // См. комментарий в moveItem() выше.
  const movedBarcodes = [...new Set(result.results.map(r => r.barcode))];
  if (movedBarcodes.length) {
    logger.info({ tenantId, clientId, barcodes: movedBarcodes }, 'Movement batch triggered WB redistribution');
    triggerRedistributionForClient({ tenantId, clientId, barcodes: movedBarcodes });
  }

  return result;
}

/**
 * История перемещений (movement_type='move')
 */
async function listMovements({
  tenantId,
  warehouseId = null,
  clientId    = null,
  barcode     = null,
  locationCode = null,
  dateFrom     = null,
  dateTo       = null,
  limit  = 200,
  offset = 0,
}) {
  const params = [tenantId];
  const conds  = ["m.tenant_id=$1", "m.movement_type='move'", "m.qty>0"];
  let idx = 2;

  if (warehouseId)  { conds.push(`m.warehouse_id=$${idx++}`); params.push(warehouseId); }
  if (clientId)     { conds.push(`m.client_id=$${idx++}`);    params.push(clientId); }
  if (barcode)      { conds.push(`m.barcode=$${idx++}`);      params.push(barcode); }
  if (locationCode) {
    conds.push(`(m.from_location_code=$${idx} OR m.to_location_code=$${idx})`);
    params.push(locationCode); idx++;
  }
  if (dateFrom) { conds.push(`m.created_at>=$${idx++}::date`); params.push(dateFrom); }
  if (dateTo)   { conds.push(`m.created_at<($${idx++}::date+interval '1 day')`); params.push(dateTo); }

  params.push(Math.min(limit, 2000), Math.max(offset, 0));
  const r = await query(
    `SELECT
       m.id, m.barcode, m.qty,
       m.from_location_code, m.to_location_code,
       m.comment, m.created_at,
       i.item_name, i.vendor_code,
       c.client_name,
       u.username AS operator_name,
       w.warehouse_name
     FROM wms.stock_movements m
     LEFT JOIN wms.items i ON i.id=m.item_id
     LEFT JOIN wms.clients c ON c.id=m.client_id
     LEFT JOIN wms.users u ON u.id=m.user_id
     LEFT JOIN wms.warehouses w ON w.id=m.warehouse_id
     WHERE ${conds.join(' AND ')}
     ORDER BY m.created_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params
  );
  return r.rows;
}

/**
 * Актуальный остаток по ячейке (для предпроверки перед перемещением)
 */
async function getLocationStock({ tenantId, warehouseId, locationCode, clientId = null }) {
  const code = String(locationCode || '').trim().toUpperCase();
  if (!code) throw new ValidationError('location_code is required');

  const params = [tenantId, code];
  let sql = `
    SELECT
      sb.barcode, sb.qty_on_hand, sb.qty_reserved, sb.qty_available,
      i.item_name, i.vendor_code, i.unit,
      c.client_name
    FROM wms.stock_balances sb
    JOIN wms.locations l ON l.id=sb.location_id
    LEFT JOIN wms.items i ON i.id=sb.item_id
    LEFT JOIN wms.clients c ON c.id=sb.client_id
    WHERE sb.tenant_id=$1 AND l.location_code=$2 AND sb.qty_on_hand>0`;

  if (warehouseId) { sql += ` AND sb.warehouse_id=$3`; params.push(warehouseId); }
  if (clientId)    { sql += ` AND sb.client_id=$${params.length+1}`; params.push(clientId); }
  sql += ` ORDER BY i.item_name, sb.barcode`;

  const r = await query(sql, params);
  return r.rows;
}

module.exports = {
  moveItem,
  moveBatch,
  listMovements,
  getLocationStock,
};
