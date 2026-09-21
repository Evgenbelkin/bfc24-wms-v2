'use strict';

const { query } = require('../../../config/database');
const { NotFoundError, ConflictError, ValidationError } = require('../../../utils/errors');
const { validateNonEmptyString, parseBool, validatePositiveInt } = require('../../../utils/validators');
const { resolveStockKey } = require('../items/items.service');
const { locationWalkKey, compareWalkKeys } = require('../../../utils/warehouseLayout');

// =============================================================================
// Locations Service
// =============================================================================

const VALID_TYPES = ['rack','floor','buffer','receiving','shipping','quarantine','virtual'];

/** Объём в литрах из размеров ячейки в см (1000 см³ = 1 л), или null если размеры не заданы. */
function volumeFromDims(lengthCm, widthCm, heightCm) {
  if (lengthCm == null || widthCm == null || heightCm == null) return null;
  const l = Number(lengthCm), w = Number(widthCm), h = Number(heightCm);
  if (!(l > 0) || !(w > 0) || !(h > 0)) return null;
  return Math.round((l * w * h / 1000) * 100) / 100;
}

async function listLocations({ tenantId, warehouseId = null, zoneCode = null, locationType = null, isActive = null, search = null, subWarehouseId = null, limit = 200, offset = 0 }) {
  const params = [tenantId];
  const conds = ['l.tenant_id = $1'];
  let idx = 2;

  if (warehouseId) { conds.push(`l.warehouse_id = $${idx++}`); params.push(warehouseId); }
  if (zoneCode)    { conds.push(`l.zone_code = $${idx++}`); params.push(zoneCode); }
  if (locationType){ conds.push(`l.location_type = $${idx++}`); params.push(locationType); }
  if (isActive !== null) { conds.push(`l.is_active = $${idx++}`); params.push(isActive); }
  // Под-склады (17.09.2026) — фильтр "без под-склада" через явное значение
  // 'none' (не ставим тут магию на null/0, чтобы не путать с "фильтр не задан").
  if (subWarehouseId === 'none') {
    conds.push(`l.sub_warehouse_id IS NULL`);
  } else if (subWarehouseId) {
    conds.push(`l.sub_warehouse_id = $${idx++}`); params.push(subWarehouseId);
  }
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
       l.length_cm, l.width_cm, l.height_cm,
       l.sub_warehouse_id, sw.code AS sub_warehouse_code, sw.name AS sub_warehouse_name,
       w.warehouse_name,
       COALESCE(SUM(sb.qty_on_hand), 0)::int AS qty_on_hand
     FROM wms.locations l
     JOIN wms.warehouses w ON w.id = l.warehouse_id
     LEFT JOIN wms.sub_warehouses sw ON sw.id = l.sub_warehouse_id
     LEFT JOIN wms.stock_balances sb ON sb.location_id = l.id
     WHERE ${conds.join(' AND ')}
     GROUP BY l.id, w.warehouse_name, sw.code, sw.name
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
  // Как и в validateBarcode - убираем весь whitespace, не только края (сканер
  // иногда добавляет лишний пробел, код ячейки пробелов не содержит).
  const code = String(locationCode || '').replace(/\s+/g, '');
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

  // Под-склад (17.09.2026) — тот же контроль "того же физического склада",
  // что и в updateLocation.
  let subWarehouseId = data.sub_warehouse_id ? Number(data.sub_warehouse_id) : null;
  if (subWarehouseId) {
    const swRes = await query(`SELECT warehouse_id FROM wms.sub_warehouses WHERE id=$1 AND tenant_id=$2`, [subWarehouseId, tenantId]);
    if (swRes.rowCount === 0) throw new NotFoundError('Под-склад', subWarehouseId);
    if (swRes.rows[0].warehouse_id !== wid) throw new ValidationError('Этот под-склад относится к другому физическому складу');
  }

  // Вместимость в литрах: если заданы все три размера — считаем сами
  // (L*W*H/1000), явно переданный max_volume_l имеет приоритет (на случай
  // нестандартной формы ячейки, где произведение размеров не отражает
  // реальную полезную ёмкость).
  const lengthCm = data.length_cm != null ? Number(data.length_cm) : null;
  const widthCm  = data.width_cm  != null ? Number(data.width_cm)  : null;
  const heightCm = data.height_cm != null ? Number(data.height_cm) : null;
  const maxVolumeL = data.max_volume_l != null
    ? Number(data.max_volume_l)
    : volumeFromDims(lengthCm, widthCm, heightCm);

  const res = await query(
    `INSERT INTO wms.locations
       (tenant_id, warehouse_id, location_code, description, location_type,
        zone_code, aisle, rack, shelf, position,
        max_weight_kg, max_volume_l, length_cm, width_cm, height_cm,
        is_active, is_pick_location, created_by, sub_warehouse_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING *`,
    [
      tenantId, wid, code,
      data.description || null, type,
      data.zone_code || null, data.aisle || null, data.rack || null,
      data.shelf || null, data.position || null,
      data.max_weight_kg != null ? Number(data.max_weight_kg) : null,
      maxVolumeL, lengthCm, widthCm, heightCm,
      parseBool(data.is_active, true),
      parseBool(data.is_pick_location, true),
      createdById, subWarehouseId,
    ]
  );
  return res.rows[0];
}

async function updateLocation({ tenantId, locationId, data }) {
  const current = await getLocationById({ tenantId, locationId });

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
  num('length_cm', 'length_cm');
  num('width_cm', 'width_cm');
  num('height_cm', 'height_cm');
  bool('is_active', 'is_active', true);
  bool('is_pick_location', 'is_pick_location', true);

  // Вместимость: явно переданный max_volume_l побеждает; иначе, если в этом
  // вызове меняется хотя бы один из размеров — пересчитываем из полного
  // набора размеров (новые значения + то, что уже было сохранено раньше).
  if (data.max_volume_l !== undefined) {
    num('max_volume_l', 'max_volume_l');
  } else if (data.length_cm !== undefined || data.width_cm !== undefined || data.height_cm !== undefined) {
    const l = data.length_cm !== undefined ? data.length_cm : current.length_cm;
    const w = data.width_cm  !== undefined ? data.width_cm  : current.width_cm;
    const h = data.height_cm !== undefined ? data.height_cm : current.height_cm;
    fields.push(`max_volume_l = $${idx++}`);
    params.push(volumeFromDims(l, w, h));
  }

  if (data.location_type !== undefined) {
    if (!VALID_TYPES.includes(data.location_type)) throw new ValidationError('Invalid location_type');
    fields.push(`location_type = $${idx++}`); params.push(data.location_type);
  }

  // Под-склад (17.09.2026) — либо конкретный id (должен быть с ТОГО ЖЕ
  // физического склада, что и ячейка — иначе бессмысленная комбинация),
  // либо null/0 = снять привязку.
  if (data.sub_warehouse_id !== undefined) {
    const swId = data.sub_warehouse_id ? Number(data.sub_warehouse_id) : null;
    if (swId) {
      const swRes = await query(`SELECT warehouse_id FROM wms.sub_warehouses WHERE id=$1 AND tenant_id=$2`, [swId, tenantId]);
      if (swRes.rowCount === 0) throw new NotFoundError('Под-склад', swId);
      if (swRes.rows[0].warehouse_id !== current.warehouse_id) {
        throw new ValidationError('Этот под-склад относится к другому физическому складу');
      }
    }
    fields.push(`sub_warehouse_id = $${idx++}`); params.push(swId);
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

/**
 * Удалить ячейку — только если в ней сейчас нет товара (qty_on_hand=0 по
 * всем строкам stock_balances для этой ячейки). Если ячейку когда-либо
 * использовали (есть строки в истории — stock_movements, picking_tasks,
 * receiving_tasks, returns и т.п. ссылаются на неё по FK без каскада),
 * настоящий DELETE упадёт нарушением внешнего ключа — в этом случае вместо
 * ошибки просто деактивируем ячейку (is_active=false, тот же эффект "ушла
 * из списка активных"), не теряя историю движений по ней. Возвращаем режим
 * ('hard' | 'soft'), чтобы фронт мог показать разное сообщение.
 */
async function deleteLocation({ tenantId, locationId }) {
  const current = await getLocationById({ tenantId, locationId });

  const stockRes = await query(
    `SELECT COALESCE(SUM(qty_on_hand), 0)::int AS qty FROM wms.stock_balances WHERE location_id = $1`,
    [locationId]
  );
  const qty = stockRes.rows[0].qty;
  if (qty > 0) {
    throw new ValidationError(`В ячейке '${current.location_code}' ещё есть товар (${qty} шт.) — сначала переместите или спишите его.`);
  }

  try {
    const res = await query(
      `DELETE FROM wms.locations WHERE id = $1 AND tenant_id = $2 RETURNING id, location_code`,
      [locationId, tenantId]
    );
    return { ...res.rows[0], mode: 'hard' };
  } catch (e) {
    // 23503 = foreign_key_violation — по ячейке уже есть история (движения,
    // задачи сборки/приёмки и т.п.), удалить нельзя, не потеряв эту историю.
    if (e.code === '23503') {
      const res = await query(
        `UPDATE wms.locations SET is_active = false, updated_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING id, location_code`,
        [locationId, tenantId]
      );
      return { ...res.rows[0], mode: 'soft' };
    }
    throw e;
  }
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
  lengthCm = null, widthCm = null, heightCm = null, maxVolumeL = null,
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

  // Размеры (если заданы) применяются одинаково ко всем ячейкам партии — для
  // типового стеллажа с одинаковыми по объёму ячейками этого достаточно;
  // для нестандартных ячеек размеры потом можно поправить массовым или
  // одиночным редактированием.
  const lCm = lengthCm != null ? Number(lengthCm) : null;
  const wCm = widthCm  != null ? Number(widthCm)  : null;
  const hCm = heightCm != null ? Number(heightCm) : null;
  const volumeL = maxVolumeL != null ? Number(maxVolumeL) : volumeFromDims(lCm, wCm, hCm);

  let created = 0;
  const createdCodes = [];
  for (const code of codes) {
    const r = await query(
      `INSERT INTO wms.locations
         (tenant_id, warehouse_id, location_code, location_type, zone_code,
          length_cm, width_cm, height_cm, max_volume_l,
          is_active, is_pick_location, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,TRUE,$10)
       ON CONFLICT (tenant_id, warehouse_id, location_code) DO NOTHING
       RETURNING id, location_code`,
      [tenantId, wid, code, locationType, z, lCm, wCm, hCm, volumeL, createdById]
    );
    if (r.rowCount > 0) { created++; createdCodes.push(r.rows[0].location_code); }
  }

  return { total: codes.length, created, skipped: codes.length - created, codes: createdCodes };
}

/**
 * Массово задать размеры/вместимость уже существующим ячейкам (по списку id)
 * — например выбрали чекбоксами 30 ячеек одного стеллажа и одним запросом
 * проставили всем 60×40×40. max_volume_l, если передан явно, побеждает
 * расчёт из размеров (см. volumeFromDims) — тот же приоритет, что и в
 * createLocation/updateLocation.
 */
async function bulkUpdateDimensions({ tenantId, ids, lengthCm = null, widthCm = null, heightCm = null, maxVolumeL = null }) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!list.length) throw new ValidationError('ids must be a non-empty array');

  const lCm = lengthCm != null ? Number(lengthCm) : null;
  const wCm = widthCm  != null ? Number(widthCm)  : null;
  const hCm = heightCm != null ? Number(heightCm) : null;
  const volumeL = maxVolumeL != null ? Number(maxVolumeL) : volumeFromDims(lCm, wCm, hCm);

  if (lCm == null && wCm == null && hCm == null && volumeL == null) {
    throw new ValidationError('Нужно указать хотя бы размеры или объём');
  }

  const r = await query(
    `UPDATE wms.locations
     SET length_cm=$1, width_cm=$2, height_cm=$3, max_volume_l=$4, updated_at=NOW()
     WHERE tenant_id=$5 AND id = ANY($6::int[])
     RETURNING id, location_code`,
    [lCm, wCm, hCm, volumeL, tenantId, list]
  );
  return { updated: r.rowCount, locations: r.rows };
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

/**
 * Заполняемость ячеек по объёму — для экрана-сетки склада. Занятый объём
 * считается тем же способом, что и тарификация хранения по литражу
 * (billing.service.js:chargeStorageForClientToday, storage_mode='volume'):
 * SUM(qty_on_hand × item.volume_liters) по ячейке; если у товара объём не
 * указан — считаем как 1 литр за штуку (тот же fallback, чтобы не терять
 * ячейку из отчёта только из-за незаполненной карточки товара).
 * pickOnly=true (по умолчанию) — только стеллажные/pick-ячейки, где реально
 * лежит товар для сборки; буферные/приёмка/отгрузка/карантин/виртуальные
 * для планирования вместимости не так важны и обычно не имеют заданного
 * объёма вовсе.
 */
async function getLocationFillReport({ tenantId, warehouseId = null, pickOnly = true }) {
  const params = [tenantId];
  const conds = ['l.tenant_id = $1', 'l.is_active = TRUE'];
  let idx = 2;
  if (warehouseId) { conds.push(`l.warehouse_id = $${idx++}`); params.push(warehouseId); }
  if (pickOnly) conds.push(`l.is_pick_location = TRUE AND l.location_type = 'rack'`);

  const res = await query(
    `SELECT
       l.id, l.location_code, l.zone_code, l.warehouse_id,
       l.length_cm, l.width_cm, l.height_cm, l.max_volume_l,
       COALESCE(occ.occupied_liters, 0)::numeric AS occupied_liters,
       COALESCE(occ.sku_count, 0)::int AS sku_count,
       COALESCE(occ.qty_on_hand, 0)::int AS qty_on_hand
     FROM wms.locations l
     LEFT JOIN LATERAL (
       SELECT
         SUM(sb.qty_on_hand * COALESCE(i.volume_liters, 1))::numeric AS occupied_liters,
         COUNT(DISTINCT sb.item_id)::int AS sku_count,
         SUM(sb.qty_on_hand)::int AS qty_on_hand
       FROM wms.stock_balances sb
       JOIN wms.items i ON i.id = sb.item_id
       WHERE sb.location_id = l.id AND sb.qty_on_hand > 0
     ) occ ON TRUE
     WHERE ${conds.join(' AND ')}
     ORDER BY l.location_code`,
    params
  );

  return res.rows.map(r => {
    const capacity = r.max_volume_l != null ? Number(r.max_volume_l) : null;
    const occupied = Number(r.occupied_liters);
    const fillPct = capacity && capacity > 0 ? Math.round((occupied / capacity) * 1000) / 10 : null;
    return {
      id: r.id, location_code: r.location_code, zone_code: r.zone_code, warehouse_id: r.warehouse_id,
      length_cm: r.length_cm, width_cm: r.width_cm, height_cm: r.height_cm,
      capacity_liters: capacity, occupied_liters: Math.round(occupied * 100) / 100,
      fill_pct: fillPct, sku_count: r.sku_count, qty_on_hand: r.qty_on_hand,
    };
  });
}

/** Найти лучшую ячейку для SKU.
 *  РАНЬШЕ сортировали по sb.qty_available DESC — то есть выбирали ячейку с
 *  БОЛЬШИМ остатком. На практике это почти всегда оказывалась ячейка со
 *  свежей приёмкой (её только что заполнили целиком), а старый остаток в
 *  других ячейках к этому моменту уже подраспродан и в них лежит немного
 *  (1-3 шт.) — получалось, что на сборку систематически уходил СЕГОДНЯШНИЙ
 *  товар, а старый копился и не расходовался вообще (не FIFO). У нас нет
 *  партионного/лотового учёта в stock_balances (остаток агрегирован по
 *  item+location без даты конкретной партии), поэтому точного FIFO нет - но
 *  last_movement_at (когда последний раз меняли physически qty_on_hand в этой
 *  ячейке — приход/расход/инвентаризация; резервирование его не трогает, см.
 *  wms.reserve_stock) - неплохой прокси: ячейка, которую давно не трогали,
 *  почти наверняка содержит старый товар. Сортируем по ней по возрастанию
 *  (сначала самая "нетронутая" = самая старая), остаток - только как
 *  вторичный критерий при равных датах. */
async function findBestPickLocation({ tenantId, warehouseId, itemId, clientId, afterCode = null, dbClient = null }) {
  // dbClient (найдено 21.09.2026 при тесте "Дефициты"): по умолчанию этот
  // запрос идёт через query() - ОТДЕЛЬНОЕ соединение из пула, не видящее
  // незакоммиченные записи чужой транзакции. skipTask() в picking.service.js
  // сначала физически переносит остаток исходной ячейки в карантин ВНУТРИ
  // своей транзакции, а затем в том же вызове ищет "альтернативную ячейку"
  // для авто-повтора - без dbClient этот поиск видел ещё СТАРОЕ (закоммиченное
  // до транзакции) состояние исходной ячейки и ошибочно "находил" её же саму
  // как альтернативу (остаток по факту уже обнулён, но снаружи транзакции
  // это ещё не видно) - задача requeue'ilась туда же, откуда её только что
  // убрали, вместо реального поиска в другом месте или переноса в "Дефициты".
  // Передавайте transaction-client, когда вызов идёт из активной транзакции,
  // изменившей остаток по этому же товару.
  const runner = dbClient || { query };
  // Пул остатков (миграция 061) — если товар связан с пулом, физический
  // остаток и ячейка ищутся у пул-клиента, а не у клиента заказа. Для
  // тенантов без пулинга resolveStockKey возвращает itemId/clientId как есть.
  const stockKey = await resolveStockKey({ tenantId, itemId, clientId });
  itemId = stockKey.stockItemId;
  clientId = stockKey.stockClientId;

  // afterCode (обсуждение с пользователем 16.09.2026, "добор товара должен
  // идти вперёд по маршруту, а не назад") — используется ТОЛЬКО когда
  // getNextTask перевыбирает ячейку для товара, у которого "запиненная"
  // ячейка в этой волне уже исчерпана (см. picking.service.js). Без afterCode
  // (обычный вызов — первая ячейка для товара, приёмка, ручной подбор и т.п.)
  // поведение не меняется вообще: LIMIT 1, чистый FIFO по last_movement_at.
  // С afterCode — тянем ВСЕ подходящие по остатку ячейки (тот же порядок:
  // сначала самая старая), и в JS предпочитаем те, что по коду ячейки не
  // ПОЗАДИ уже пройденного места (compareWalkKeys >= 0). Если среди них нет
  // ни одной с остатком - откатываемся к глобально самой старой по складу,
  // как раньше (лучше отправить назад, чем вообще не найти, чем нарушить
  // FIFO по всему складу молча).
  const res = await runner.query(
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
       -- "Карантин": если сборщик уже сообщил "товар не найден" на этой ячейке
       -- по этому товару, автоматически создаётся задача инвентаризации
       -- (см. picking.service.js skipTask, reason='picker_not_found') с
       -- ПРИОРИТЕТОМ 1. Пока эта задача не закрыта (товар физически не
       -- подтверждён или остаток не обнулён) - не предлагаем эту ячейку
       -- сборщикам повторно: без этой проверки один и тот же фантомный
       -- остаток продолжал уходить на сборку раз за разом, пока кто-то
       -- вручную не находил и не чинил задачу инвентаризации.
       AND NOT EXISTS (
         SELECT 1 FROM wms.inventory_tasks it
         WHERE it.tenant_id = sb.tenant_id
           AND it.item_id = sb.item_id
           AND it.location_id = l.id
           AND it.status IN ('open','in_progress')
           AND it.reason = 'picker_not_found'
       )
     ORDER BY sb.last_movement_at ASC NULLS FIRST, sb.qty_available DESC, l.location_code
     ${afterCode ? '' : 'LIMIT 1'}`,
    [tenantId, warehouseId, itemId, clientId]
  );
  if (res.rowCount === 0) return null;
  if (!afterCode) return res.rows[0];

  const afterKey = locationWalkKey(afterCode);
  const ahead = res.rows.find(r => compareWalkKeys(locationWalkKey(r.location_code), afterKey) >= 0);
  return ahead || res.rows[0];
}

// =============================================================================
// Под-склады (17.09.2026) — см. миграцию 066_sub_warehouses.sql. Чисто
// аддитивный слой поверх ячеек: таблица wms.sub_warehouses + необязательный
// тег на ячейке. Ничего в остатках/сборке/размещении не меняет — используется
// только для группировки в отчёте "Обзор склада" (stock.service.js).
// =============================================================================

/** Список под-складов (с количеством привязанных ячеек — чтобы в UI сразу
 *  было видно, пустой под-склад или уже используется). */
async function listSubWarehouses({ tenantId, warehouseId = null, isActive = null }) {
  const params = [tenantId];
  const conds = ['sw.tenant_id = $1'];
  let idx = 2;
  if (warehouseId) { conds.push(`sw.warehouse_id = $${idx++}`); params.push(warehouseId); }
  if (isActive !== null) { conds.push(`sw.is_active = $${idx++}`); params.push(isActive); }

  const res = await query(
    `SELECT sw.*, w.warehouse_name,
       COALESCE(lc.cnt, 0)::int AS locations_count
     FROM wms.sub_warehouses sw
     JOIN wms.warehouses w ON w.id = sw.warehouse_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS cnt FROM wms.locations l WHERE l.sub_warehouse_id = sw.id
     ) lc ON TRUE
     WHERE ${conds.join(' AND ')}
     ORDER BY w.warehouse_name, sw.name`,
    params
  );
  return res.rows;
}

async function createSubWarehouse({ tenantId, warehouseId, createdById, code, name }) {
  const wid = validatePositiveInt(warehouseId, 'warehouse_id');
  const c = validateNonEmptyString(code, 'code', 30).trim().toUpperCase();
  const n = validateNonEmptyString(name, 'name', 100).trim();

  const exists = await query(
    `SELECT id FROM wms.sub_warehouses WHERE tenant_id=$1 AND warehouse_id=$2 AND code=$3`,
    [tenantId, wid, c]
  );
  if (exists.rowCount > 0) throw new ConflictError(`Под-склад '${c}' уже существует на этом складе`);

  const res = await query(
    `INSERT INTO wms.sub_warehouses (tenant_id, warehouse_id, code, name, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [tenantId, wid, c, n, createdById]
  );
  return res.rows[0];
}

async function updateSubWarehouse({ tenantId, subWarehouseId, data }) {
  const fields = []; const params = []; let idx = 1;
  if (data.name !== undefined) {
    fields.push(`name = $${idx++}`);
    params.push(validateNonEmptyString(data.name, 'name', 100).trim());
  }
  if (data.is_active !== undefined) {
    fields.push(`is_active = $${idx++}`);
    params.push(parseBool(data.is_active, true));
  }
  if (!fields.length) throw new ValidationError('No fields to update');
  fields.push('updated_at = NOW()');
  params.push(subWarehouseId, tenantId);

  const res = await query(
    `UPDATE wms.sub_warehouses SET ${fields.join(', ')} WHERE id = $${idx++} AND tenant_id = $${idx} RETURNING *`,
    params
  );
  if (res.rowCount === 0) throw new NotFoundError('Под-склад', subWarehouseId);
  return res.rows[0];
}

/** Массово назначить (или снять, subWarehouseId=null) под-склад сразу
 *  нескольким выбранным ячейкам — так клиент размечает весь свой участок
 *  склада за один запрос, а не кликает по ячейке. */
async function bulkAssignSubWarehouse({ tenantId, ids, subWarehouseId }) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!list.length) throw new ValidationError('ids must be a non-empty array');
  const swId = subWarehouseId ? validatePositiveInt(subWarehouseId, 'sub_warehouse_id') : null;

  if (swId) {
    const swRes = await query(`SELECT warehouse_id FROM wms.sub_warehouses WHERE id=$1 AND tenant_id=$2`, [swId, tenantId]);
    if (swRes.rowCount === 0) throw new NotFoundError('Под-склад', swId);
    const mismatch = await query(
      `SELECT COUNT(*)::int AS n FROM wms.locations WHERE tenant_id=$1 AND id = ANY($2::int[]) AND warehouse_id <> $3`,
      [tenantId, list, swRes.rows[0].warehouse_id]
    );
    if (mismatch.rows[0].n > 0) {
      throw new ValidationError('Среди выбранных ячеек есть ячейки с другого физического склада — под-склад относится только к одному складу.');
    }
  }

  const r = await query(
    `UPDATE wms.locations SET sub_warehouse_id=$1, updated_at=NOW() WHERE tenant_id=$2 AND id = ANY($3::int[]) RETURNING id, location_code`,
    [swId, tenantId, list]
  );
  return { updated: r.rowCount, locations: r.rows };
}

/** Массово включить/выключить ячейки из подбора (is_pick_location) — задача
 *  21.09.2026: клиент хочет разом вывести из подбора пачку ячеек, где физически
 *  лежит товар, чтобы с них ничего не улетало в новые волны сборки, не
 *  щёлкая по каждой ячейке отдельно. is_pick_location=FALSE — того же флага
 *  достаточно, чтобы ячейка перестала участвовать и в findBestPickLocation
 *  (сборка), и в остатке, отдаваемом в WB (wb.service.js) — см. комментарий у
 *  getOrCreateQuarantineLocation в picking.service.js. В отличие от
 *  карантина, физический остаток НЕ переносится никуда — ячейка просто
 *  перестаёт быть источником для подбора, товар в ней остаётся как есть
 *  (клиент планирует потом его либо распределить по другим ячейкам, либо
 *  списать сам). is_active не трогаем — ячейка остаётся видна в отчётах/
 *  остатках, просто исключается из подбора под сборку. */
async function bulkSetPickFlag({ tenantId, ids, isPickLocation }) {
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!list.length) throw new ValidationError('ids must be a non-empty array');

  const r = await query(
    `UPDATE wms.locations SET is_pick_location=$1, updated_at=NOW()
     WHERE tenant_id=$2 AND id = ANY($3::int[])
     RETURNING id, location_code`,
    [parseBool(isPickLocation, true), tenantId, list]
  );
  return { updated: r.rowCount, locations: r.rows };
}

module.exports = {
  listLocations, getLocationById, getLocationByCode,
  createLocation, updateLocation, deleteLocation, findBestPickLocation,
  bulkCreateLocations, getLocationsByIds,
  bulkUpdateDimensions, getLocationFillReport, bulkSetPickFlag,
  listSubWarehouses, createSubWarehouse, updateSubWarehouse, bulkAssignSubWarehouse,
};
