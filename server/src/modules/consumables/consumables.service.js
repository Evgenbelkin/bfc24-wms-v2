'use strict';

const { query, transaction } = require('../../config/database');
const billing = require('../billing/billing.service');
const { NotFoundError, ValidationError, ConflictError } = require('../../utils/errors');

// =============================================================================
// Consumables Service
//
// Учёт расходных материалов (пакеты, короба, скотч и т.п.) плюс списание,
// опционально с автоматическим начислением клиенту.
//
// У каждого расходника два ценника: cost_price (себестоимость закупки — для
// внутреннего учёта) и client_unit_price (сколько списывать с клиента за
// единицу; NULL — клиенту не выставляем, только считаем остаток на складе).
//
// recordUsage — единственная точка списания: уменьшает qty_on_hand и, если
// задан client_unit_price и передан client_id, создаёт начисление через уже
// существующий billing.addCharge (service_type='materials'). Ошибка биллинга
// не должна ломать факт физического списания расходника — тот же принцип
// silent-fail, что и в billing.chargeForOperation.
// =============================================================================

async function listConsumables({ tenantId, activeOnly = true }) {
  const conds = ['tenant_id=$1'];
  if (activeOnly) conds.push('is_active=TRUE');
  const r = await query(
    `SELECT id, name, unit, qty_on_hand, low_stock_threshold,
            cost_price, client_unit_price, currency, is_active, updated_at
     FROM wms.consumables
     WHERE ${conds.join(' AND ')}
     ORDER BY name`,
    [tenantId]
  );
  return r.rows;
}

async function upsertConsumable({
  tenantId, id, name, unit, lowStockThreshold, costPrice, clientUnitPrice, currency,
}) {
  if (!name || !String(name).trim()) throw new ValidationError('name is required');

  if (id) {
    const r = await query(
      `UPDATE wms.consumables
       SET name=$1, unit=$2, low_stock_threshold=$3, cost_price=$4,
           client_unit_price=$5, currency=$6, updated_at=NOW()
       WHERE id=$7 AND tenant_id=$8
       RETURNING *`,
      [String(name).trim(), unit || 'шт', lowStockThreshold ?? null,
       costPrice ?? null, clientUnitPrice ?? null, currency || 'RUB', id, tenantId]
    );
    if (r.rowCount === 0) throw new NotFoundError('Consumable', id);
    return r.rows[0];
  }

  try {
    const r = await query(
      `INSERT INTO wms.consumables
         (tenant_id, name, unit, low_stock_threshold, cost_price, client_unit_price, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [tenantId, String(name).trim(), unit || 'шт', lowStockThreshold ?? null,
       costPrice ?? null, clientUnitPrice ?? null, currency || 'RUB']
    );
    return r.rows[0];
  } catch (e) {
    if (e.code === '23505') throw new ConflictError(`Consumable "${name}" already exists`);
    throw e;
  }
}

async function deactivateConsumable({ tenantId, id }) {
  const r = await query(
    `UPDATE wms.consumables SET is_active=FALSE, updated_at=NOW() WHERE id=$1 AND tenant_id=$2 RETURNING id`,
    [id, tenantId]
  );
  if (r.rowCount === 0) throw new NotFoundError('Consumable', id);
  return r.rows[0];
}

/** Ручная корректировка остатка (приход/инвентаризация), без начисления клиенту */
async function adjustStock({ tenantId, consumableId, delta, userId, comment }) {
  return transaction(async (client) => {
    const cRes = await client.query(
      `SELECT id, qty_on_hand FROM wms.consumables WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
      [consumableId, tenantId]
    );
    if (cRes.rowCount === 0) throw new NotFoundError('Consumable', consumableId);

    const newQty = Number(cRes.rows[0].qty_on_hand) + Number(delta);
    await client.query(
      `UPDATE wms.consumables SET qty_on_hand=$1, updated_at=NOW() WHERE id=$2`,
      [newQty, consumableId]
    );
    await client.query(
      `INSERT INTO wms.consumable_usage
         (tenant_id, consumable_id, qty, ref_type, user_id, comment)
       VALUES ($1,$2,$3,'adjustment',$4,$5)`,
      [tenantId, consumableId, -Number(delta), userId || null, comment || null]
    );
    return { consumableId, qty_on_hand: newQty };
  });
}

/**
 * Списание расходника на операцию (упаковка/отгрузка и т.п.).
 * Если у расходника задана client_unit_price и передан clientId — начисляем клиенту.
 */
async function recordUsage({ tenantId, consumableId, clientId, warehouseId, qty, refType, refId, userId, comment }) {
  const q = Number(qty);
  if (!q || q <= 0) throw new ValidationError('qty must be a positive number');

  return transaction(async (client) => {
    const cRes = await client.query(
      `SELECT id, name, qty_on_hand, client_unit_price, currency
       FROM wms.consumables WHERE id=$1 AND tenant_id=$2 AND is_active=TRUE FOR UPDATE`,
      [consumableId, tenantId]
    );
    if (cRes.rowCount === 0) throw new NotFoundError('Consumable', consumableId);
    const c = cRes.rows[0];

    const newQty = Number(c.qty_on_hand) - q;
    await client.query(
      `UPDATE wms.consumables SET qty_on_hand=$1, updated_at=NOW() WHERE id=$2`,
      [newQty, consumableId]
    );

    const usageRes = await client.query(
      `INSERT INTO wms.consumable_usage
         (tenant_id, consumable_id, client_id, warehouse_id, qty, ref_type, ref_id, user_id, comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [tenantId, consumableId, clientId || null, warehouseId || null, q, refType || 'manual', refId || null, userId || null, comment || null]
    );
    const usageId = usageRes.rows[0].id;

    // Начисление клиенту — не в этой же транзакции (billing использует свой
    // собственный connection через query()), но это не проблема: списание
    // расходника — источник истины сам по себе, а начисление — производный
    // факт. Как и chargeForOperation, никогда не бросает исключение.
    let chargeId = null;
    if (clientId && c.client_unit_price != null) {
      chargeId = await billing.addCharge({
        tenantId, clientId,
        serviceType: 'materials',
        description: c.name,
        quantity: q,
        unitPrice: Number(c.client_unit_price),
        currency: c.currency || 'RUB',
        refType: 'consumable_usage', refId: usageId,
      }).then(row => row.id).catch(() => null);

      if (chargeId) {
        await client.query(`UPDATE wms.consumable_usage SET charge_id=$1 WHERE id=$2`, [chargeId, usageId]);
      }
    }

    return { usageId, consumableId, name: c.name, qty: q, qty_on_hand: newQty, chargeId };
  });
}

async function listUsageHistory({ tenantId, clientId = null, consumableId = null, dateFrom = null, dateTo = null, limit = 200, offset = 0 }) {
  const params = [tenantId];
  const conds = ['u.tenant_id=$1'];
  let idx = 2;
  if (clientId)     { conds.push(`u.client_id=$${idx++}`);     params.push(clientId); }
  if (consumableId) { conds.push(`u.consumable_id=$${idx++}`); params.push(consumableId); }
  if (dateFrom) { conds.push(`u.created_at>=$${idx++}::date`); params.push(dateFrom); }
  if (dateTo)   { conds.push(`u.created_at<($${idx++}::date+interval '1 day')`); params.push(dateTo); }

  params.push(Math.min(limit, 1000), Math.max(offset, 0));
  const r = await query(
    `SELECT u.id, u.qty, u.ref_type, u.ref_id, u.charge_id, u.comment, u.created_at,
            c.name AS consumable_name, c.unit,
            cl.client_name, usr.full_name AS user_name
     FROM wms.consumable_usage u
     JOIN wms.consumables c ON c.id=u.consumable_id
     LEFT JOIN wms.clients cl ON cl.id=u.client_id
     LEFT JOIN wms.users usr ON usr.id=u.user_id
     WHERE ${conds.join(' AND ')}
     ORDER BY u.created_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params
  );
  return r.rows;
}

module.exports = {
  listConsumables,
  upsertConsumable,
  deactivateConsumable,
  adjustStock,
  recordUsage,
  listUsageHistory,
};
