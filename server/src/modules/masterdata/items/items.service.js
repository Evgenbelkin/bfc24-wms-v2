'use strict';

const { query, transaction } = require('../../../config/database');
const { NotFoundError, ConflictError, ValidationError } = require('../../../utils/errors');
const { validateNonEmptyString, validateBarcode, parseBool } = require('../../../utils/validators');

// =============================================================================
// Items Service
// =============================================================================

const VALID_UNITS = ['шт', 'л', 'кг', 'м', 'компл', 'пара', 'упак'];

async function listItems({ tenantId, clientId = null, search = null, isActive = null, limit = 100, offset = 0 }) {
  const params = [tenantId];
  const conds = ['i.tenant_id = $1'];
  let idx = 2;

  if (clientId) { conds.push(`i.client_id = $${idx++}`); params.push(clientId); }
  if (isActive !== null) { conds.push(`i.is_active = $${idx++}`); params.push(isActive); }
  if (search) {
    conds.push(`(i.barcode ILIKE $${idx} OR i.item_name ILIKE $${idx} OR i.vendor_code ILIKE $${idx})`);
    params.push(`%${search}%`); idx++;
  }

  // count
  const countRes = await query(
    `SELECT COUNT(*)::int AS total FROM wms.items i WHERE ${conds.join(' AND ')}`,
    params
  );
  const total = countRes.rows[0].total;

  params.push(Math.min(limit, 500), Math.max(offset, 0));
  const res = await query(
    `SELECT
       i.id, i.client_id, i.barcode, i.item_name, i.vendor_code,
       i.wb_vendor_code, i.brand, i.unit, i.volume_liters,
       i.length_cm, i.width_cm, i.height_cm, i.weight_grams,
       i.cost_price, i.processing_fee, i.needs_packaging,
       i.is_active, i.source, i.wb_nm_id, i.preview_url,
       i.requires_marking, i.marking_trigger, i.marking_mode,
       i.created_at, i.kit_of_item_id, i.kit_multiplier,
       base.item_name AS kit_of_item_name, base.barcode AS kit_of_barcode,
       c.client_name
     FROM wms.items i
     LEFT JOIN wms.clients c ON c.id = i.client_id
     LEFT JOIN wms.items base ON base.id = i.kit_of_item_id
     WHERE ${conds.join(' AND ')}
     ORDER BY i.item_name
     LIMIT $${idx++} OFFSET $${idx}`,
    params
  );

  return { items: res.rows, total, limit, offset };
}

async function getItemById({ tenantId, itemId }) {
  const res = await query(
    `SELECT i.*, c.client_name FROM wms.items i LEFT JOIN wms.clients c ON c.id = i.client_id
     WHERE i.id = $1 AND i.tenant_id = $2`,
    [itemId, tenantId]
  );
  if (res.rowCount === 0) throw new NotFoundError('Item', itemId);
  return res.rows[0];
}

async function getItemByBarcode({ tenantId, clientId, barcode }) {
  const b = validateBarcode(barcode);
  const params = [tenantId, b];
  let sql = `SELECT i.*, c.client_name FROM wms.items i LEFT JOIN wms.clients c ON c.id = i.client_id
             WHERE i.tenant_id = $1 AND i.barcode = $2`;
  if (clientId) { sql += ` AND i.client_id = $3`; params.push(clientId); }
  sql += ` LIMIT 1`;

  const res = await query(sql, params);
  if (res.rowCount === 0) throw new NotFoundError(`Item with barcode '${b}'`);
  return res.rows[0];
}

async function createItem({ tenantId, clientId, createdById, data }) {
  const barcode   = validateBarcode(data.barcode);
  const itemName  = validateNonEmptyString(data.item_name, 'item_name', 500);

  if (!clientId && !data.client_id) throw new ValidationError('client_id is required');
  const cid = clientId || Number(data.client_id);

  // Уникальность barcode внутри клиента
  const exists = await query(
    `SELECT id FROM wms.items WHERE tenant_id = $1 AND client_id = $2 AND barcode = $3`,
    [tenantId, cid, barcode]
  );
  if (exists.rowCount > 0) throw new ConflictError(`Barcode '${barcode}' already exists for this client`);

  const unit = data.unit || 'шт';
  if (!VALID_UNITS.includes(unit)) throw new ValidationError(`Invalid unit. Allowed: ${VALID_UNITS.join(', ')}`);

  // Для литражных товаров volume_liters обязателен
  if (unit === 'л' && (!data.volume_liters || Number(data.volume_liters) <= 0)) {
    throw new ValidationError('volume_liters is required and must be > 0 for unit=л');
  }

  // Комплект (kit): kit_of_item_id должен указывать на СУЩЕСТВУЮЩИЙ товар
  // этого же клиента - иначе можно случайно построить комплект из чужого
  // товара или из несуществующего id.
  let kitOfItemId = null;
  let kitMultiplier = 1;
  if (data.kit_of_item_id) {
    const baseCheck = await query(
      `SELECT id FROM wms.items WHERE id=$1 AND tenant_id=$2 AND client_id=$3`,
      [Number(data.kit_of_item_id), tenantId, cid]
    );
    if (baseCheck.rowCount === 0) throw new ValidationError('kit_of_item_id: базовый товар не найден у этого клиента');
    kitOfItemId = Number(data.kit_of_item_id);
    kitMultiplier = Math.max(1, Math.round(Number(data.kit_multiplier) || 1));
  }

  const markingTrigger = data.marking_trigger || 'packing';
  if (!['receiving', 'packing'].includes(markingTrigger)) {
    throw new ValidationError(`Invalid marking_trigger. Allowed: receiving, packing`);
  }
  const markingMode = data.marking_mode || 'print';
  if (!['print', 'scan'].includes(markingMode)) {
    throw new ValidationError(`Invalid marking_mode. Allowed: print, scan`);
  }

  const res = await query(
    `INSERT INTO wms.items
       (tenant_id, client_id, barcode, item_name, vendor_code, wb_vendor_code,
        brand, unit, volume_liters, length_cm, width_cm, height_cm, weight_grams,
        cost_price, processing_fee, needs_packaging, is_active, source, wb_nm_id, preview_url, created_by,
        kit_of_item_id, kit_multiplier, requires_marking, marking_trigger, marking_mode)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
     RETURNING *`,
    [
      tenantId, cid, barcode, itemName,
      data.vendor_code     || null,
      data.wb_vendor_code  || null,
      data.brand           || null,
      unit,
      data.volume_liters   != null ? Number(data.volume_liters) : null,
      data.length_cm       != null ? Number(data.length_cm) : null,
      data.width_cm        != null ? Number(data.width_cm) : null,
      data.height_cm       != null ? Number(data.height_cm) : null,
      data.weight_grams    != null ? Number(data.weight_grams) : null,
      data.cost_price      != null ? Number(data.cost_price) : null,
      data.processing_fee  != null ? Number(data.processing_fee) : null,
      parseBool(data.needs_packaging, false),
      parseBool(data.is_active, true),
      data.source          || 'manual',
      data.wb_nm_id        ? Number(data.wb_nm_id) : null,
      data.preview_url     || null,
      createdById,
      kitOfItemId,
      kitMultiplier,
      parseBool(data.requires_marking, false),
      markingTrigger,
      markingMode,
    ]
  );

  return res.rows[0];
}

async function updateItem({ tenantId, itemId, data }) {
  const current = await getItemById({ tenantId, itemId });

  const fields = [];
  const params = [];
  let idx = 1;

  const num = (key, col) => {
    if (data[key] !== undefined) { fields.push(`${col} = $${idx++}`); params.push(data[key] != null ? Number(data[key]) : null); }
  };
  const str = (key, col, max = 500) => {
    if (data[key] !== undefined) { fields.push(`${col} = $${idx++}`); params.push(data[key] ? String(data[key]).trim().slice(0, max) : null); }
  };

  str('item_name',      'item_name');
  str('vendor_code',    'vendor_code');
  str('wb_vendor_code', 'wb_vendor_code');
  str('brand',          'brand');
  str('preview_url',    'preview_url', 1000);

  if (data.unit !== undefined) {
    if (!VALID_UNITS.includes(data.unit)) throw new ValidationError(`Invalid unit`);
    fields.push(`unit = $${idx++}`); params.push(data.unit);
  }

  num('volume_liters', 'volume_liters');
  num('length_cm',     'length_cm');
  num('width_cm',      'width_cm');
  num('height_cm',     'height_cm');
  num('weight_grams',  'weight_grams');
  num('cost_price',    'cost_price');
  num('processing_fee','processing_fee');

  if (data.needs_packaging !== undefined) { fields.push(`needs_packaging = $${idx++}`); params.push(parseBool(data.needs_packaging)); }
  if (data.is_active !== undefined) { fields.push(`is_active = $${idx++}`); params.push(parseBool(data.is_active)); }
  if (data.requires_marking !== undefined) { fields.push(`requires_marking = $${idx++}`); params.push(parseBool(data.requires_marking)); }
  if (data.marking_trigger !== undefined) {
    if (!['receiving', 'packing'].includes(data.marking_trigger)) throw new ValidationError(`Invalid marking_trigger. Allowed: receiving, packing`);
    fields.push(`marking_trigger = $${idx++}`); params.push(data.marking_trigger);
  }
  if (data.marking_mode !== undefined) {
    if (!['print', 'scan'].includes(data.marking_mode)) throw new ValidationError(`Invalid marking_mode. Allowed: print, scan`);
    fields.push(`marking_mode = $${idx++}`); params.push(data.marking_mode);
  }

  // Комплект: kit_of_item_id=null явно снимает связь (делает товар обычным),
  // непустое значение - проверяем, что базовый товар существует у ТОГО ЖЕ
  // клиента, что и текущий товар (нельзя привязать к чужому).
  if (data.kit_of_item_id !== undefined) {
    if (data.kit_of_item_id === null || data.kit_of_item_id === '') {
      fields.push(`kit_of_item_id = $${idx++}`); params.push(null);
      fields.push(`kit_multiplier = $${idx++}`); params.push(1);
    } else {
      const baseCheck = await query(
        `SELECT id FROM wms.items WHERE id=$1 AND tenant_id=$2 AND client_id=$3`,
        [Number(data.kit_of_item_id), tenantId, current.client_id]
      );
      if (baseCheck.rowCount === 0) throw new ValidationError('kit_of_item_id: базовый товар не найден у этого клиента');
      if (Number(data.kit_of_item_id) === itemId) throw new ValidationError('Товар не может быть комплектом самого себя');
      fields.push(`kit_of_item_id = $${idx++}`); params.push(Number(data.kit_of_item_id));
      fields.push(`kit_multiplier = $${idx++}`); params.push(Math.max(1, Math.round(Number(data.kit_multiplier) || 1)));
    }
  } else if (data.kit_multiplier !== undefined && current.kit_of_item_id) {
    fields.push(`kit_multiplier = $${idx++}`); params.push(Math.max(1, Math.round(Number(data.kit_multiplier) || 1)));
  }

  if (fields.length === 0) throw new ValidationError('No fields to update');
  fields.push(`updated_at = NOW()`);
  params.push(itemId, tenantId);

  const res = await query(
    `UPDATE wms.items SET ${fields.join(', ')} WHERE id = $${idx++} AND tenant_id = $${idx} RETURNING *`,
    params
  );
  return res.rows[0];
}

/** Гарантировать наличие item + SKU registry */
async function resolveOrCreateItem({ tenantId, clientId, barcode, dbClient = null }) {
  const db = dbClient || { query: (sql, params) => query(sql, params) };
  const b = validateBarcode(barcode);

  // Ищем item
  const itemRes = await db.query(
    `SELECT i.id, i.is_active FROM wms.items i WHERE i.tenant_id=$1 AND i.client_id=$2 AND i.barcode=$3 LIMIT 1`,
    [tenantId, clientId, b]
  );

  let itemId;
  if (itemRes.rowCount > 0) {
    if (!itemRes.rows[0].is_active) throw new ValidationError(`Item with barcode '${b}' is inactive`);
    itemId = itemRes.rows[0].id;
  } else {
    // Создаём минимальный item (будет обогащён позже из WB)
    const ins = await db.query(
      `INSERT INTO wms.items (tenant_id, client_id, barcode, item_name, unit, source)
       VALUES ($1,$2,$3,$4,'шт','auto')
       ON CONFLICT (tenant_id, client_id, barcode) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [tenantId, clientId, b, b]
    );
    itemId = ins.rows[0].id;
  }

  // SKU registry
  await db.query(
    `INSERT INTO wms.sku_registry (tenant_id, client_id, item_id, barcode)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, client_id, barcode) DO NOTHING`,
    [tenantId, clientId, itemId, b]
  );

  return itemId;
}

module.exports = {
  listItems, getItemById, getItemByBarcode,
  createItem, updateItem, resolveOrCreateItem,
};
