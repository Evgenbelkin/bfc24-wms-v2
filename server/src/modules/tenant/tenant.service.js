'use strict';

const { query } = require('../../config/database');
const { NotFoundError, ValidationError } = require('../../utils/errors');

// =============================================================================
// Tenant Profile Service — самостоятельное редактирование tenant_admin'ом
// юр. реквизитов СВОЕЙ ЖЕ компании (нужны как "Исполнитель" в Акте приёмки).
//
// НЕ путать с platform.router.js (PATCH /tenants/:id) — тот доступен только
// platform_owner по отдельному JWT и структурно недостижим для tenant_admin.
// Здесь — обычный authRequired/tenantMiddleware, доступ строго к своей
// строке через req.user.tenantId.
// =============================================================================

async function getMyTenantProfile({ tenantId }) {
  const res = await query(
    `SELECT id, tenant_code, company_name, legal_name, inn, ogrnip, legal_address
     FROM platform.tenants WHERE id = $1`,
    [tenantId]
  );
  if (res.rowCount === 0) throw new NotFoundError('Tenant', tenantId);
  return res.rows[0];
}

async function updateMyTenantProfile({ tenantId, data }) {
  const fields = [];
  const params = [];
  let idx = 1;

  const strField = (key, dbCol, maxLen = 500) => {
    if (data[key] !== undefined) {
      fields.push(`${dbCol} = $${idx++}`);
      params.push(data[key] ? String(data[key]).trim().slice(0, maxLen) : null);
    }
  };

  strField('legal_name', 'legal_name', 300);
  strField('inn', 'inn', 20);
  strField('ogrnip', 'ogrnip', 20);
  strField('legal_address', 'legal_address', 500);

  if (fields.length === 0) throw new ValidationError('No fields to update');

  fields.push(`updated_at = NOW()`);
  params.push(tenantId);

  const res = await query(
    `UPDATE platform.tenants SET ${fields.join(', ')}
     WHERE id = $${idx}
     RETURNING id, tenant_code, company_name, legal_name, inn, ogrnip, legal_address`,
    params
  );
  if (res.rowCount === 0) throw new NotFoundError('Tenant', tenantId);
  return res.rows[0];
}

module.exports = { getMyTenantProfile, updateMyTenantProfile };
