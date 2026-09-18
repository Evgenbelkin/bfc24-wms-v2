'use strict';

const { query } = require('../../config/database');
const { NotFoundError, ConflictError, ValidationError } = require('../../utils/errors');
const { validateNonEmptyString, parseBool } = require('../../utils/validators');

// =============================================================================
// Warehouses Service
// =============================================================================

async function listWarehouses({ tenantId }) {
  const res = await query(
    `SELECT
       w.id, w.warehouse_code, w.warehouse_name, w.address,
       w.timezone, w.is_active, w.is_default, w.settings,
       COUNT(l.id) AS location_count
     FROM wms.warehouses w
     LEFT JOIN wms.locations l ON l.warehouse_id = w.id AND l.is_active = TRUE
     WHERE w.tenant_id = $1
     GROUP BY w.id
     ORDER BY w.is_default DESC, w.warehouse_name`,
    [tenantId]
  );
  return res.rows;
}

async function getWarehouseById({ tenantId, warehouseId }) {
  const res = await query(
    `SELECT id, warehouse_code, warehouse_name, address, timezone, is_active, is_default, settings, created_at
     FROM wms.warehouses WHERE id = $1 AND tenant_id = $2`,
    [warehouseId, tenantId]
  );
  if (res.rowCount === 0) throw new NotFoundError('Warehouse', warehouseId);
  return res.rows[0];
}

async function createWarehouse({ tenantId, createdById, data }) {
  const code = validateNonEmptyString(data.warehouse_code, 'warehouse_code', 50);
  const name = validateNonEmptyString(data.warehouse_name, 'warehouse_name', 200);

  const exists = await query(
    `SELECT id FROM wms.warehouses WHERE tenant_id = $1 AND warehouse_code = $2`,
    [tenantId, code]
  );
  if (exists.rowCount > 0) throw new ConflictError(`Warehouse code '${code}' already exists`);

  const isDefault = parseBool(data.is_default, false);
  if (isDefault) {
    await query(
      `UPDATE wms.warehouses SET is_default = FALSE WHERE tenant_id = $1`,
      [tenantId]
    );
  }

  const res = await query(
    `INSERT INTO wms.warehouses (tenant_id, warehouse_code, warehouse_name, address, timezone, is_active, is_default, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, warehouse_code, warehouse_name, is_active, is_default, created_at`,
    [tenantId, code, name, data.address || null, data.timezone || 'Europe/Moscow', parseBool(data.is_active, true), isDefault, createdById]
  );
  return res.rows[0];
}

async function updateWarehouse({ tenantId, warehouseId, data }) {
  await getWarehouseById({ tenantId, warehouseId });

  const fields = [];
  const params = [];
  let idx = 1;

  if (data.warehouse_name !== undefined) { fields.push(`warehouse_name = $${idx++}`); params.push(String(data.warehouse_name).trim()); }
  if (data.address !== undefined) { fields.push(`address = $${idx++}`); params.push(data.address || null); }
  if (data.timezone !== undefined) { fields.push(`timezone = $${idx++}`); params.push(data.timezone); }
  if (data.is_active !== undefined) { fields.push(`is_active = $${idx++}`); params.push(parseBool(data.is_active)); }
  if (data.is_default !== undefined) {
    const def = parseBool(data.is_default);
    if (def) await query(`UPDATE wms.warehouses SET is_default = FALSE WHERE tenant_id = $1`, [tenantId]);
    fields.push(`is_default = $${idx++}`); params.push(def);
  }

  if (fields.length === 0) throw new ValidationError('No fields to update');
  fields.push(`updated_at = NOW()`);
  params.push(warehouseId, tenantId);

  const res = await query(
    `UPDATE wms.warehouses SET ${fields.join(', ')} WHERE id = $${idx++} AND tenant_id = $${idx} RETURNING *`,
    params
  );
  return res.rows[0];
}

/** Получить дефолтный склад tenant'а */
async function getDefaultWarehouse(tenantId) {
  const res = await query(
    `SELECT id, warehouse_code, warehouse_name FROM wms.warehouses
     WHERE tenant_id = $1 AND is_default = TRUE AND is_active = TRUE LIMIT 1`,
    [tenantId]
  );
  if (res.rowCount === 0) {
    // Если нет дефолтного — берём первый активный
    const fallback = await query(
      `SELECT id, warehouse_code, warehouse_name FROM wms.warehouses
       WHERE tenant_id = $1 AND is_active = TRUE ORDER BY id LIMIT 1`,
      [tenantId]
    );
    if (fallback.rowCount === 0) throw new NotFoundError('Warehouse (no active warehouses found)');
    return fallback.rows[0];
  }
  return res.rows[0];
}

module.exports = { listWarehouses, getWarehouseById, createWarehouse, updateWarehouse, getDefaultWarehouse };
