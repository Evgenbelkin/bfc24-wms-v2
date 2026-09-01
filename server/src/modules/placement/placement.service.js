'use strict';

const { query, transaction } = require('../../config/database');
const {
  NotFoundError,
  ValidationError,
  InsufficientStockError,
} = require('../../utils/errors');
const { validateBarcode, validateQty } = require('../../utils/validators');
const { chargeForOperation } = require('../billing/billing.service');
const { triggerRedistributionForClient } = require('../wb/wb.service');
const { locationWalkKey } = require('../../utils/warehouseLayout');
const logger = require('../../utils/logger');

// =============================================================================
// Placement Service
//
// Флоу: товар принят → лежит в receiving/buffer → размещается в rack/floor
//
// API:
//   listPendingPlacement  — список позиций, ожидающих размещения
//   getPendingByBarcode   — позиции к размещению по конкретному barcode
//   placeStock            — переместить из source в target
//   placeBatch            — пакетное размещение (несколько позиций)
//   listPlacementHistory  — история операций размещения
//   suggestTargetLocation — подсказка: куда положить
// =============================================================================

async function listPendingPlacement({ tenantId, warehouseId = null, clientId = null, limit = 200, offset = 0 }) {
  const params = [tenantId];
  const conds  = [
    'sb.tenant_id = $1',
    'sb.qty_on_hand > 0',
    "l.location_type IN ('receiving','buffer','quarantine')",
  ];
  let idx = 2;
  if (warehouseId) { conds.push(`sb.warehouse_id = $${idx++}`); params.push(warehouseId); }
  if (clientId)    { conds.push(`sb.client_id = $${idx++}`);    params.push(clientId); }

  const total = (await query(
    `SELECT COUNT(*)::int AS n FROM wms.stock_balances sb
     JOIN wms.locations l ON l.id = sb.location_id
     WHERE ${conds.join(' AND ')}`, params
  )).rows[0].n;

  params.push(Math.min(limit, 1000), Math.max(offset, 0));
  const r = await query(
    `SELECT
       sb.barcode, sb.qty_on_hand, sb.qty_available, sb.last_movement_at,
       l.id AS location_id, l.location_code, l.location_type, l.zone_code,
       w.id AS warehouse_id, w.warehouse_name,
       i.id AS item_id, i.item_name, i.vendor_code, i.size, i.unit, i.needs_packaging, i.preview_url,
       c.id AS client_id, c.client_name
     FROM wms.stock_balances sb
     JOIN wms.locations l ON l.id = sb.location_id
     JOIN wms.warehouses w ON w.id = sb.warehouse_id
     LEFT JOIN wms.items i ON i.id = sb.item_id
     LEFT JOIN wms.clients c ON c.id = sb.client_id
     WHERE ${conds.join(' AND ')}
     ORDER BY sb.last_movement_at ASC, l.location_code
     LIMIT $${idx++} OFFSET $${idx}`,
    params
  );
  return { items: r.rows, total, limit, offset };
}

async function getPendingByBarcode({ tenantId, barcode, warehouseId = null }) {
  const b = validateBarcode(barcode);
  const params = [tenantId, b];
  let sql = `
    SELECT sb.barcode, sb.qty_on_hand, sb.qty_available,
           l.id AS location_id, l.location_code, l.location_type,
           w.id AS warehouse_id, w.warehouse_name,
           i.item_name, i.vendor_code, i.size,
           c.id AS client_id, c.client_name
    FROM wms.stock_balances sb
    JOIN wms.locations l ON l.id = sb.location_id
    JOIN wms.warehouses w ON w.id = sb.warehouse_id
    LEFT JOIN wms.items i ON i.id = sb.item_id
    LEFT JOIN wms.clients c ON c.id = sb.client_id
    WHERE sb.tenant_id=$1 AND sb.barcode=$2
      AND sb.qty_on_hand>0
      AND l.location_type IN ('receiving','buffer','quarantine')`;
  if (warehouseId) { sql += ` AND sb.warehouse_id = $3`; params.push(warehouseId); }
  sql += ` ORDER BY l.location_code`;
  const r = await query(sql, params);
  return r.rows;
}

async function placeStock({ tenantId, warehouseId, clientId, barcode, fromLocationCode, toLocationCode, qty, userId, comment }) {
  const b = validateBarcode(barcode);
  const q = validateQty(qty, 'qty');

  const result = await transaction(async (client) => {
    // 1. Резолвим from-ячейку
    const fromRes = await client.query(
      `SELECT id, location_code, location_type FROM wms.locations
       WHERE tenant_id=$1 AND warehouse_id=$2 AND location_code=$3 AND is_active=TRUE LIMIT 1`,
      [tenantId, warehouseId, String(fromLocationCode).trim().toUpperCase()]
    );
    if (fromRes.rowCount === 0) throw new NotFoundError(`From-location '${fromLocationCode}'`);
    const fromLoc = fromRes.rows[0];

    // 2. Резолвим to-ячейку
    const toRes = await client.query(
      `SELECT id, location_code, location_type FROM wms.locations
       WHERE tenant_id=$1 AND warehouse_id=$2 AND location_code=$3 AND is_active=TRUE LIMIT 1`,
      [tenantId, warehouseId, String(toLocationCode).trim().toUpperCase()]
    );
    if (toRes.rowCount === 0) throw new NotFoundError(`To-location '${toLocationCode}'`);
    const toLoc = toRes.rows[0];

    if (['receiving','shipping'].includes(toLoc.location_type)) {
      throw new ValidationError(`Cannot place to location type '${toLoc.location_type}'`);
    }
    if (fromLoc.id === toLoc.id) throw new ValidationError('From and to locations must differ');

    // 3. item_id
    const itemRes = await client.query(
      `SELECT id FROM wms.items WHERE tenant_id=$1 AND client_id=$2 AND barcode=$3 LIMIT 1`,
      [tenantId, clientId, b]
    );
    if (itemRes.rowCount === 0) throw new NotFoundError(`Item '${b}'`);
    const itemId = itemRes.rows[0].id;

    // 4. Проверяем остаток FOR UPDATE
    const balRes = await client.query(
      `SELECT qty_available FROM wms.stock_balances
       WHERE tenant_id=$1 AND warehouse_id=$2 AND client_id=$3 AND item_id=$4 AND location_id=$5
       FOR UPDATE`,
      [tenantId, warehouseId, clientId, itemId, fromLoc.id]
    );
    const available = balRes.rowCount > 0 ? Number(balRes.rows[0].qty_available) : 0;
    if (available < q) throw new InsufficientStockError(available, q, itemId, fromLoc.id);

    // 5. Расход из FROM
    await client.query(
      `INSERT INTO wms.stock_movements
         (tenant_id,warehouse_id,client_id,item_id,barcode,movement_type,qty,
          from_location_id,from_location_code,to_location_id,to_location_code,
          ref_type,user_id,comment)
       VALUES($1,$2,$3,$4,$5,'placement',$6,$7,$8,$9,$10,'placement',$11,$12)`,
      [tenantId, warehouseId, clientId, itemId, b, -q,
       fromLoc.id, fromLoc.location_code, toLoc.id, toLoc.location_code,
       userId, comment || null]
    );
    await client.query(
      `SELECT * FROM wms.apply_stock_movement($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, warehouseId, clientId, itemId, fromLoc.id, b, -q, null]
    );

    // 6. Приход в TO
    await client.query(
      `INSERT INTO wms.stock_movements
         (tenant_id,warehouse_id,client_id,item_id,barcode,movement_type,qty,
          from_location_id,from_location_code,to_location_id,to_location_code,
          ref_type,user_id,comment)
       VALUES($1,$2,$3,$4,$5,'placement',$6,$7,$8,$9,$10,'placement',$11,$12)`,
      [tenantId, warehouseId, clientId, itemId, b, q,
       fromLoc.id, fromLoc.location_code, toLoc.id, toLoc.location_code,
       userId, comment || null]
    );
    await client.query(
      `SELECT * FROM wms.apply_stock_movement($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, warehouseId, clientId, itemId, toLoc.id, b, q, null]
    );

    logger.info({ tenantId, clientId, barcode: b, qty: q, from: fromLoc.location_code, to: toLoc.location_code }, 'Placement done');

    return {
      barcode: b, qty: q, itemId,
      fromLocationId: fromLoc.id, fromLocationCode: fromLoc.location_code,
      toLocationId:   toLoc.id,   toLocationCode:   toLoc.location_code,
    };
  });

  // Пересчёт и отправка остатка в WB СРАЗУ после размещения - у нас остаток
  // для WB считается ТОЛЬКО по ячейкам отбора (is_pick_location), поэтому
  // перекладка между зоной хранения и зоной отбора МЕНЯЕТ доступное для WB
  // количество, даже если общий физический остаток товара не изменился.
  // Раньше это не триггерило пересчёт вообще (комментарий выше в файле про
  // "WB и так резервирует сам" был верен для заказов, но не учитывал появление
  // отдельного правила "считать только по ячейкам отбора") - отсюда и
  // расхождения, всплывавшие без видимой причины между приёмками. Только по
  // ЭТОМУ штрихкоду, fire-and-forget - как и остальные вызовы
  // triggerRedistributionForClient (см. wb.service.js).
  logger.info({ tenantId, clientId, barcode: b }, 'Placement triggered WB redistribution');
  triggerRedistributionForClient({ tenantId, clientId, barcodes: [b] });

  chargeForOperation({ tenantId, clientId, serviceType: 'placement', quantity: q, refType: 'placement', refId: result.itemId });

  return result;
}

async function placeBatch({ tenantId, warehouseId, clientId, lines, userId }) {
  if (!lines || !lines.length) throw new ValidationError('lines array is required');

  const result = await transaction(async (client) => {
    const results = [];

    for (const line of lines) {
      const b = validateBarcode(line.barcode);
      const q = validateQty(line.qty || 1, 'qty');

      const fromRes = await client.query(
        `SELECT id, location_code FROM wms.locations
         WHERE tenant_id=$1 AND warehouse_id=$2 AND location_code=$3 AND is_active=TRUE LIMIT 1`,
        [tenantId, warehouseId, String(line.from_location_code).trim().toUpperCase()]
      );
      if (fromRes.rowCount === 0) throw new NotFoundError(`From-location '${line.from_location_code}'`);
      const fromLoc = fromRes.rows[0];

      const toRes = await client.query(
        `SELECT id, location_code, location_type FROM wms.locations
         WHERE tenant_id=$1 AND warehouse_id=$2 AND location_code=$3 AND is_active=TRUE LIMIT 1`,
        [tenantId, warehouseId, String(line.to_location_code).trim().toUpperCase()]
      );
      if (toRes.rowCount === 0) throw new NotFoundError(`To-location '${line.to_location_code}'`);
      const toLoc = toRes.rows[0];

      if (['receiving','shipping'].includes(toLoc.location_type)) {
        throw new ValidationError(`Invalid to-location type: ${toLoc.location_type}`);
      }

      const itemRes = await client.query(
        `SELECT id FROM wms.items WHERE tenant_id=$1 AND client_id=$2 AND barcode=$3 LIMIT 1`,
        [tenantId, clientId, b]
      );
      if (itemRes.rowCount === 0) throw new NotFoundError(`Item '${b}'`);
      const itemId = itemRes.rows[0].id;

      const balRes = await client.query(
        `SELECT qty_available FROM wms.stock_balances
         WHERE tenant_id=$1 AND warehouse_id=$2 AND client_id=$3 AND item_id=$4 AND location_id=$5
         FOR UPDATE`,
        [tenantId, warehouseId, clientId, itemId, fromLoc.id]
      );
      const available = balRes.rowCount > 0 ? Number(balRes.rows[0].qty_available) : 0;
      if (available < q) throw new InsufficientStockError(available, q, itemId, fromLoc.id);

      await client.query(
        `INSERT INTO wms.stock_movements
           (tenant_id,warehouse_id,client_id,item_id,barcode,movement_type,qty,
            from_location_id,from_location_code,to_location_id,to_location_code,ref_type,user_id)
         VALUES($1,$2,$3,$4,$5,'placement',$6,$7,$8,$9,$10,'placement',$11)`,
        [tenantId,warehouseId,clientId,itemId,b,-q,fromLoc.id,fromLoc.location_code,toLoc.id,toLoc.location_code,userId]
      );
      await client.query(
        `SELECT * FROM wms.apply_stock_movement($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenantId,warehouseId,clientId,itemId,fromLoc.id,b,-q,null]
      );
      await client.query(
        `INSERT INTO wms.stock_movements
           (tenant_id,warehouse_id,client_id,item_id,barcode,movement_type,qty,
            from_location_id,from_location_code,to_location_id,to_location_code,ref_type,user_id)
         VALUES($1,$2,$3,$4,$5,'placement',$6,$7,$8,$9,$10,'placement',$11)`,
        [tenantId,warehouseId,clientId,itemId,b,q,fromLoc.id,fromLoc.location_code,toLoc.id,toLoc.location_code,userId]
      );
      await client.query(
        `SELECT * FROM wms.apply_stock_movement($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenantId,warehouseId,clientId,itemId,toLoc.id,b,q,null]
      );

      results.push({ barcode: b, qty: q, fromLocationCode: fromLoc.location_code, toLocationCode: toLoc.location_code });
    }

    return { placed: results.length, results };
  });

  // См. комментарий в placeStock() выше про то, почему размещение обязано
  // триггерить пересчёт остатка для WB (ячейки отбора).
  const placedBarcodes = [...new Set(result.results.map(r => r.barcode))];
  if (placedBarcodes.length) {
    logger.info({ tenantId, clientId, barcodes: placedBarcodes }, 'Placement batch triggered WB redistribution');
    triggerRedistributionForClient({ tenantId, clientId, barcodes: placedBarcodes });
  }

  const totalQty = result.results.reduce((s, r) => s + Number(r.qty), 0);
  chargeForOperation({ tenantId, clientId, serviceType: 'placement', quantity: totalQty, refType: 'placement_batch', refId: null });

  return result;
}

async function listPlacementHistory({ tenantId, clientId = null, warehouseId = null, barcode = null, dateFrom = null, dateTo = null, limit = 200, offset = 0 }) {
  const params = [tenantId];
  const conds  = ["m.tenant_id=$1", "m.movement_type='placement'", "m.qty>0"];
  let idx = 2;

  if (clientId)    { conds.push(`m.client_id=$${idx++}`);           params.push(clientId); }
  if (warehouseId) { conds.push(`m.warehouse_id=$${idx++}`);        params.push(warehouseId); }
  if (barcode)     { conds.push(`m.barcode=$${idx++}`);             params.push(barcode); }
  if (dateFrom)    { conds.push(`m.created_at>=$${idx++}::date`);   params.push(dateFrom); }
  if (dateTo)      { conds.push(`m.created_at<($${idx++}::date+interval '1 day')`); params.push(dateTo); }

  params.push(Math.min(limit, 2000), Math.max(offset, 0));
  const r = await query(
    `SELECT m.id, m.barcode, m.qty, m.from_location_code, m.to_location_code,
            m.comment, m.created_at,
            i.item_name, i.vendor_code, i.size,
            c.client_name, u.username AS operator_name, w.warehouse_name
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
 * Подсказка целевой ячейки при размещении — доработка от 01.09.2026 (нашли
 * причину "зигзага" при сборке: один и тот же товар оказывался раскидан по
 * дальним друг от друга ячейкам, потому что старая версия этой функции (а)
 * не проверяла, есть ли в "своей" ячейке вообще место под добавляемое
 * количество — могла посоветовать уже забитую до отказа, и (б) если своих
 * ячеек с местом не было, предлагала первую по алфавиту ПУСТУЮ ячейку во
 * всём складе, а не рядом с уже занятыми — то есть сама раскидывала товар).
 *
 * Теперь: 1) ищем "родную" ячейку товара, где реально есть место по объёму;
 * 2) если все родные заняты (или товара тут ещё никогда не было) — ищем
 * ближайшую ПУСТУЮ ячейку в том же ряду/зоне (тот же порядок обхода, что и
 * при сборке — см. server/src/utils/warehouseLayout.js), чтобы товар не
 * разъезжался по складу; 3) и только если рядом совсем ничего нет — берём
 * любую свободную ячейку (как раньше, финальный фолбэк).
 *
 * Объём ячеек (max_volume_l) может со временем меняться (переставляют
 * стеллажи и т.п.) — поэтому ничего не кэшируем, считаем заново на каждый
 * вызов. Ячейка без указанного max_volume_l считается "безлимитной" для
 * этой проверки (не блокируем подсказку из-за незаполненного справочника).
 */
async function suggestTargetLocation({ tenantId, warehouseId, itemId, clientId, qty = 1 }) {
  const q = Math.max(1, Number(qty) || 1);

  const itemRes = await query(
    `SELECT COALESCE(volume_liters, 1) AS vol FROM wms.items WHERE id=$1 AND tenant_id=$2`,
    [itemId, tenantId]
  );
  const unitVol = itemRes.rowCount > 0 ? Number(itemRes.rows[0].vol) : 1;
  const neededVol = unitVol * q;

  // 1) Родные ячейки товара, с текущей занятостью каждой (может включать и
  // другие товары, если ячейка общая) — как в getLocationFillReport.
  const existing = await query(
    `SELECT l.location_code, l.location_type, l.max_volume_l, sb.qty_on_hand,
       COALESCE(occ.occupied_liters, 0)::numeric AS occupied_liters
     FROM wms.stock_balances sb
     JOIN wms.locations l ON l.id = sb.location_id
     LEFT JOIN LATERAL (
       SELECT SUM(sb2.qty_on_hand * COALESCE(i2.volume_liters, 1))::numeric AS occupied_liters
       FROM wms.stock_balances sb2
       JOIN wms.items i2 ON i2.id = sb2.item_id
       WHERE sb2.location_id = l.id AND sb2.qty_on_hand > 0
     ) occ ON TRUE
     WHERE sb.tenant_id=$1 AND sb.warehouse_id=$2 AND sb.item_id=$3 AND sb.client_id=$4
       AND l.location_type IN ('rack','floor') AND sb.qty_on_hand>0 AND l.is_active=TRUE
     ORDER BY sb.qty_on_hand DESC`,
    [tenantId, warehouseId, itemId, clientId]
  );

  for (const row of existing.rows) {
    const cap = row.max_volume_l != null ? Number(row.max_volume_l) : null;
    const free = cap === null ? Infinity : (cap - Number(row.occupied_liters));
    if (free >= neededVol) {
      return { location_code: row.location_code, location_type: row.location_type, qty_on_hand: row.qty_on_hand, reason: 'consolidation' };
    }
  }

  // 2) Все родные заняты (или их пока нет вообще) — пробуем найти пустую
  // ячейку рядом с самой "устоявшейся" родной (если она есть) — тот же ряд/
  // зона, ближайшая по позиции. Без родной ячейки (товар размещается первый
  // раз) точки отсчёта нет — сразу переходим к общему фолбэку (3).
  if (existing.rows.length > 0) {
    const anchorKey = locationWalkKey(existing.rows[0].location_code);
    if (anchorKey.pattern) {
      const zonePrefix = anchorKey.zoneLetter + (anchorKey.zoneNum ?? '');
      const nearby = await query(
        `SELECT l.location_code
         FROM wms.locations l
         WHERE l.tenant_id=$1 AND l.warehouse_id=$2 AND l.location_type='rack' AND l.is_active=TRUE
           AND UPPER(l.location_code) LIKE UPPER($3) || '-%'
           AND NOT EXISTS (SELECT 1 FROM wms.stock_balances sb2 WHERE sb2.location_id=l.id AND sb2.qty_on_hand>0)`,
        [tenantId, warehouseId, zonePrefix]
      );
      let best = null, bestDist = Infinity;
      for (const r of nearby.rows) {
        const k = locationWalkKey(r.location_code);
        if (!k.pattern) continue;
        const dist = Math.abs(k.position - anchorKey.position);
        if (dist < bestDist) { best = r.location_code; bestDist = dist; }
      }
      if (best) return { location_code: best, location_type: 'rack', qty_on_hand: 0, reason: 'nearby' };
    }
  }

  // 3) Финальный фолбэк — как раньше: первая свободная ячейка по алфавиту
  // во всём складе (лучше предложить хоть что-то, чем ничего).
  const free = await query(
    `SELECT l.location_code, l.location_type, 0 AS qty_on_hand
     FROM wms.locations l
     WHERE l.tenant_id=$1 AND l.warehouse_id=$2 AND l.location_type='rack' AND l.is_active=TRUE
       AND NOT EXISTS (SELECT 1 FROM wms.stock_balances sb2 WHERE sb2.location_id=l.id AND sb2.qty_on_hand>0)
     ORDER BY l.location_code ASC LIMIT 1`,
    [tenantId, warehouseId]
  );
  if (free.rowCount > 0) return { ...free.rows[0], reason: 'free_slot' };

  return null;
}

module.exports = {
  listPendingPlacement,
  getPendingByBarcode,
  placeStock,
  placeBatch,
  listPlacementHistory,
  suggestTargetLocation,
};
