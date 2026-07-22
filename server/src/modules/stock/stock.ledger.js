'use strict';

const { query, transaction } = require('../../config/database');
const { resolveOrCreateItem } = require('../masterdata/items/items.service');
const { getLocationByCode } = require('../masterdata/locations/locations.service');
const { InsufficientStockError, ValidationError, NotFoundError } = require('../../utils/errors');
const { validateBarcode, validateQty, validatePositiveInt } = require('../../utils/validators');
const logger = require('../../utils/logger');

// =============================================================================
// Stock Ledger — единственный правильный путь к изменению остатков
//
// Все операции (receiving, picking, move, adjust, ...) должны вызывать
// функции из этого модуля. Он гарантирует:
// 1. Запись в stock_movements (ledger — источник истины)
// 2. Обновление stock_balances (агрегат для быстрых запросов)
// 3. Атомарность через транзакции
// 4. Проверку достаточности остатков перед расходом
// =============================================================================

/**
 * Записать движение в ledger + обновить баланс
 * Низкоуровневая функция — используется только через высокоуровневые helpers ниже
 *
 * @param {object} client - DB client (из транзакции)
 * @param {object} params
 * @returns {object} balance
 */
async function _writeLedgerEntry(client, {
  tenantId, warehouseId, clientId, itemId, barcode,
  movementType, qty,
  fromLocationId = null, toLocationId = null,
  fromLocationCode = null, toLocationCode = null,
  refType = null, refId = null,
  unitCost = null,
  userId = null, comment = null,
}) {
  // Записываем движение
  await client.query(
    `INSERT INTO wms.stock_movements
       (tenant_id, warehouse_id, client_id, item_id, barcode,
        movement_type, qty,
        from_location_id, to_location_id, from_location_code, to_location_code,
        ref_type, ref_id, unit_cost, total_cost, user_id, comment)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      tenantId, warehouseId, clientId, itemId, barcode,
      movementType, qty,
      fromLocationId, toLocationId, fromLocationCode, toLocationCode,
      refType, refId,
      unitCost,
      unitCost ? Math.abs(qty) * unitCost : null,
      userId, comment,
    ]
  );

  // Обновляем баланс
  // Если qty > 0: приход на to_location
  // Если qty < 0: расход с from_location
  let balance;
  if (qty > 0 && toLocationId) {
    const result = await client.query(
      `SELECT * FROM wms.apply_stock_movement($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, warehouseId, clientId, itemId, toLocationId, barcode, qty, unitCost]
    );
    balance = result.rows[0];
  } else if (qty < 0 && fromLocationId) {
    const result = await client.query(
      `SELECT * FROM wms.apply_stock_movement($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, warehouseId, clientId, itemId, fromLocationId, barcode, qty, null]
    );
    balance = result.rows[0];
  }

  return balance;
}

// =============================================================================
// Высокоуровневые операции
// =============================================================================

/**
 * ПРИЁМКА: оприходовать товар на ячейку
 */
async function receiveStock({
  tenantId, warehouseId, clientId,
  barcode, locationId, locationCode,
  qty, refType = 'receiving', refId = null,
  unitCost = null, userId = null, comment = null,
  dbClient = null,
}) {
  const b = validateBarcode(barcode);
  const q = validateQty(qty, 'qty');

  const exec = async (client) => {
    // Резолвим itemId
    const itemId = await resolveOrCreateItem({ tenantId, clientId, barcode: b, dbClient: client });

    // Резолвим locationId если передан только код
    let locId = locationId;
    let locCode = locationCode;
    if (!locId && locCode) {
      const loc = await getLocationByCode({ tenantId, warehouseId, locationCode: locCode });
      locId = loc.id;
      locCode = loc.location_code;
    }
    if (!locId) throw new ValidationError('locationId or locationCode is required');

    const balance = await _writeLedgerEntry(client, {
      tenantId, warehouseId, clientId, itemId, barcode: b,
      movementType: refType === 'inbound' ? 'inbound' : 'receiving',
      qty: q,
      toLocationId:   locId,
      toLocationCode: locCode,
      refType, refId, unitCost, userId, comment,
    });

    logger.info({ tenantId, clientId, barcode: b, qty: q, locationCode: locCode }, 'Stock received');
    return { itemId, barcode: b, qty: q, locationId: locId, locationCode: locCode, balance };
  };

  if (dbClient) return exec(dbClient);
  return transaction(exec);
}

/**
 * ПЕРЕМЕЩЕНИЕ: переложить из одной ячейки в другую
 */
async function moveStock({
  tenantId, warehouseId, clientId,
  barcode, itemId,
  fromLocationId, fromLocationCode,
  toLocationId, toLocationCode,
  qty, movementType = 'move',
  refType = null, refId = null,
  userId = null, comment = null,
  dbClient = null,
}) {
  const b = validateBarcode(barcode);
  const q = validateQty(qty, 'qty');

  const exec = async (client) => {
    const iid = itemId || await resolveOrCreateItem({ tenantId, clientId, barcode: b, dbClient: client });

    // Резолвим from-ячейку
    let fromLocId = fromLocationId;
    let fromLocCode = fromLocationCode;
    if (!fromLocId && fromLocCode) {
      const loc = await getLocationByCode({ tenantId, warehouseId, locationCode: fromLocCode });
      fromLocId = loc.id;
      fromLocCode = loc.location_code;
    }
    if (!fromLocId) throw new ValidationError('from location is required');

    // Резолвим to-ячейку
    let toLocId = toLocationId;
    let toLocCode = toLocationCode;
    if (!toLocId && toLocCode) {
      const loc = await getLocationByCode({ tenantId, warehouseId, locationCode: toLocCode });
      toLocId = loc.id;
      toLocCode = loc.location_code;
    }
    if (!toLocId) throw new ValidationError('to location is required');

    if (fromLocId === toLocId) throw new ValidationError('From and to locations cannot be the same');

    // Проверяем наличие остатка FOR UPDATE
    const stockCheck = await client.query(
      `SELECT qty_available FROM wms.stock_balances
       WHERE tenant_id=$1 AND warehouse_id=$2 AND client_id=$3 AND item_id=$4 AND location_id=$5
       FOR UPDATE`,
      [tenantId, warehouseId, clientId, iid, fromLocId]
    );
    const available = stockCheck.rowCount > 0 ? Number(stockCheck.rows[0].qty_available) : 0;
    if (available < q) throw new InsufficientStockError(available, q, iid, fromLocId);

    // Расход с FROM
    await _writeLedgerEntry(client, {
      tenantId, warehouseId, clientId, itemId: iid, barcode: b,
      movementType, qty: -q,
      fromLocationId: fromLocId, fromLocationCode: fromLocCode,
      refType, refId, userId, comment,
    });

    // Приход на TO
    await _writeLedgerEntry(client, {
      tenantId, warehouseId, clientId, itemId: iid, barcode: b,
      movementType, qty: q,
      toLocationId: toLocId, toLocationCode: toLocCode,
      refType, refId, userId, comment,
    });

    return {
      itemId: iid, barcode: b, qty: q,
      fromLocationId: fromLocId, fromLocationCode: fromLocCode,
      toLocationId: toLocId, toLocationCode: toLocCode,
    };
  };

  if (dbClient) return exec(dbClient);
  return transaction(exec);
}

/**
 * СПИСАНИЕ: расход со склада (picking, shipping, writeoff)
 */
async function consumeStock({
  tenantId, warehouseId, clientId,
  barcode, itemId,
  locationId, locationCode,
  qty, movementType = 'picking',
  refType = null, refId = null,
  userId = null, comment = null,
  dbClient = null,
}) {
  const b = validateBarcode(barcode);
  const q = validateQty(qty, 'qty');

  const exec = async (client) => {
    const iid = itemId || await resolveOrCreateItem({ tenantId, clientId, barcode: b, dbClient: client });

    let locId = locationId;
    let locCode = locationCode;
    if (!locId && locCode) {
      const loc = await getLocationByCode({ tenantId, warehouseId, locationCode: locCode });
      locId = loc.id;
      locCode = loc.location_code;
    }
    if (!locId) throw new ValidationError('locationId or locationCode is required for consumption');

    // Проверяем остаток FOR UPDATE
    const stockCheck = await client.query(
      `SELECT qty_on_hand, qty_available FROM wms.stock_balances
       WHERE tenant_id=$1 AND warehouse_id=$2 AND client_id=$3 AND item_id=$4 AND location_id=$5
       FOR UPDATE`,
      [tenantId, warehouseId, clientId, iid, locId]
    );

    const onHand    = stockCheck.rowCount > 0 ? Number(stockCheck.rows[0].qty_on_hand) : 0;
    const available = stockCheck.rowCount > 0 ? Number(stockCheck.rows[0].qty_available) : 0;

    // Важно: сверяем именно qty_available (on_hand - reserved), а не qty_on_hand.
    // Если/когда в picking-флоу будет подключено резервирование (wms.reserve_stock),
    // это не даст списать физически присутствующий, но уже зарезервированный под
    // другой заказ товар. Сегодня qty_reserved везде 0, так что поведение не меняется.
    if (available < q) throw new InsufficientStockError(available, q, iid, locId);

    const balance = await _writeLedgerEntry(client, {
      tenantId, warehouseId, clientId, itemId: iid, barcode: b,
      movementType, qty: -q,
      fromLocationId:   locId,
      fromLocationCode: locCode,
      refType, refId, userId, comment,
    });

    return { itemId: iid, barcode: b, qty: q, locationId: locId, locationCode: locCode, balance };
  };

  if (dbClient) return exec(dbClient);
  return transaction(exec);
}

/**
 * КОРРЕКТИРОВКА: установить фактический остаток (инвентаризация)
 */
async function adjustStock({
  tenantId, warehouseId, clientId,
  barcode, itemId,
  locationId, locationCode,
  actualQty,
  refType = 'inventory', refId = null,
  userId = null, comment = null,
  dbClient = null,
}) {
  const b = validateBarcode(barcode);
  if (actualQty < 0) throw new ValidationError('actualQty must be >= 0');

  const exec = async (client) => {
    const iid = itemId || await resolveOrCreateItem({ tenantId, clientId, barcode: b, dbClient: client });

    let locId = locationId;
    let locCode = locationCode;
    if (!locId && locCode) {
      const loc = await getLocationByCode({ tenantId, warehouseId, locationCode: locCode });
      locId = loc.id;
      locCode = loc.location_code;
    }
    if (!locId) throw new ValidationError('location is required');

    // Текущий остаток + резерв FOR UPDATE
    const cur = await client.query(
      `SELECT qty_on_hand, qty_reserved FROM wms.stock_balances
       WHERE tenant_id=$1 AND warehouse_id=$2 AND client_id=$3 AND item_id=$4 AND location_id=$5
       FOR UPDATE`,
      [tenantId, warehouseId, clientId, iid, locId]
    );
    const currentQty  = cur.rowCount > 0 ? Number(cur.rows[0].qty_on_hand)  : 0;
    const reservedQty = cur.rowCount > 0 ? Number(cur.rows[0].qty_reserved)  : 0;
    const delta = actualQty - currentQty;

    if (delta === 0) {
      return { itemId: iid, barcode: b, currentQty, actualQty, delta: 0, locationId: locId };
    }

    // Нельзя урезать остаток ниже зарезервированного количества
    if (actualQty < reservedQty) {
      throw new ValidationError(
        `Cannot adjust stock below reserved qty: actualQty=${actualQty}, reserved=${reservedQty}. ` +
        `Release reservations first.`
      );
    }

    await _writeLedgerEntry(client, {
      tenantId, warehouseId, clientId, itemId: iid, barcode: b,
      movementType: 'inventory', qty: delta,
      fromLocationId: delta < 0 ? locId : null,
      fromLocationCode: delta < 0 ? locCode : null,
      toLocationId:   delta > 0 ? locId : null,
      toLocationCode: delta > 0 ? locCode : null,
      refType, refId, userId, comment,
    });

    return { itemId: iid, barcode: b, currentQty, actualQty, delta, locationId: locId, locationCode: locCode };
  };

  if (dbClient) return exec(dbClient);
  return transaction(exec);
}

module.exports = { receiveStock, moveStock, consumeStock, adjustStock };
