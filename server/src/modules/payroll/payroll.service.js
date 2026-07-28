'use strict';

const { query } = require('../../config/database');
const { NotFoundError, ValidationError } = require('../../utils/errors');

// =============================================================================
// Payroll Service — сдельная ЗП
//
// Отдельного лога начислений ЗП нет: единицы выработки считаются "на лету"
// из wms.stock_movements (там уже есть user_id на каждой складской операции —
// то же, чем пользуется analytics.getOperatorStats). Ставки (billing.employee_rates)
// хранятся либо на роль, либо на конкретного сотрудника (override роли).
//
// Формула единиц по типу движения — чтобы не задвоить операции размещения
// (placement пишется ДВУМЯ строками: расход из ячейки-источника и приход в
// ячейку-назначение на одно и то же перемещение) считаем только "приходную"
// половину (qty>0). Для picking/shipping берём модуль (там бывают
// отрицательные строки списания).
// =============================================================================

const RATEABLE_MOVEMENT_TYPES = ['receiving', 'placement', 'picking', 'packing', 'shipping'];

function unitsExprFor(movementType) {
  if (['receiving', 'placement', 'packing'].includes(movementType)) {
    return `SUM(GREATEST(m.qty,0))`;
  }
  return `SUM(ABS(m.qty))`;
}

async function listRates({ tenantId }) {
  const r = await query(
    `SELECT er.id, er.role, er.employee_id, er.movement_type, er.rate, er.currency, er.updated_at,
            u.full_name AS employee_name
     FROM billing.employee_rates er
     LEFT JOIN wms.users u ON u.id = er.employee_id
     WHERE er.tenant_id=$1
     ORDER BY er.role NULLS LAST, u.full_name NULLS LAST, er.movement_type`,
    [tenantId]
  );
  return r.rows;
}

async function upsertRate({ tenantId, role, employeeId, movementType, rate, currency }) {
  if (!RATEABLE_MOVEMENT_TYPES.includes(movementType)) {
    throw new ValidationError(`movement_type must be one of: ${RATEABLE_MOVEMENT_TYPES.join(', ')}`);
  }
  if ((role && employeeId) || (!role && !employeeId)) {
    throw new ValidationError('Specify exactly one of role or employee_id');
  }
  const conflictTarget = employeeId ? '(tenant_id, employee_id, movement_type) WHERE role IS NULL'
                                     : '(tenant_id, role, movement_type) WHERE employee_id IS NULL';

  // ON CONFLICT с partial unique index требует явного указания того же условия WHERE
  const r = await query(
    `INSERT INTO billing.employee_rates (tenant_id, role, employee_id, movement_type, rate, currency)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT ${conflictTarget}
     DO UPDATE SET rate=EXCLUDED.rate, currency=EXCLUDED.currency, updated_at=NOW()
     RETURNING *`,
    [tenantId, role || null, employeeId || null, movementType, Number(rate) || 0, currency || 'RUB']
  );
  return r.rows[0];
}

async function deleteRate({ tenantId, id }) {
  const r = await query(
    `DELETE FROM billing.employee_rates WHERE id=$1 AND tenant_id=$2 RETURNING id`,
    [id, tenantId]
  );
  if (r.rowCount === 0) throw new NotFoundError('EmployeeRate', id);
  return r.rows[0];
}

/**
 * Отчёт по ЗП за период: по каждому активному складскому сотруднику —
 * выработка по типам операций × ставка (own override, иначе ставка роли).
 */
async function getPayrollReport({ tenantId, dateFrom, dateTo }) {
  if (!dateFrom || !dateTo) throw new ValidationError('date_from and date_to are required');

  // 1) Ставки — маленькая таблица, забираем всю и матчим в JS
  const ratesRes = await query(
    `SELECT role, employee_id, movement_type, rate FROM billing.employee_rates WHERE tenant_id=$1`,
    [tenantId]
  );
  const roleRate = new Map();   // `${role}:${movementType}` -> rate
  const empRate  = new Map();   // `${employeeId}:${movementType}` -> rate
  for (const r of ratesRes.rows) {
    if (r.employee_id) empRate.set(`${r.employee_id}:${r.movement_type}`, Number(r.rate));
    else roleRate.set(`${r.role}:${r.movement_type}`, Number(r.rate));
  }

  // 2) Выработка по сотрудникам × типам операций за период
  const unionParts = RATEABLE_MOVEMENT_TYPES.map(mt =>
    `SELECT m.user_id, '${mt}'::text AS movement_type, ${unitsExprFor(mt)} AS units
     FROM wms.stock_movements m
     WHERE m.tenant_id=$1 AND m.movement_type='${mt}'
       AND m.created_at>=$2::date AND m.created_at<($3::date+interval '1 day')
     GROUP BY m.user_id`
  ).join('\nUNION ALL\n');

  const workRes = await query(
    `SELECT u.id AS user_id, u.full_name, u.role, w.movement_type, COALESCE(w.units,0) AS units
     FROM wms.users u
     LEFT JOIN (${unionParts}) w ON w.user_id = u.id
     WHERE u.tenant_id=$1 AND u.is_active=TRUE
       AND u.role IN ('receiver','picker','packer','shipper','inventory_manager')
     ORDER BY u.full_name`,
    [tenantId, dateFrom, dateTo]
  );

  const byEmployee = new Map();
  for (const row of workRes.rows) {
    if (!byEmployee.has(row.user_id)) {
      byEmployee.set(row.user_id, {
        employeeId: row.user_id, fullName: row.full_name, role: row.role,
        breakdown: [], total: 0,
      });
    }
    if (!row.movement_type) continue; // сотрудник без движений в периоде
    const units = Number(row.units) || 0;
    if (units === 0) continue;

    const rate = empRate.get(`${row.user_id}:${row.movement_type}`)
             ?? roleRate.get(`${row.role}:${row.movement_type}`)
             ?? 0;
    const amount = units * rate;

    const entry = byEmployee.get(row.user_id);
    entry.breakdown.push({ movementType: row.movement_type, units, rate, amount });
    entry.total += amount;
  }

  const employees = [...byEmployee.values()].sort((a, b) => b.total - a.total);
  const grandTotal = employees.reduce((s, e) => s + e.total, 0);

  return { period_from: dateFrom, period_to: dateTo, employees, grand_total: grandTotal };
}

module.exports = {
  listRates,
  upsertRate,
  deleteRate,
  getPayrollReport,
  RATEABLE_MOVEMENT_TYPES,
};
