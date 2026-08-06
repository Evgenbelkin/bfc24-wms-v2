'use strict';

const { query } = require('../../../config/database');
const { NotFoundError, ConflictError, ValidationError } = require('../../../utils/errors');
const { validateNonEmptyString, parseBool, validatePositiveInt } = require('../../../utils/validators');

// =============================================================================
// Locations Service
// =============================================================================

const VALID_TYPES = ['rack','floor','buffer','receiving','shipping','quarantine','virtual'];

async function listLocations({ tenantId, warehouseId = null, zoneCode = null, locationType = null, isActive = null, search = null, limit = 200, offset = 0 }) {
  const params = [tenantId];
  const conds = ['l.tenant_id = $1'];
  let idx = 2;

  if (warehouseId) { conds.push(`l.warehouse_id = $${idx++}`); params.push(warehouseId); }
  if (zoneCode)    { conds.push(`l.zone_code = $${idx++}`); params.push(zoneCode); }
  if (locationType){ conds.push(`l.location_type = $${idx++}`); params.push(locationType); }
  if (isActive !== null) { conds.push(`l.is_active = $${idx++}`); params.push(isActive); }
  if (search) {
    conds.push(`l.location_code ILIKE $${idx++}`);
    params.push(`%${search}%`);
  }

  const countRes = await query(`SELECT COUNT(*)::int AS total FROM wms.locations l WHERE ${conds.join(' AND ')}`, params);
  const total = countRes.rows[0].total;

  params.push(Math.min(limit, 1000), Math.max(offset, 0));
  const res = await query(
    `SELECT
       l.id, l.warehouse_id, l.location_code, l.description,
       l.location_type, l.zone_code, l.aisle, l.rack, l.shelf, l.position,
       l.is_active, l.is_pick_location,
       l.max_weight_kg, l.max_volume_l,
       w.warehouse_name,
       COALESCE(SUM(sb.qty_on_hand), 0)::int AS qty_on_hand
     FROM wms.locations l
     JOIN wms.warehouses w ON w.id = l.warehouse_id
     LEFT JOIN wms.stock_balances sb ON sb.location_id = l.id
     WHERE ${conds.join(' AND ')}
     GROUP BY l.id, w.warehouse_name
     ORDER BY l.location_code
     LIMIT $${idx++} OFFSET $${idx}`,
    params
  );
  return { locations: res.rows, total, limit, offset };
}

async function getLocationById({ tenantId, locationId }) {
  const res = await query(
    `SELECT l.*, w.warehouse_name FROM wms.locations l
     JOIN wms.warehouses w ON w.id = l.warehouse_id
     WHERE l.id = $1 AND l.tenant_id = $2`,
    [locationId, tenantId]
  );
  if (res.rowCount === 0) throw new NotFoundError('Location', locationId);
  return res.rows[0];
}

async function getLocationByCode({ tenantId, warehouseId, locationCode }) {
  const code = String(locationCode || '').trim();
  if (!code) throw new ValidationError('location_code is required');

  const params = [tenantId, code];
  let sql = `SELECT l.*, w.warehouse_name FROM wms.locations l
             JOIN wms.warehouses w ON w.id = l.warehouse_id
             WHERE l.tenant_id = $1 AND l.location_code = $2`;
  if (warehouseId) { sql += ` AND l.warehouse_id = $3`; params.push(warehouseId); }
  sql += ` LIMIT 1`;

  const res = await query(sql, params);
  if (res.rowCount === 0) throw new NotFoundError(`Location '${code}'`);
  return res.rows[0];
}

async function createLocation({ tenantId, warehouseId, createdById, data }) {
  // Нормализуем к верхнему регистру — иначе одна и та же ячейка, введённая
  // один раз как "bufer", а отсканированная как "BUFER" (сканеры/камеры и
  // ручной ввод в верхнем регистре — обычное дело), не будет находиться по
  // точному совпадению в местах, где код ячейки сверяется со сканом.
  const code = validateNonEmptyString(data.location_code, 'location_code', 100).trim().toUpperCase();
  const wid  = warehouseId || validatePositiveInt(data.warehouse_id, 'warehouse_id');
  const type = data.location_type || 'rack';

  if (!VALID_TYPES.includes(type)) throw new ValidationError(`Invalid location_type. Allowed: ${VALID_TYPES.join(', ')}`);

  const exists = await query(
    `SELECT id FROM wms.locations WHERE tenant_id=$1 AND warehouse_id=$2 AND location_code=$3`,
    [tenantId, wid, code]
  );
  if (exists.rowCount > 0) throw new ConflictError(`Location '${code}' already exists in this warehouse`);

  const res = await query(
    `INSERT INTO wms.locations
       (tenant_id, warehouse_id, location_code, description, location_type,
        zone_code, aisle, rack, shelf, position,
        max_weight_kg, max_volume_l, is_active, is_pick_location, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING *`,
    [
      tenantId, wid, code,
      data.description || null, type,
      data.zone_code || null, data.aisle || null, data.rack || null,
      data.shelf || null, data.position || null,
      data.max_weight_kg != null ? Number(data.max_weight_kg) : null,
      data.max_volume_l  != null ? Number(data.max_volume_l)  : null,
      parseBool(data.is_active, true),
      parseBool(data.is_pick_location, true),
      createdById,
    ]
  );
  return res.rows[0];
}

async function updateLocation({ tenantId, locationId, data }) {
  await getLocationById({ tenantId, locationId });

  const fields = [];
  const params = [];
  let idx = 1;

  const str = (k, col, max = 200) => { if (data[k] !== undefined) { fields.push(`${col} = $${idx++}`); params.push(data[k] ? String(data[k]).trim().slice(0, max) : null); } };
  const num = (k, col) => { if (data[k] !== undefined) { fields.push(`${col} = $${idx++}`); params.push(data[k] != null ? Number(data[k]) : null); } };
  const bool = (k, col, def) => { if (data[k] !== undefined) { fields.push(`${col} = $${idx++}`); params.push(parseBool(data[k], def)); } };

  str('description', 'description', 500);
  str('zone_code', 'zone_code', 50);
  str('aisle', 'aisle', 20);
  str('rack', 'rack', 20);
  str('shelf', 'shelf', 20);
  str('position', 'position', 20);
  num('max_weight_kg', 'max_weight_kg');
  num('max_volume_l', 'max_volume_l');
  bool('is_active', 'is_active', true);
  bool('is_pick_location', 'is_pick_location', true);

  if (data.location_type !== undefined) {
    if (!VALID_TYPES.includes(data.location_type)) throw new ValidationError('Invalid location_type');
    fields.push(`location_type = $${idx++}`); params.push(data.location_type);
  }

  if (fields.length === 0) throw new ValidationError('No fields to update');
  fields.push(`updated_at = NOW()`);
  params.push(locationId, tenantId);

  const res = await query(
    `UPDATE wms.locations SET ${fields.join(', ')} WHERE id = $${idx++} AND tenant_id = $${idx} RETURNING *`,
    params
  );
  return res.rows[0];
}

const MAX_BULK_CELLS = 2000;

/**
 * Массово создать ячейки по шаблону "<зона>-<ряд>-<позиция>" (например
 * A-01-01 .. A-06-50) — вместо того, чтобы заводить их по одной руками через
 * форму. Пропускает уже существующие коды (не ошибка, просто skip) — так
 * можно спокойно перезапускать с расширенным диапазоном, не боясь дублей.
 */
async function bulkCreateLocations({
  tenantId, warehouseId, createdById, zone,
  rowFrom, rowTo, positionFrom, positionTo,
  locationType = 'rack', padWidth = 2,
}) {
  const z = validateNonEmptyString(zone, 'zone', 10).trim().toUpperCase();
  const wid = validatePositiveInt(warehouseId, 'warehouse_id');
  const rFrom = validatePositiveInt(rowFrom, 'row_from');
  const rTo = validatePositiveInt(rowTo, 'row_to');
  const pFrom = validatePositiveInt(positionFrom, 'position_from');
  const pTo = validatePositiveInt(positionTo, 'position_to');
  if (rTo < rFrom) throw new ValidationError('row_to must be >= row_from');
  if (pTo < pFrom) throw new ValidationError('position_to must be >= position_from');
  if (!VALID_TYPES.includes(locationType)) throw new ValidationError(`Invalid location_type. Allowed: ${VALID_TYPES.join(', ')}`);
  const pad = Math.min(Math.max(Number(padWidth) || 2, 1), 6);

  const total = (rTo - rFrom + 1) * (pTo - pFrom + 1);
  if (total > MAX_BULK_CELLS) {
    throw new ValidationError(`Слишком много ячеек за один раз (${total}) — максимум ${MAX_BULK_CELLS}. Разбейте диапазон на несколько запросов.`);
  }

  const codes = [];
  for (let row = rFrom; row <= rTo; row++) {
    for (let pos = pFrom; pos <= pTo; pos++) {
      codes.push(`${z}-${String(row).padStart(pad, '0')}-${String(pos).padStart(pad, '0')}`);
    }
  }

  let created = 0;
  const createdCodes = [];
  for (const code of codes) {
    const r = await query(
      `INSERT INTO wms.locations (tenant_id, warehouse_id, location_code, location_type, zone_code, is_active, is_pick_location, created_by)
       VALUES ($1,$2,$3,$4,$5,TRUE,TRUE,$6)
       ON CONFLICT (tenant_id, warehouse_id, location_code) DO NOTHING
       RETURNING id, location_code`,
      [tenantId, wid, code, locationType, z, createdById]
    );
    if (r.rowCount > 0) { created++; createdCodes.push(r.rows[0].location_code); }
  }

  return { total: codes.length, created, skipped: codes.length - created, codes: createdCodes };
}

/** Ячейки по списку id (для массовой печати наклеек) — строго в рамках тенанта. */
async function getLocationsByIds({ tenantId, ids }) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!list.length) return [];
  const r = await query(
    `SELECT id, location_code FROM wms.locations WHERE tenant_id=$1 AND id = ANY($2::int[]) ORDER BY location_code`,
    [tenantId, list]
  );
  return r.rows;
}

/** Найти лучшую ячейку для SKU (с максимальным остатком) */
async function findBestPickLocation({ tenantId, warehouseId, itemId, clientId }) {
  const res = await query(
    `SELECT
       l.id AS location_id, l.location_code, sb.qty_on_hand, sb.qty_available
     FROM wms.stock_balances sb
     JOIN wms.locations l ON l.id = sb.location_id
     WHERE sb.tenant_id  = $1
       AND sb.warehouse_id = $2
       AND sb.item_id    = $3
       AND sb.client_id  = $4
       AND sb.qty_available > 0
       AND l.is_active = TRUE
       AND l.is_pick_location = TRUE
     ORDER BY sb.qty_available DESC, l.location_code
     LIMIT 1`,
    [tenantId, warehouseId, itemId, clientId]
  );
  return res.rowCount > 0 ? res.rows[0] : null;
}

module.exports = {
  listLocations, getLocationById, getLocationByCode,
  createLocation, updateLocation, findBestPickLocation,
  bulkCreateLocations, getLocationsByIds,
};
