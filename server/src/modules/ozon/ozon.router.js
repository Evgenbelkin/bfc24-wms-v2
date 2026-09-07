'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../../config/database');
const ozonService = require('./ozon.service');
const { authRequired } = require('../../middleware/auth');
const { tenantMiddleware, resolveClientScope, requireModule } = require('../../middleware/tenant');
const { requireRole } = require('../../middleware/requireRole');
const { NotFoundError } = require('../../utils/errors');

// Отдельный feature-flag модуль ('ozon_integration', см. миграцию 056) —
// не 'wb_integration' — чтобы включать Ozon по тенанту независимо от WB,
// тем же паттерном, что и сам wb_integration.
router.use(authRequired, tenantMiddleware, requireModule('ozon_integration'));

// ─────────────── MP Accounts (marketplace='ozon') ───────────────

router.get('/accounts', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const clientId = resolveClientScope(req, req.query.client_id);
    const params = [req.user.tenantId]; const conds = ["ma.tenant_id=$1", "ma.marketplace='ozon'"]; let idx=2;
    if (clientId) { conds.push(`ma.client_id=$${idx++}`); params.push(clientId); }
    const r = await query(
      `SELECT ma.id, ma.client_id, ma.account_code, ma.account_name,
         ma.supplier_id AS ozon_client_id, ma.is_active,
         (ma.api_token IS NOT NULL AND length(trim(ma.api_token))>0) AS has_key,
         c.client_name
       FROM wms.mp_accounts ma JOIN wms.clients c ON c.id=ma.client_id
       WHERE ${conds.join(' AND ')} ORDER BY c.client_name, ma.account_name`,
      params
    );
    res.json({ ok: true, accounts: r.rows });
  } catch(e){ next(e); }
});

router.post('/accounts', requireRole('tenant_admin'), async (req,res,next)=>{
  try {
    const { client_id, account_name, account_code, ozon_client_id, ozon_api_key } = req.body;
    const clientId = resolveClientScope(req, client_id);
    const r = await query(
      `INSERT INTO wms.mp_accounts(tenant_id,client_id,marketplace,account_name,account_code,supplier_id,api_token,created_by,settings)
       VALUES($1,$2,'ozon',$3,$4,$5,$6,$7,'{"stock_sync_disabled":true}'::jsonb)
       RETURNING id,client_id,marketplace,account_name,is_active`,
      [req.user.tenantId, clientId, account_name, account_code||null, ozon_client_id||null, ozon_api_key||null, req.user.id]
    );
    res.status(201).json({ ok: true, account: r.rows[0] });
  } catch(e){ next(e); }
});

// ─────────────── Синхронизация отправлений ───────────────

/** POST /ozon/sync — синхронизировать отправления по всем активным Ozon-аккаунтам тенанта */
router.post('/sync', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const results = await ozonService.syncAllAccountsForTenant(req.user.tenantId);
    res.json({ ok: true, results });
  } catch(e){ next(e); }
});

/** GET /ozon/postings — отладочный просмотр того, что засинкалось (пока без пагинации UI) */
router.get('/postings', requireRole('tenant_admin','supervisor'), async (req,res,next)=>{
  try {
    const accountId = req.query.account_id ? Number(req.query.account_id) : null;
    const params = [req.user.tenantId]; const conds = ['tenant_id=$1']; let idx=2;
    if (accountId) { conds.push(`mp_account_id=$${idx++}`); params.push(accountId); }
    const r = await query(
      `SELECT id, mp_account_id, posting_number, order_number, status, substatus,
         warehouse_name, tpl_provider, shipment_date, tracking_number, wms_shipment_code, fetched_at
       FROM wms.ozon_postings WHERE ${conds.join(' AND ')}
       ORDER BY fetched_at DESC LIMIT 200`,
      params
    );
    res.json({ ok: true, postings: r.rows });
  } catch(e){ next(e); }
});

module.exports = router;
