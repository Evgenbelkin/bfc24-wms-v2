'use strict';

const { query, transaction } = require('../../config/database');
const { NotFoundError, ValidationError, ConflictError } = require('../../utils/errors');
const { validatePositiveInt } = require('../../utils/validators');

// =============================================================================
// Billing Service
//
// Биллинг фулфилмент-оператора: прайс-листы, начисления, инвойсы.
//
// Флоу:
//   1. Настраивается прайс-лист (price_list) для каждого клиента × тип услуги
//   2. Начисления (service_charges) записываются при операциях (приёмка, сборка, отгрузка)
//      или вручную через этот сервис
//   3. Инвойс создаётся за период → агрегирует начисления → выставляется клиенту
//
// API:
//   --- Price List ---
//   listPriceList      — прайс-лист клиента
//   upsertPrice        — создать/обновить позицию прайс-листа
//   deletePrice        — удалить позицию
//
//   --- Charges ---
//   listCharges        — начисления за период
//   addCharge          — ручное начисление
//   chargeForOperation — начисление по операции (вызывается из других модулей)
//
//   --- Invoices ---
//   listInvoices       — список инвойсов
//   getInvoice         — детальный инвойс
//   createInvoice      — создать инвойс за период
//   updateInvoiceStatus — обновить статус инвойса (sent/paid/cancelled)
//
//   --- Summary ---
//   getClientBalance   — баланс клиента (сумма неоплаченных начислений)
// =============================================================================

// ─────────────── Price List ───────────────

async function listPriceList({ tenantId, clientId = null }) {
  const params = [tenantId];
  const conds  = ['pl.tenant_id=$1', 'pl.is_active=TRUE'];
  let idx = 2;
  if (clientId) { conds.push(`pl.client_id=$${idx++}`); params.push(clientId); }

  const r = await query(
    `SELECT pl.id, pl.client_id, pl.service_type, pl.description,
            pl.unit_price, pl.min_charge, pl.currency,
            pl.storage_mode, pl.extra_unit_price,
            pl.valid_from, pl.valid_to, pl.is_active,
            c.client_name
     FROM billing.client_price_list pl
     JOIN wms.clients c ON c.id=pl.client_id
     WHERE ${conds.join(' AND ')}
     ORDER BY c.client_name, pl.service_type`,
    params
  );
  return r.rows;
}

async function upsertPrice({
  tenantId, clientId, serviceType, description,
  unitPrice, minCharge, currency, validFrom, validTo,
  storageMode, extraUnitPrice,
}) {
  const VALID_TYPES = ['receiving','storage','placement','picking','packing','shipping','processing','returns','subscription'];
  if (!VALID_TYPES.includes(serviceType)) {
    throw new ValidationError(`Invalid service_type. Allowed: ${VALID_TYPES.join(', ')}`);
  }
  if (unitPrice === undefined || unitPrice === null) throw new ValidationError('unit_price is required');

  // storage_mode/extra_unit_price имеют смысл только для service_type='storage' —
  // для остальных типов услуг всегда пишем режим по умолчанию 'slots' и NULL,
  // чтобы в прайсе на других услугах не осталось "мусорных" значений от
  // предыдущей позиции хранения.
  const mode = serviceType === 'storage' && storageMode === 'volume' ? 'volume' : 'slots';
  if (mode === 'volume' && (extraUnitPrice === undefined || extraUnitPrice === null)) {
    throw new ValidationError('extra_unit_price is required when storage_mode=volume');
  }

  const from = validFrom || new Date().toISOString().slice(0, 10);

  const r = await query(
    `INSERT INTO billing.client_price_list
       (tenant_id,client_id,service_type,description,unit_price,min_charge,currency,valid_from,valid_to,is_active,storage_mode,extra_unit_price)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,$10,$11)
     ON CONFLICT (tenant_id,client_id,service_type,valid_from)
     DO UPDATE SET
       description = EXCLUDED.description,
       unit_price  = EXCLUDED.unit_price,
       min_charge  = EXCLUDED.min_charge,
       currency    = EXCLUDED.currency,
       valid_to    = EXCLUDED.valid_to,
       is_active   = TRUE,
       storage_mode     = EXCLUDED.storage_mode,
       extra_unit_price = EXCLUDED.extra_unit_price,
       updated_at  = NOW()
     RETURNING *`,
    [tenantId, clientId, serviceType, description || null,
     Number(unitPrice), minCharge != null ? Number(minCharge) : null,
     currency || 'RUB', from, validTo || null,
     mode, mode === 'volume' ? Number(extraUnitPrice) : null]
  );
  return r.rows[0];
}

async function deletePrice({ tenantId, priceId }) {
  const r = await query(
    `UPDATE billing.client_price_list SET is_active=FALSE, updated_at=NOW()
     WHERE id=$1 AND tenant_id=$2 RETURNING id, service_type`,
    [priceId, tenantId]
  );
  if (r.rowCount === 0) throw new NotFoundError('PriceList entry', priceId);
  return r.rows[0];
}

// ─────────────── Charges ───────────────

async function listCharges({
  tenantId,
  clientId     = null,
  serviceType  = null,
  isInvoiced   = null,
  dateFrom     = null,
  dateTo       = null,
  limit  = 500,
  offset = 0,
}) {
  const params = [tenantId];
  const conds  = ['sc.tenant_id=$1'];
  let idx = 2;

  if (clientId)    { conds.push(`sc.client_id=$${idx++}`);    params.push(clientId); }
  if (serviceType) { conds.push(`sc.service_type=$${idx++}`); params.push(serviceType); }
  if (isInvoiced !== null) { conds.push(`sc.is_invoiced=$${idx++}`); params.push(isInvoiced); }
  if (dateFrom) { conds.push(`sc.period_date>=$${idx++}::date`); params.push(dateFrom); }
  if (dateTo)   { conds.push(`sc.period_date<=$${idx++}::date`); params.push(dateTo); }

  const total = (await query(
    `SELECT COUNT(*)::int AS n FROM billing.service_charges sc WHERE ${conds.join(' AND ')}`,
    params
  )).rows[0].n;

  params.push(Math.min(limit, 5000), Math.max(offset, 0));
  const r = await query(
    `SELECT sc.id, sc.service_type, sc.description,
            sc.quantity, sc.unit_price, sc.total_amount, sc.currency,
            sc.period_date, sc.is_invoiced, sc.invoice_id,
            sc.ref_type, sc.ref_id, sc.created_at,
            c.client_name
     FROM billing.service_charges sc
     JOIN wms.clients c ON c.id=sc.client_id
     WHERE ${conds.join(' AND ')}
     ORDER BY sc.period_date DESC, sc.id DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params
  );
  return { charges: r.rows, total, limit, offset };
}

async function addCharge({
  tenantId, clientId, serviceType, description,
  quantity, unitPrice, currency,
  periodDate, refType, refId,
}) {
  const qty   = Number(quantity)  || 1;
  const price = Number(unitPrice) || 0;
  const total = qty * price;
  const date  = periodDate || new Date().toISOString().slice(0, 10);

  const r = await query(
    `INSERT INTO billing.service_charges
       (tenant_id,client_id,service_type,description,ref_type,ref_id,
        quantity,unit_price,total_amount,currency,period_date)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [tenantId, clientId, serviceType, description || null,
     refType || null, refId ? Number(refId) : null,
     qty, price, total, currency || 'RUB', date]
  );
  return r.rows[0];
}

/**
 * Начислить по прайс-листу — вызывается из receiving/picking/shipping
 * Если нет прайс-листа — ничего не делает (silent)
 */
async function chargeForOperation({ tenantId, clientId, serviceType, quantity, refType, refId, periodDate }) {
  try {
    // Ищем актуальный прайс
    const priceRes = await query(
      `SELECT unit_price, min_charge, currency, description
       FROM billing.client_price_list
       WHERE tenant_id=$1 AND client_id=$2 AND service_type=$3
         AND is_active=TRUE
         AND valid_from <= CURRENT_DATE
         AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)
       ORDER BY valid_from DESC LIMIT 1`,
      [tenantId, clientId, serviceType]
    );
    if (priceRes.rowCount === 0) return null; // нет прайса — не начисляем

    const p    = priceRes.rows[0];
    const qty  = Number(quantity) || 1;
    let total  = qty * Number(p.unit_price);
    if (p.min_charge && total < Number(p.min_charge)) total = Number(p.min_charge);

    const r = await query(
      `INSERT INTO billing.service_charges
         (tenant_id,client_id,service_type,description,ref_type,ref_id,
          quantity,unit_price,total_amount,currency,period_date)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [tenantId, clientId, serviceType, p.description,
       refType || null, refId ? Number(refId) : null,
       qty, Number(p.unit_price), total, p.currency || 'RUB',
       periodDate || new Date().toISOString().slice(0, 10)]
    );
    return r.rows[0].id;
  } catch (_) {
    // Биллинг никогда не должен ломать основной поток
    return null;
  }
}

// ─────────────── Invoices ───────────────

async function listInvoices({ tenantId, clientId = null, status = null, limit = 100, offset = 0 }) {
  const params = [tenantId];
  const conds  = ['inv.tenant_id=$1'];
  let idx = 2;

  if (clientId) { conds.push(`inv.client_id=$${idx++}`); params.push(clientId); }
  if (status)   { conds.push(`inv.status=$${idx++}`);    params.push(status); }

  const total = (await query(
    `SELECT COUNT(*)::int AS n FROM billing.invoices inv WHERE ${conds.join(' AND ')}`,
    params
  )).rows[0].n;

  params.push(Math.min(limit, 500), Math.max(offset, 0));
  const r = await query(
    `SELECT inv.id, inv.invoice_number, inv.period_from, inv.period_to,
            inv.total_amount, inv.currency, inv.status, inv.notes,
            inv.created_at, inv.updated_at,
            c.client_name,
            (SELECT COUNT(*)::int FROM billing.service_charges sc WHERE sc.invoice_id=inv.id) AS charges_count
     FROM billing.invoices inv
     JOIN wms.clients c ON c.id=inv.client_id
     WHERE ${conds.join(' AND ')}
     ORDER BY inv.created_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params
  );
  return { invoices: r.rows, total, limit, offset };
}

async function getInvoice({ tenantId, invoiceId }) {
  const invRes = await query(
    `SELECT inv.*, c.client_name
     FROM billing.invoices inv
     JOIN wms.clients c ON c.id=inv.client_id
     WHERE inv.id=$1 AND inv.tenant_id=$2`,
    [invoiceId, tenantId]
  );
  if (invRes.rowCount === 0) throw new NotFoundError('Invoice', invoiceId);
  const invoice = invRes.rows[0];

  const chargesRes = await query(
    `SELECT sc.id, sc.service_type, sc.description, sc.quantity,
            sc.unit_price, sc.total_amount, sc.currency, sc.period_date,
            sc.ref_type, sc.ref_id
     FROM billing.service_charges sc
     WHERE sc.invoice_id=$1
     ORDER BY sc.period_date, sc.service_type`,
    [invoiceId]
  );

  return { invoice, charges: chargesRes.rows };
}

async function createInvoice({
  tenantId, clientId, periodFrom, periodTo, notes, currency,
}) {
  if (!periodFrom || !periodTo) throw new ValidationError('period_from and period_to are required');
  if (periodFrom > periodTo) throw new ValidationError('period_from must be <= period_to');

  return transaction(async (client) => {
    // Все неоплаченные начисления за период
    const chargesRes = await client.query(
      `SELECT id, total_amount FROM billing.service_charges
       WHERE tenant_id=$1 AND client_id=$2
         AND is_invoiced=FALSE
         AND period_date>=$3::date AND period_date<=$4::date
       FOR UPDATE`,
      [tenantId, clientId, periodFrom, periodTo]
    );
    if (chargesRes.rowCount === 0) {
      throw new ValidationError('No uninvoiced charges found for this period');
    }

    const totalAmount = chargesRes.rows.reduce((s, r) => s + Number(r.total_amount), 0);
    const chargeIds   = chargesRes.rows.map(r => r.id);

    // Генерируем номер инвойса
    const numRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM billing.invoices WHERE tenant_id=$1`,
      [tenantId]
    );
    const invoiceNumber = `INV-${tenantId}-${String(numRes.rows[0].n + 1).padStart(5, '0')}`;

    // Создаём инвойс
    const invRes = await client.query(
      `INSERT INTO billing.invoices
         (tenant_id,client_id,invoice_number,period_from,period_to,
          total_amount,currency,status,notes)
       VALUES($1,$2,$3,$4,$5,$6,$7,'draft',$8)
       RETURNING *`,
      [tenantId, clientId, invoiceNumber, periodFrom, periodTo,
       totalAmount.toFixed(2), currency || 'RUB', notes || null]
    );
    const invoice = invRes.rows[0];

    // Привязываем начисления к инвойсу
    await client.query(
      `UPDATE billing.service_charges
       SET invoice_id=$1, is_invoiced=TRUE
       WHERE id=ANY($2::bigint[])`,
      [invoice.id, chargeIds]
    );

    return { invoice, charges_count: chargeIds.length, total_amount: totalAmount };
  });
}

async function updateInvoiceStatus({ tenantId, invoiceId, status, notes }) {
  const VALID_STATUSES = ['draft','sent','paid','cancelled'];
  if (!VALID_STATUSES.includes(status)) {
    throw new ValidationError(`Invalid status. Allowed: ${VALID_STATUSES.join(', ')}`);
  }

  const inv = await query(
    `SELECT id, status FROM billing.invoices WHERE id=$1 AND tenant_id=$2`,
    [invoiceId, tenantId]
  );
  if (inv.rowCount === 0) throw new NotFoundError('Invoice', invoiceId);

  const current = inv.rows[0].status;
  // Нельзя отменить оплаченный инвойс
  if (current === 'paid' && status !== 'paid') {
    throw new ValidationError('Cannot change status of a paid invoice');
  }

  const r = await query(
    `UPDATE billing.invoices
     SET status=$1, notes=COALESCE($2,notes), updated_at=NOW()
     WHERE id=$3 AND tenant_id=$4
     RETURNING id, invoice_number, status, updated_at`,
    [status, notes || null, invoiceId, tenantId]
  );
  return r.rows[0];
}

// ─────────────── Storage (ежедневное начисление за хранение) ───────────────

/**
 * Клиенты с активным прайсом на 'storage' у тенантов с включённым модулем billing —
 * используется фоновой джобой (jobs/storageBilling.js), которая обходит их раз в сутки.
 */
async function listClientsWithActiveStoragePrice() {
  const r = await query(
    `SELECT DISTINCT pl.tenant_id, pl.client_id
     FROM billing.client_price_list pl
     JOIN platform.tenant_modules tm ON tm.tenant_id = pl.tenant_id AND tm.module_code = 'billing'
     WHERE pl.service_type = 'storage' AND pl.is_active = TRUE
       AND pl.valid_from <= CURRENT_DATE
       AND (pl.valid_to IS NULL OR pl.valid_to >= CURRENT_DATE)`
  );
  return r.rows;
}

/**
 * Начислить клиенту за хранение сегодняшним днём. Идемпотентно — если
 * начисление за 'storage' на сегодня уже есть, повторно не создаёт (защита от
 * повторного/задвоенного запуска джобы в один день).
 *
 * Два режима, задаются в прайс-листе клиента (storage_mode):
 *  - 'slots'  (по умолчанию) — unit_price × число занятых ячеек с остатком.
 *  - 'volume' — как у самого Wildberries: unit_price за первый литр товара +
 *    extra_unit_price за каждый следующий литр (округление литража ВВЕРХ
 *    после вычитания первого литра), умноженное на количество единиц этого
 *    товара на остатке, просуммированное по всем товарам клиента. Если у
 *    товара не указан объём (volume_liters IS NULL) — считаем как 1 литр
 *    (только базовая ставка), чтобы не потерять начисление из-за незаполненной
 *    карточки, но и не придумывать объём из воздуха.
 */
async function chargeStorageForClientToday({ tenantId, clientId }) {
  const today = new Date().toISOString().slice(0, 10);

  const existing = await query(
    `SELECT 1 FROM billing.service_charges
     WHERE tenant_id=$1 AND client_id=$2 AND service_type='storage' AND period_date=$3::date LIMIT 1`,
    [tenantId, clientId, today]
  );
  if (existing.rowCount > 0) return null; // уже начислено сегодня

  const priceRes = await query(
    `SELECT unit_price, currency, storage_mode, extra_unit_price
     FROM billing.client_price_list
     WHERE tenant_id=$1 AND client_id=$2 AND service_type='storage' AND is_active=TRUE
       AND valid_from <= CURRENT_DATE AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)
     ORDER BY valid_from DESC LIMIT 1`,
    [tenantId, clientId]
  );
  if (priceRes.rowCount === 0) return null; // нет активного прайса на хранение
  const price = priceRes.rows[0];

  if (price.storage_mode === 'volume') {
    const rowsRes = await query(
      `SELECT i.volume_liters, SUM(sb.qty_on_hand)::numeric AS qty
       FROM wms.stock_balances sb
       JOIN wms.items i ON i.id = sb.item_id
       WHERE sb.tenant_id=$1 AND sb.client_id=$2 AND sb.qty_on_hand > 0
       GROUP BY i.id, i.volume_liters`,
      [tenantId, clientId]
    );
    if (rowsRes.rowCount === 0) return null; // нечего хранить

    const baseRate  = Number(price.unit_price) || 0;
    const extraRate = Number(price.extra_unit_price) || 0;
    let totalCost = 0, totalUnits = 0;
    for (const row of rowsRes.rows) {
      const qty = Number(row.qty);
      const volume = row.volume_liters != null ? Number(row.volume_liters) : 1;
      const extraLiters = volume > 1 ? Math.ceil(volume - 1) : 0;
      totalCost  += (baseRate + extraRate * extraLiters) * qty;
      totalUnits += qty;
    }
    if (totalCost <= 0) return null;

    const r = await query(
      `INSERT INTO billing.service_charges
         (tenant_id, client_id, service_type, description, ref_type, ref_id,
          quantity, unit_price, total_amount, currency, period_date)
       VALUES ($1,$2,'storage','Хранение (по литражу)','storage_daily',NULL,$3,$4,$5,$6,$7)
       RETURNING *`,
      [tenantId, clientId, totalUnits,
       (totalUnits > 0 ? totalCost / totalUnits : 0).toFixed(4),
       totalCost.toFixed(2), price.currency || 'RUB', today]
    );
    return r.rows[0];
  }

  // Режим 'slots' — прежнее поведение: unit_price × число занятых ячеек
  const slotsRes = await query(
    `SELECT COUNT(DISTINCT location_id)::int AS slots
     FROM wms.stock_balances
     WHERE tenant_id=$1 AND client_id=$2 AND qty_on_hand > 0`,
    [tenantId, clientId]
  );
  const slots = slotsRes.rows[0].slots;
  if (slots === 0) return null; // нечего хранить — не начисляем

  return chargeForOperation({
    tenantId, clientId, serviceType: 'storage',
    quantity: slots, refType: 'storage_daily', refId: null, periodDate: today,
  });
}

// ─────────────── Summary ───────────────

async function getClientBalance({ tenantId, clientId }) {
  const r = await query(
    `SELECT
       SUM(sc.total_amount) FILTER(WHERE sc.is_invoiced=FALSE)::numeric AS uninvoiced_total,
       SUM(sc.total_amount) FILTER(WHERE inv.status='sent')::numeric    AS invoiced_unpaid,
       SUM(sc.total_amount) FILTER(WHERE inv.status='paid')::numeric    AS total_paid,
       COUNT(*) FILTER(WHERE sc.is_invoiced=FALSE)::int AS uninvoiced_count
     FROM billing.service_charges sc
     LEFT JOIN billing.invoices inv ON inv.id=sc.invoice_id
     WHERE sc.tenant_id=$1 AND sc.client_id=$2`,
    [tenantId, clientId]
  );
  return r.rows[0];
}

module.exports = {
  listPriceList,
  upsertPrice,
  deletePrice,
  listCharges,
  addCharge,
  chargeForOperation,
  listInvoices,
  getInvoice,
  createInvoice,
  updateInvoiceStatus,
  getClientBalance,
  listClientsWithActiveStoragePrice,
  chargeStorageForClientToday,
};
