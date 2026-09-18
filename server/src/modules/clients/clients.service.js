'use strict';

const { query, transaction } = require('../../config/database');
const { NotFoundError, ConflictError, ValidationError } = require('../../utils/errors');
const { validateNonEmptyString, parseBool } = require('../../utils/validators');

// =============================================================================
// Clients Service
// =============================================================================

async function listClients({ tenantId, isActive = null, search = null }) {
  const params = [tenantId];
  const conds = ['c.tenant_id = $1'];
  let idx = 2;

  if (isActive !== null) { conds.push(`c.is_active = $${idx++}`); params.push(isActive); }
  if (search) {
    conds.push(`(c.client_name ILIKE $${idx} OR c.client_code ILIKE $${idx})`);
    params.push(`%${search}%`); idx++;
  }

  const res = await query(
    `SELECT
       c.id, c.client_code, c.client_name, c.contact_name,
       c.contact_email, c.contact_phone, c.telegram_chat_id,
       c.is_active, c.created_at,
       COUNT(DISTINCT u.id) AS seller_count,
       COUNT(DISTINCT ma.id) AS mp_account_count
     FROM wms.clients c
     LEFT JOIN wms.users u ON u.client_id = c.id AND u.role = 'seller'
     LEFT JOIN wms.mp_accounts ma ON ma.client_id = c.id AND ma.is_active = TRUE
     WHERE ${conds.join(' AND ')}
     GROUP BY c.id
     ORDER BY c.client_name`,
    params
  );
  return res.rows;
}

async function getClientById({ tenantId, clientId }) {
  const res = await query(
    `SELECT
       c.id, c.client_code, c.client_name, c.contact_name,
       c.contact_email, c.contact_phone, c.telegram_chat_id,
       c.legal_name, c.inn, c.legal_address,
       c.is_active, c.settings, c.notes, c.created_at
     FROM wms.clients c
     WHERE c.id = $1 AND c.tenant_id = $2`,
    [clientId, tenantId]
  );
  if (res.rowCount === 0) throw new NotFoundError('Client', clientId);
  return res.rows[0];
}

async function createClient({ tenantId, createdById, data }) {
  const clientCode = validateNonEmptyString(data.client_code, 'client_code', 50);
  const clientName = validateNonEmptyString(data.client_name, 'client_name', 200);

  // Уникальность кода внутри tenant
  const exists = await query(
    `SELECT id FROM wms.clients WHERE tenant_id = $1 AND client_code = $2`,
    [tenantId, clientCode]
  );
  if (exists.rowCount > 0) throw new ConflictError(`Client code '${clientCode}' already exists`);

  const res = await query(
    `INSERT INTO wms.clients
       (tenant_id, client_code, client_name, contact_name, contact_email,
        contact_phone, telegram_chat_id, legal_name, inn, legal_address,
        is_active, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id, client_code, client_name, is_active, created_at`,
    [
      tenantId, clientCode, clientName,
      data.contact_name || null,
      data.contact_email || null,
      data.contact_phone || null,
      data.telegram_chat_id || null,
      data.legal_name ? String(data.legal_name).trim().slice(0, 300) : null,
      data.inn ? String(data.inn).trim().slice(0, 20) : null,
      data.legal_address ? String(data.legal_address).trim().slice(0, 500) : null,
      parseBool(data.is_active, true),
      data.notes || null,
      createdById,
    ]
  );
  return res.rows[0];
}

async function updateClient({ tenantId, clientId, data }) {
  await getClientById({ tenantId, clientId }); // проверяем существование

  const fields = [];
  const params = [];
  let idx = 1;

  const strField = (key, dbCol, maxLen = 200) => {
    if (data[key] !== undefined) {
      fields.push(`${dbCol} = $${idx++}`);
      params.push(data[key] ? String(data[key]).trim().slice(0, maxLen) : null);
    }
  };

  strField('client_name', 'client_name');
  strField('contact_name', 'contact_name');
  strField('contact_email', 'contact_email');
  strField('contact_phone', 'contact_phone');
  strField('telegram_chat_id', 'telegram_chat_id');
  strField('legal_name', 'legal_name', 300);
  strField('inn', 'inn', 20);
  strField('legal_address', 'legal_address', 500);
  strField('notes', 'notes', 2000);

  if (data.is_active !== undefined) {
    fields.push(`is_active = $${idx++}`);
    params.push(parseBool(data.is_active));
  }

  // Рубильник "не отправлять код Честного знака в WB на упаковке" (settings
  // JSONB, тот же приём, что и stock_sync_disabled у mp_accounts) — для
  // клиентов, которым нужно сначала передать право собственности на код в
  // Честном знаке на нужное ИП (например, через Тотал Марк) ПОСЛЕ упаковки,
  // а не отправлять его в WB сразу при скане (см. marking.consumeScannedCodeAtPacking).
  if (data.marking_wb_submit_disabled !== undefined) {
    fields.push(`settings = COALESCE(settings,'{}'::jsonb) || jsonb_build_object('marking_wb_submit_disabled', $${idx++}::boolean)`);
    params.push(parseBool(data.marking_wb_submit_disabled));
  }

  if (fields.length === 0) throw new ValidationError('No fields to update');

  fields.push(`updated_at = NOW()`);
  params.push(clientId, tenantId);

  const res = await query(
    `UPDATE wms.clients SET ${fields.join(', ')}
     WHERE id = $${idx++} AND tenant_id = $${idx}
     RETURNING id, client_code, client_name, is_active, settings, updated_at`,
    params
  );
  return res.rows[0];
}

/** Краткий список для select-boxes */
async function listClientsShort({ tenantId }) {
  const res = await query(
    `SELECT id, client_code, client_name
     FROM wms.clients
     WHERE tenant_id = $1 AND is_active = TRUE
     ORDER BY client_name`,
    [tenantId]
  );
  return res.rows;
}

module.exports = { listClients, getClientById, createClient, updateClient, listClientsShort };
