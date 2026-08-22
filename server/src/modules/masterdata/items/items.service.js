'use strict';

const { query, transaction } = require('../../../config/database');
const { NotFoundError, ConflictError, ValidationError } = require('../../../utils/errors');
const { validateNonEmptyString, validateBarcode, parseBool, extractGtinFromKizCode, gtinToBarcodeCandidates } = require('../../../utils/validators');

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
       i.wb_vendor_code, i.brand, i.unit, i.volume_liters, i.size,
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

/**
 * Определить товар по коду "Честный знак" — достаём GTIN из начала кода
 * и ищем товар с таким штрихкодом у ЭТОГО клиента (не по всей базе — barcode
 * уникален только в рамках клиента, у разных клиентов теоретически могут
 * встретиться одинаковые "самодельные" штрихкоды). Используется на сборке/
 * упаковке/приёмке, чтобы понять, к какому товару относится отсканированный
 * киз, без отдельного скана обычного штрихкода.
 *
 * Возвращает null (не бросает ошибку), если код не распознался как КИЗ или
 * товар с таким GTIN не нашёлся у клиента — вызывающий код должен в этом
 * случае откатиться на обычный ручной ввод/скан штрихкода.
 */
async function findItemByKizCode({ tenantId, clientId, code }) {
  const gtin = extractGtinFromKizCode(code);
  if (!gtin) return null;

  const candidates = gtinToBarcodeCandidates(gtin);
  const res = await query(
    `SELECT i.*, c.client_name FROM wms.items i LEFT JOIN wms.clients c ON c.id = i.client_id
     WHERE i.tenant_id = $1 AND i.client_id = $2 AND i.barcode = ANY($3::text[])
     LIMIT 1`,
    [tenantId, clientId, candidates]
  );
  return res.rowCount > 0 ? res.rows[0] : null;
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
        kit_of_item_id, kit_multiplier, requires_marking, marking_trigger, marking_mode, size)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
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
      data.size            ? String(data.size).trim().slice(0, 50) : null,
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
  str('size',           'size', 50);

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

/**
 * Удалить товар — только если по нему сейчас нет остатка (qty_on_hand=0 по
 * всем ячейкам/складам). Если товар когда-либо использовался (почти всегда
 * так — даже у авто-созданных "левых" товаров от кривой приёмки уже есть
 * строка в wms.sku_registry, см. resolveOrCreateItem ниже, плюс возможны
 * строки в stock_movements/picking_tasks/marking_codes и т.п.), настоящий
 * DELETE упадёт нарушением внешнего ключа — тогда вместо ошибки просто
 * деактивируем товар (is_active=false), не теряя историю. Тот же принцип,
 * что и у deleteLocation в locations.service.js.
 */
async function deleteItem({ tenantId, itemId }) {
  const current = await getItemById({ tenantId, itemId });

  const stockRes = await query(
    `SELECT COALESCE(SUM(qty_on_hand), 0)::int AS qty FROM wms.stock_balances WHERE item_id = $1`,
    [itemId]
  );
  const qty = stockRes.rows[0].qty;
  if (qty > 0) {
    throw new ValidationError(`У товара '${current.item_name || current.barcode}' есть остаток (${qty} шт.) — сначала спишите или переместите его.`);
  }

  try {
    const res = await query(
      `DELETE FROM wms.items WHERE id = $1 AND tenant_id = $2 RETURNING id, item_name, barcode`,
      [itemId, tenantId]
    );
    return { ...res.rows[0], mode: 'hard' };
  } catch (e) {
    if (e.code === '23503') {
      const res = await query(
        `UPDATE wms.items SET is_active = false, updated_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING id, item_name, barcode`,
        [itemId, tenantId]
      );
      return { ...res.rows[0], mode: 'soft' };
    }
    throw e;
  }
}

/**
 * Пачка удаления — та же логика построчно, не роняет всё на первой ошибке
 * (например на товаре с остатком), а просто считает его пропущенным и идёт
 * дальше, чтобы одним запросом почистить сразу много "левых" товаров.
 */
async function bulkDeleteItems({ tenantId, itemIds }) {
  const ids = Array.isArray(itemIds) ? itemIds.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!ids.length) throw new ValidationError('item_ids is required');
  if (ids.length > 1000) throw new ValidationError('Слишком много товаров за один раз (максимум 1000)');

  let deleted = 0, deactivated = 0, skipped = 0;
  const skippedItems = [];
  for (const id of ids) {
    try {
      const r = await deleteItem({ tenantId, itemId: id });
      if (r.mode === 'soft') deactivated++; else deleted++;
    } catch (e) {
      skipped++;
      skippedItems.push({ item_id: id, reason: e.message });
    }
  }
  return { deleted, deactivated, skipped, skipped_items: skippedItems };
}

/**
 * Материалы упаковки товара ("во что упаковывать") — список расходников
 * (wms.consumables) с нормой на 1 штуку товара. Используется на экране
 * упаковки, чтобы сборщику/упаковщику не приходилось угадывать/помнить,
 * что класть в короб — и автоматически списывается там же (см.
 * packing.service.js:scanItem → consumables.service.js:recordUsage).
 */
async function getItemPackagingMaterials({ tenantId, itemId }) {
  const r = await query(
    `SELECT ipm.consumable_id, ipm.qty_per_unit, c.name, c.unit,
            c.qty_on_hand, c.client_unit_price, c.currency, c.is_active
     FROM wms.item_packaging_materials ipm
     JOIN wms.consumables c ON c.id = ipm.consumable_id
     WHERE ipm.tenant_id=$1 AND ipm.item_id=$2
     ORDER BY c.name`,
    [tenantId, itemId]
  );
  return r.rows;
}

/** Полностью заменить список материалов упаковки товара (проще для UI —
 *  один "Сохранить" вместо построчного добавления/удаления по одному). */
async function setItemPackagingMaterials({ tenantId, itemId, materials }) {
  return transaction(async (client) => {
    const itemCheck = await client.query(
      `SELECT id FROM wms.items WHERE id=$1 AND tenant_id=$2`, [itemId, tenantId]
    );
    if (itemCheck.rowCount === 0) throw new NotFoundError('Item', itemId);

    await client.query(
      `DELETE FROM wms.item_packaging_materials WHERE tenant_id=$1 AND item_id=$2`,
      [tenantId, itemId]
    );

    const list = Array.isArray(materials) ? materials : [];
    for (const m of list) {
      const consumableId = Number(m.consumable_id);
      const qtyPerUnit = Number(m.qty_per_unit) || 1;
      if (!consumableId) continue;
      await client.query(
        `INSERT INTO wms.item_packaging_materials (tenant_id, item_id, consumable_id, qty_per_unit)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (item_id, consumable_id) DO UPDATE SET qty_per_unit=EXCLUDED.qty_per_unit`,
        [tenantId, itemId, consumableId, qtyPerUnit]
      );
    }
    return { ok: true };
  });
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

/**
 * Найти УЖЕ ЗАВЕДЁННЫЙ товар клиента по штрихкоду — без автосоздания.
 * В отличие от resolveOrCreateItem (используется в доверенных источниках вроде
 * синхронизации WB, где неизвестный барcode - это легитимный новый товар с
 * маркетплейса), здесь источник - ручной скан приёмщиком, и раньше та же
 * resolveOrCreateItem тихо заводила новый товар на ЛЮБОЙ отсканированный
 * штрихкод - то есть приёмщик мог "принять" вообще что угодно, включая
 * опечатку сканера. Требуем, чтобы товар был заранее заведён в каталоге
 * (клиентом в его кабинете или админом) - иначе понятная ошибка вместо
 * тихого создания.
 */
async function resolveExistingItem({ tenantId, clientId, barcode, dbClient = null }) {
  const db = dbClient || { query: (sql, params) => query(sql, params) };
  const b = validateBarcode(barcode);

  const res = await db.query(
    `SELECT id, is_active FROM wms.items WHERE tenant_id=$1 AND client_id=$2 AND barcode=$3 LIMIT 1`,
    [tenantId, clientId, b]
  );
  if (res.rowCount === 0) {
    throw new ValidationError(
      `Товар со штрихкодом '${b}' не найден в каталоге этого клиента. ` +
      `Сначала заведите товар в справочнике (в админке или в кабинете клиента), затем принимайте.`
    );
  }
  if (!res.rows[0].is_active) {
    throw new ValidationError(`Товар со штрихкодом '${b}' есть в каталоге, но отключён (неактивен).`);
  }
  return res.rows[0].id;
}

module.exports = {
  listItems, getItemById, getItemByBarcode, findItemByKizCode,
  createItem, updateItem, deleteItem, bulkDeleteItems,
  resolveOrCreateItem, resolveExistingItem,
  getItemPackagingMaterials, setItemPackagingMaterials,
};
