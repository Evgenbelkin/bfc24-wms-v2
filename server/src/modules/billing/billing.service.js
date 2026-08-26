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

  // storage_mode имеет смысл только для service_type='storage' — для остальных
  // типов услуг всегда пишем режим по умолчанию 'slots' (он там ни на что не
  // влияет). extra_unit_price же (прогрессивная цена: unit_price за первую
  // единицу объёма + extra_unit_price за каждую следующую) актуальна и для
  // 'storage' (в режиме volume), и для 'processing' (обработка по литражу
  // товара) — см. chargeForOperation в billing.service.js. Для остальных
  // типов услуг extra_unit_price всегда NULL, чтобы не осталось "мусорных"
  // значений от предыдущей позиции хранения.
  const isStorage = serviceType === 'storage';
  const mode = isStorage && storageMode === 'volume' ? 'volume' : 'slots';
  if (isStorage && mode === 'volume' && (extraUnitPrice === undefined || extraUnitPrice === null)) {
    throw new ValidationError('extra_unit_price is required when storage_mode=volume');
  }
  const allowExtra = isStorage ? mode === 'volume' : serviceType === 'processing';
  const extraValue = allowExtra && extraUnitPrice != null ? Number(extraUnitPrice) : null;

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
     mode, extraValue]
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
 *
 * volumeLiters (опционально) — объём ОДНОЙ единицы товара в литрах. Если он
 * передан И в прайсе для этой услуги задана extra_unit_price — цена считается
 * прогрессивно, как в chargeStorageForClientToday(): unit_price трактуется
 * как цена за первый литр, extra_unit_price — за каждый следующий (округление
 * литража вверх после вычитания первого литра), а не как простая ставка за
 * штуку. Так одна и та же схема тарификации (раньше — только для 'storage')
 * доступна для любой услуги, например 'processing' — обработка по объёму.
 */
async function chargeForOperation({ tenantId, clientId, serviceType, quantity, refType, refId, periodDate, volumeLiters }) {
  try {
    // Ищем актуальный прайс
    const priceRes = await query(
      `SELECT unit_price, extra_unit_price, min_charge, currency, description
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
    const baseRate = Number(p.unit_price) || 0;
    let unitCost = baseRate;
    if (p.extra_unit_price != null && volumeLiters != null) {
      const extraRate = Number(p.extra_unit_price) || 0;
      const volume = Number(volumeLiters) || 1;
      const extraUnits = volume > 1 ? Math.ceil(volume - 1) : 0;
      unitCost = baseRate + extraRate * extraUnits;
    }
    let total  = qty * unitCost;
    if (p.min_charge && total < Number(p.min_charge)) total = Number(p.min_charge);

    const r = await query(
      `INSERT INTO billing.service_charges
         (tenant_id,client_id,service_type,description,ref_type,ref_id,
          quantity,unit_price,total_amount,currency,period_date)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [tenantId, clientId, serviceType, p.description,
       refType || null, refId ? Number(refId) : null,
       qty, unitCost, total, p.currency || 'RUB',
       periodDate || new Date().toISOString().slice(0, 10)]
    );
    return r.rows[0].id;
  } catch (_) {
    // Биллинг никогда не должен ломать основной поток
    return null;
  }
}

/**
 * Массово удалить ЕЩЁ НЕ ВЫСТАВЛЕННЫЕ начисления — для исправления ошибочно
 * заведённого тарифа задним числом (например, услугу давно сделали бесплатной
 * по договорённости, но прайс-лист вовремя не поменяли, и старые операции
 * успели начислить по старой цене). Начисления, уже попавшие в счёт
 * (is_invoiced=TRUE), трогать нельзя — тот счёт уже мог быть отправлен/оплачен
 * клиенту, для его правки нужен отдельный сценарий (отмена/пересоздание счёта),
 * а не тихое удаление составляющих его строк задним числом.
 */
async function bulkDeleteCharges({ tenantId, chargeIds }) {
  if (!Array.isArray(chargeIds) || !chargeIds.length) {
    throw new ValidationError('charge_ids must be a non-empty array');
  }
  const ids = chargeIds.map(id => Number(id)).filter(Number.isInteger).slice(0, 2000);
  if (!ids.length) throw new ValidationError('No valid charge_ids provided');

  const r = await query(
    `DELETE FROM billing.service_charges
     WHERE tenant_id=$1 AND id=ANY($2::bigint[]) AND is_invoiced=FALSE
     RETURNING id, total_amount`,
    [tenantId, ids]
  );
  const deletedTotal = r.rows.reduce((s, row) => s + Number(row.total_amount), 0);
  return { deleted_count: r.rowCount, deleted_total: deletedTotal };
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
     SET status=$1, notes=COALESCE($2,notes), updated_at=NOW(),
         sent_at = CASE WHEN $1 IN ('sent','paid') THEN COALESCE(sent_at, NOW()) ELSE sent_at END,
         paid_at = CASE WHEN $1 = 'paid' THEN COALESCE(paid_at, NOW()) ELSE paid_at END
     WHERE id=$3 AND tenant_id=$4
     RETURNING id, invoice_number, status, updated_at, sent_at, paid_at`,
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

// ─────────────── Analytics (страница "Финансы") ───────────────

const REVENUE_GRANULARITIES = ['day', 'week', 'month'];

/**
 * Динамика выручки за период — для графика на странице "Финансы".
 * Возвращает три среза одних и тех же начислений (billing.service_charges):
 *  - series      — сумма по периодам (день/неделя/месяц), и если client_id не
 *    задан - ЕЩЁ и с разбивкой по client_id внутри каждого периода (чтобы
 *    фронт мог нарисовать несколько линий "по каждому клиенту отдельно"
 *    поверх общей суммы).
 *  - by_service_type — разбивка по типу услуги ("по операциям") за весь период.
 *  - by_client        — рейтинг клиентов по выручке за весь период.
 * Considers billing начислений НЕЗАВИСИМО от is_invoiced - это факт оказанной
 * услуги/её стоимости, а не факт оплаты, так что для "сколько зарабатываю"
 * это правильнее, чем ждать выставления счёта.
 */
async function getRevenueAnalytics({ tenantId, clientId = null, dateFrom, dateTo, granularity = 'day' }) {
  if (!dateFrom || !dateTo) throw new ValidationError('date_from and date_to are required');
  if (!REVENUE_GRANULARITIES.includes(granularity)) {
    throw new ValidationError(`granularity must be one of: ${REVENUE_GRANULARITIES.join(', ')}`);
  }

  const baseParams = [tenantId, dateFrom, dateTo];
  const clientCond = clientId ? ` AND sc.client_id=$4` : '';
  if (clientId) baseParams.push(clientId);

  // Полная сетка периодов между датами - ВАЖНО отдельно от seriesRes ниже:
  // seriesRes группирует по факту начисления, то есть содержит период ТОЛЬКО
  // если в нём что-то начислено. Без этой сетки график динамики молча
  // "склеивал" дни без начислений с соседними (ось X превращалась в список
  // дат-с-деньгами вместо реального календаря, искажая форму линии). Truncуем
  // КАЖДЫЙ календарный день в диапазоне той же date_trunc(), что и period в
  // seriesRes, чтобы границы недели/месяца совпадали один в один.
  const gridRes = await query(
    `SELECT DISTINCT date_trunc($3, d)::date AS period
     FROM generate_series($1::date, $2::date, interval '1 day') AS d
     ORDER BY period`,
    [dateFrom, dateTo, granularity]
  );

  const seriesRes = await query(
    `SELECT date_trunc($${baseParams.length + 1}, sc.period_date::timestamp)::date AS period,
            sc.client_id, c.client_name, SUM(sc.total_amount)::numeric AS total
     FROM billing.service_charges sc
     JOIN wms.clients c ON c.id = sc.client_id
     WHERE sc.tenant_id=$1 AND sc.period_date>=$2::date AND sc.period_date<=$3::date${clientCond}
     GROUP BY period, sc.client_id, c.client_name
     ORDER BY period`,
    [...baseParams, granularity]
  );

  const byTypeRes = await query(
    `SELECT sc.service_type, SUM(sc.total_amount)::numeric AS total
     FROM billing.service_charges sc
     WHERE sc.tenant_id=$1 AND sc.period_date>=$2::date AND sc.period_date<=$3::date${clientCond}
     GROUP BY sc.service_type
     ORDER BY total DESC`,
    baseParams
  );

  const byClientRes = await query(
    `SELECT sc.client_id, c.client_name, SUM(sc.total_amount)::numeric AS total
     FROM billing.service_charges sc
     JOIN wms.clients c ON c.id = sc.client_id
     WHERE sc.tenant_id=$1 AND sc.period_date>=$2::date AND sc.period_date<=$3::date${clientCond}
     GROUP BY sc.client_id, c.client_name
     ORDER BY total DESC`,
    baseParams
  );

  // Отгружено, шт — по периодам, для графика "Динамика выручки" (вторая линия,
  // чтобы видеть не только деньги, но и физический объём отгрузок).
  //
  // ВАЖНО: источник — wms.shipments (физический факт отгрузки), а НЕ
  // billing.service_charges. Раньше брали service_type='shipping' из
  // начислений, но это завязывало физическую метрику на настройки прайса:
  // как только клиенту убирают старый прайс на "отгрузку" (переходя на схему
  // "Обработка"), chargeForOperation молча перестаёт создавать начисление
  // (см. её же "нет прайса — не начисляем"), и график вместе с ним обнулялся,
  // хотя товар продолжал физически уезжать. wms.shipments.total_shipped_qty/
  // shipped_at проставляются в confirmShipment независимо от того, настроен
  // ли биллинг вообще.
  const shipClientCond = clientId ? ` AND s.client_id=$4` : '';
  const shippedQtyRes = await query(
    `SELECT date_trunc($${baseParams.length + 1}, s.shipped_at)::date AS period,
            SUM(s.total_shipped_qty)::numeric AS qty
     FROM wms.shipments s
     WHERE s.tenant_id=$1 AND s.shipped_at IS NOT NULL
       AND s.shipped_at::date>=$2::date AND s.shipped_at::date<=$3::date${shipClientCond}
     GROUP BY period
     ORDER BY period`,
    [...baseParams, granularity]
  );

  // Отдельная динамика по "Хранение" (service_type='storage') — начисляется
  // раз в сутки фоновой джобой (chargeStorageForClientToday), в отличие от
  // событийных услуг (сборка/упаковка/отгрузка), поэтому и просят смотреть её
  // отдельным графиком: на общей линии "Динамика выручки" (сумма ВСЕХ типов)
  // ежедневное хранение просто тонет на фоне разовых всплесков по отгрузкам.
  const storageSeriesRes = await query(
    `SELECT date_trunc($${baseParams.length + 1}, sc.period_date::timestamp)::date AS period,
            SUM(sc.total_amount)::numeric AS total
     FROM billing.service_charges sc
     WHERE sc.tenant_id=$1 AND sc.service_type='storage'
       AND sc.period_date>=$2::date AND sc.period_date<=$3::date${clientCond}
     GROUP BY period
     ORDER BY period`,
    [...baseParams, granularity]
  );

  const grandTotal = byTypeRes.rows.reduce((s, r) => s + Number(r.total), 0);
  const shippedQtyTotal = shippedQtyRes.rows.reduce((s, r) => s + Number(r.qty), 0);
  const storageTotal = storageSeriesRes.rows.reduce((s, r) => s + Number(r.total), 0);

  return {
    period_from: dateFrom, period_to: dateTo, granularity,
    period_grid: gridRes.rows.map(r => r.period),
    series: seriesRes.rows.map(r => ({
      period: r.period, client_id: r.client_id, client_name: r.client_name, total: Number(r.total),
    })),
    by_service_type: byTypeRes.rows.map(r => ({ service_type: r.service_type, total: Number(r.total) })),
    by_client: byClientRes.rows.map(r => ({ client_id: r.client_id, client_name: r.client_name, total: Number(r.total) })),
    shipped_qty_series: shippedQtyRes.rows.map(r => ({ period: r.period, qty: Number(r.qty) })),
    shipped_qty_total: shippedQtyTotal,
    storage_series: storageSeriesRes.rows.map(r => ({ period: r.period, total: Number(r.total) })),
    storage_total: storageTotal,
    grand_total: grandTotal,
  };
}

// ─────────────── Invoice analytics (выставлено/оплачено/разбивка по клиентам) ───────────────

const INVOICE_GRANULARITIES = ['day', 'week', 'month'];

async function getInvoiceAnalytics({ tenantId, clientId = null, dateFrom, dateTo, granularity = 'day' }) {
  if (!dateFrom || !dateTo) throw new ValidationError('date_from and date_to are required');
  if (!INVOICE_GRANULARITIES.includes(granularity)) {
    throw new ValidationError(`granularity must be one of: ${INVOICE_GRANULARITIES.join(', ')}`);
  }

  const baseParams = [tenantId, dateFrom, dateTo];
  const clientCond = clientId ? ` AND inv.client_id=$4` : '';
  if (clientId) baseParams.push(clientId);

  // Полная сетка периодов (та же логика, что и в getRevenueAnalytics) —
  // чтобы дни/недели/месяцы без событий не выпадали из оси X графика.
  const gridRes = await query(
    `SELECT DISTINCT date_trunc($3, d)::date AS period
     FROM generate_series($1::date, $2::date, interval '1 day') AS d
     ORDER BY period`,
    [dateFrom, dateTo, granularity]
  );

  // Выставлено по периодам — момент перехода в статус sent (sent_at)
  const sentSeriesRes = await query(
    `SELECT date_trunc($${baseParams.length + 1}, inv.sent_at)::date AS period,
            SUM(inv.total_amount)::numeric AS total
     FROM billing.invoices inv
     WHERE inv.tenant_id=$1 AND inv.sent_at IS NOT NULL
       AND inv.sent_at::date>=$2::date AND inv.sent_at::date<=$3::date${clientCond}
     GROUP BY period
     ORDER BY period`,
    [...baseParams, granularity]
  );

  // Оплачено по периодам — момент перехода в статус paid (paid_at)
  const paidSeriesRes = await query(
    `SELECT date_trunc($${baseParams.length + 1}, inv.paid_at)::date AS period,
            SUM(inv.total_amount)::numeric AS total
     FROM billing.invoices inv
     WHERE inv.tenant_id=$1 AND inv.paid_at IS NOT NULL
       AND inv.paid_at::date>=$2::date AND inv.paid_at::date<=$3::date${clientCond}
     GROUP BY period
     ORDER BY period`,
    [...baseParams, granularity]
  );

  // Не выставлено — по периоду НАЧИСЛЕНИЯ (period_date), а не по "сейчас":
  // сколько из начисленного в каждом периоде так и остаётся без счёта на
  // сегодня (is_invoiced=FALSE — снимок на текущий момент, накладывается на
  // дату начисления). Показывает, за какие периоды скопился хвост, который
  // ещё не выставлен.
  const scClientCond = clientId ? ` AND sc.client_id=$4` : '';
  const uninvoicedSeriesRes = await query(
    `SELECT date_trunc($${baseParams.length + 1}, sc.period_date::timestamp)::date AS period,
            SUM(sc.total_amount)::numeric AS total
     FROM billing.service_charges sc
     WHERE sc.tenant_id=$1 AND sc.is_invoiced=FALSE
       AND sc.period_date>=$2::date AND sc.period_date<=$3::date${scClientCond}
     GROUP BY period
     ORDER BY period`,
    [...baseParams, granularity]
  );

  // Разбивка по клиентам за весь период: сколько выставлено/оплачено внутри
  // диапазона дат, плюс ТЕКУЩИЙ непогашенный остаток (status='sent') —
  // это снимок на сейчас, а не событие внутри диапазона, поэтому считается
  // без фильтра по датам.
  const byClientCond = clientId ? ` AND inv.client_id=$4` : '';
  const byClientRes = await query(
    `SELECT inv.client_id, c.client_name,
            COALESCE(SUM(inv.total_amount) FILTER (
              WHERE inv.sent_at IS NOT NULL AND inv.sent_at::date>=$2::date AND inv.sent_at::date<=$3::date
            ), 0)::numeric AS sent_total,
            COALESCE(SUM(inv.total_amount) FILTER (
              WHERE inv.paid_at IS NOT NULL AND inv.paid_at::date>=$2::date AND inv.paid_at::date<=$3::date
            ), 0)::numeric AS paid_total,
            COALESCE(SUM(inv.total_amount) FILTER (WHERE inv.status='sent'), 0)::numeric AS outstanding_total
     FROM billing.invoices inv
     JOIN wms.clients c ON c.id = inv.client_id
     WHERE inv.tenant_id=$1${byClientCond}
     GROUP BY inv.client_id, c.client_name
     HAVING SUM(inv.total_amount) FILTER (
              WHERE inv.sent_at IS NOT NULL AND inv.sent_at::date>=$2::date AND inv.sent_at::date<=$3::date
            ) IS NOT NULL
         OR SUM(inv.total_amount) FILTER (WHERE inv.status='sent') > 0
     ORDER BY outstanding_total DESC, sent_total DESC`,
    baseParams
  );

  // Текущий непогашенный остаток (снимок на сейчас), для KPI-плашки
  const outstandingRes = await query(
    `SELECT COALESCE(SUM(inv.total_amount),0)::numeric AS total, COUNT(*)::int AS n
     FROM billing.invoices inv
     WHERE inv.tenant_id=$1 AND inv.status='sent'${clientId ? ' AND inv.client_id=$2' : ''}`,
    clientId ? [tenantId, clientId] : [tenantId]
  );

  // "Не выставлено" — начисления, которым ещё даже не создан счёт
  // (sc.is_invoiced=FALSE). Это снимок на сейчас, как и outstanding_total.
  // Отдельная выборка (не через billing.invoices), поэтому клиенты, у которых
  // ЕЩЁ не было ни одного счёта, но уже накопились начисления, тоже должны
  // попасть в разбивку — учитываем это ниже через merge по client_id.
  const uninvoicedRes = await query(
    `SELECT sc.client_id, c.client_name, SUM(sc.total_amount)::numeric AS total
     FROM billing.service_charges sc
     JOIN wms.clients c ON c.id = sc.client_id
     WHERE sc.tenant_id=$1 AND sc.is_invoiced=FALSE${clientId ? ' AND sc.client_id=$2' : ''}
     GROUP BY sc.client_id, c.client_name`,
    clientId ? [tenantId, clientId] : [tenantId]
  );
  const uninvoicedTotal = uninvoicedRes.rows.reduce((s, r) => s + Number(r.total), 0);

  const sentTotal = sentSeriesRes.rows.reduce((s, r) => s + Number(r.total), 0);
  const paidTotal  = paidSeriesRes.rows.reduce((s, r) => s + Number(r.total), 0);

  // Мёрджим разбивку по счетам (byClientRes) и по неучтённым начислениям
  // (uninvoicedRes) в единую карту по client_id — клиент может присутствовать
  // только в одном из источников (например, ни разу не выставляли счёт, но
  // начисления уже копятся).
  const byClientMap = new Map();
  for (const r of byClientRes.rows) {
    byClientMap.set(r.client_id, {
      client_id: r.client_id, client_name: r.client_name,
      sent_total: Number(r.sent_total), paid_total: Number(r.paid_total),
      outstanding_total: Number(r.outstanding_total), uninvoiced_total: 0,
    });
  }
  for (const r of uninvoicedRes.rows) {
    const existing = byClientMap.get(r.client_id);
    if (existing) { existing.uninvoiced_total = Number(r.total); }
    else {
      byClientMap.set(r.client_id, {
        client_id: r.client_id, client_name: r.client_name,
        sent_total: 0, paid_total: 0, outstanding_total: 0, uninvoiced_total: Number(r.total),
      });
    }
  }
  const byClient = [...byClientMap.values()]
    .sort((a, b) => (b.outstanding_total + b.uninvoiced_total) - (a.outstanding_total + a.uninvoiced_total));

  return {
    period_from: dateFrom, period_to: dateTo, granularity,
    period_grid: gridRes.rows.map(r => r.period),
    sent_series: sentSeriesRes.rows.map(r => ({ period: r.period, total: Number(r.total) })),
    paid_series: paidSeriesRes.rows.map(r => ({ period: r.period, total: Number(r.total) })),
    uninvoiced_series: uninvoicedSeriesRes.rows.map(r => ({ period: r.period, total: Number(r.total) })),
    sent_total: sentTotal,
    paid_total: paidTotal,
    outstanding_total: Number(outstandingRes.rows[0].total),
    outstanding_count: outstandingRes.rows[0].n,
    uninvoiced_total: uninvoicedTotal,
    by_client: byClient,
  };
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
  bulkDeleteCharges,
  chargeForOperation,
  listInvoices,
  getInvoice,
  createInvoice,
  updateInvoiceStatus,
  getClientBalance,
  getRevenueAnalytics,
  getInvoiceAnalytics,
  listClientsWithActiveStoragePrice,
  chargeStorageForClientToday,
};
