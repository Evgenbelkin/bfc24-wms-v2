'use strict';

const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { query, transaction } = require('../../config/database');
const { platformAuthRequired } = require('../../middleware/auth');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { validateNonEmptyString, validateEmail, parseBool, validatePositiveInt } = require('../../utils/validators');
const { invalidateTenantCache } = require('../../middleware/tenant');
const logger = require('../../utils/logger');

router.get('/health', (req, res) => res.json({ ok: true, layer: 'platform' }));

router.use(platformAuthRequired);

// ===== TENANTS =====
router.get('/tenants', async (req, res, next) => {
  try {
    const { status, search } = req.query;
    const params = []; const conds = []; let idx = 1;
    if (status) { conds.push(`t.status = $${idx++}`); params.push(status); }
    if (search) { conds.push(`(t.company_name ILIKE $${idx} OR t.tenant_code ILIKE $${idx})`); params.push(`%${search}%`); idx++; }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const r = await query(
      `SELECT t.id, t.tenant_code, t.company_name, t.contact_email, t.status, t.created_at,
         p.plan_name,
         (SELECT COUNT(*)::int FROM wms.users u WHERE u.tenant_id = t.id AND u.is_active=TRUE) AS user_count
       FROM platform.tenants t LEFT JOIN platform.plans p ON p.id = t.plan_id ${where} ORDER BY t.created_at DESC`,
      params
    );
    res.json({ ok: true, tenants: r.rows });
  } catch (e) { next(e); }
});

router.get('/tenants/:id', async (req, res, next) => {
  try {
    const id = validatePositiveInt(req.params.id, 'id');
    const r = await query(
      `SELECT t.*, p.plan_name, p.plan_code,
         array_agg(tm.module_code) FILTER (WHERE tm.module_code IS NOT NULL) AS modules
       FROM platform.tenants t
       LEFT JOIN platform.plans p ON p.id = t.plan_id
       LEFT JOIN platform.tenant_modules tm ON tm.tenant_id = t.id
       WHERE t.id = $1 GROUP BY t.id, p.plan_name, p.plan_code`,
      [id]
    );
    if (r.rowCount === 0) throw new NotFoundError('Tenant', id);
    res.json({ ok: true, tenant: r.rows[0] });
  } catch (e) { next(e); }
});

router.post('/tenants', async (req, res, next) => {
  try {
    const { tenant_code, company_name, contact_email, contact_phone, timezone, plan_id, admin_username, admin_password, modules = [] } = req.body;
    const code  = validateNonEmptyString(tenant_code, 'tenant_code', 50).toLowerCase();
    const name  = validateNonEmptyString(company_name, 'company_name', 200);
    const email = validateEmail(contact_email);
    const adminUser = validateNonEmptyString(admin_username, 'admin_username', 100);
    if (!admin_password || admin_password.length < 8) throw new ValidationError('admin_password must be >= 8 chars');
    const exists = await query(`SELECT id FROM platform.tenants WHERE tenant_code=$1`, [code]);
    if (exists.rowCount > 0) throw new ConflictError(`Tenant code '${code}' already exists`);

    const result = await transaction(async (client) => {
      const tRes = await client.query(
        `INSERT INTO platform.tenants (tenant_code,company_name,contact_email,contact_phone,timezone,status,plan_id,trial_ends_at,created_by)
         VALUES ($1,$2,$3,$4,$5,'trial',$6,NOW()+INTERVAL '14 days',$7) RETURNING id,tenant_code,company_name,status,created_at`,
        [code, name, email, contact_phone||null, timezone||'Europe/Moscow', plan_id?Number(plan_id):null, req.platformUser.id]
      );
      const tenant = tRes.rows[0];
      const coreMods = await client.query(`SELECT module_code FROM platform.modules WHERE is_core=TRUE`);
      for (const mc of new Set([...coreMods.rows.map(r=>r.module_code), ...modules])) {
        await client.query(`INSERT INTO platform.tenant_modules(tenant_id,module_code,enabled_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [tenant.id,mc,req.platformUser.id]);
      }
      const pwHash = await bcrypt.hash(admin_password, 12);
      await client.query(`INSERT INTO wms.users(tenant_id,username,password_hash,role,is_active) VALUES($1,$2,$3,'tenant_admin',TRUE)`, [tenant.id,adminUser,pwHash]);
      await client.query(`INSERT INTO wms.warehouses(tenant_id,warehouse_code,warehouse_name,is_default,is_active) VALUES($1,'MAIN','Основной склад',TRUE,TRUE)`, [tenant.id]);
      return tenant;
    });
    logger.info({ tenantId: result.id, code }, 'Tenant created');
    res.status(201).json({ ok: true, tenant: result });
  } catch (e) { next(e); }
});

router.patch('/tenants/:id', async (req, res, next) => {
  try {
    const id = validatePositiveInt(req.params.id, 'id');
    const { status, company_name, contact_email, plan_id, notes } = req.body;
    const fields = []; const params = []; let idx = 1;
    if (company_name) { fields.push(`company_name=$${idx++}`); params.push(company_name); }
    if (contact_email) { fields.push(`contact_email=$${idx++}`); params.push(validateEmail(contact_email)); }
    if (status) {
      if (!['trial','active','suspended','blocked','archived'].includes(status)) throw new ValidationError('Invalid status');
      fields.push(`status=$${idx++}`); params.push(status);
    }
    if (plan_id !== undefined) { fields.push(`plan_id=$${idx++}`); params.push(Number(plan_id)); }
    if (notes !== undefined) { fields.push(`notes=$${idx++}`); params.push(notes); }
    if (!fields.length) throw new ValidationError('No fields to update');
    fields.push(`updated_at=NOW()`); params.push(id);
    const r = await query(`UPDATE platform.tenants SET ${fields.join(',')} WHERE id=$${idx} RETURNING *`, params);
    if (r.rowCount === 0) throw new NotFoundError('Tenant', id);
    invalidateTenantCache(id);
    res.json({ ok: true, tenant: r.rows[0] });
  } catch (e) { next(e); }
});

router.post('/tenants/:id/modules', async (req, res, next) => {
  try {
    const tenantId = validatePositiveInt(req.params.id, 'id');
    const { module_code, enabled } = req.body;
    if (!module_code) throw new ValidationError('module_code required');
    if (parseBool(enabled, true)) {
      await query(`INSERT INTO platform.tenant_modules(tenant_id,module_code,enabled_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [tenantId,module_code,req.platformUser.id]);
    } else {
      const c = await query(`SELECT is_core FROM platform.modules WHERE module_code=$1`, [module_code]);
      if (c.rowCount > 0 && c.rows[0].is_core) throw new ValidationError('Cannot disable core module');
      await query(`DELETE FROM platform.tenant_modules WHERE tenant_id=$1 AND module_code=$2`, [tenantId, module_code]);
    }
    invalidateTenantCache(tenantId);
    res.json({ ok: true, tenantId, module_code, enabled: parseBool(enabled, true) });
  } catch (e) { next(e); }
});

router.get('/plans', async (req, res, next) => {
  try { res.json({ ok: true, plans: (await query(`SELECT * FROM platform.plans ORDER BY price_monthly`)).rows }); } catch (e) { next(e); }
});

router.get('/modules', async (req, res, next) => {
  try { res.json({ ok: true, modules: (await query(`SELECT * FROM platform.modules ORDER BY is_core DESC, module_code`)).rows }); } catch (e) { next(e); }
});

router.get('/stats', async (req, res, next) => {
  try {
    const s = await query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER(WHERE status='active')::int AS active, COUNT(*) FILTER(WHERE status='trial')::int AS trial FROM platform.tenants`);
    const u = await query(`SELECT COUNT(*)::int AS total FROM wms.users WHERE is_active=TRUE`);
    res.json({ ok: true, stats: { ...s.rows[0], active_users: u.rows[0].total } });
  } catch (e) { next(e); }
});

module.exports = router;
