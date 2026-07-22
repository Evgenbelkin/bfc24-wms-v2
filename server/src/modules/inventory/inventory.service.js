'use strict';

const { query, transaction } = require('../../config/database');
const ledger = require('../stock/stock.ledger');
const { getDefaultWarehouse } = require('../warehouses/warehouses.service');
const {
  NotFoundError,
  ValidationError,
  ForbiddenError,
} = require('../../utils/errors');
const { validateBarcode, validatePositiveInt } = require('../../utils/validators');
const logger = require('../../utils/logger');

// =============================================================================
// Inventory Service
//
// Инвентаризация — пересчёт фактических остатков и приведение системы в соответствие.
//
// Флоу:
//   1. Создать задачу (createTask) — для конкретной ячейки+barcode или всей ячейки
//   2. Назначить исполнителя (assignTask)
//   3. Внести фактическое количество (submitCount)
//      → delta = actual - system → stock_movement type='inventory'
//   4. Закрыть задачу (closeTask)
//
// API:
//   createTask      — создать задачу инвентаризации
//   listTasks       — список задач
//   getTask         — детальная задача
//   assignTask      — назначить исполнителя
//   submitCount     — внести фактический счёт + применить delta
//   closeTask       — закрыть задачу (done/cancelled)
//   createBatchTasks — создать задачи по ячейке (по всем позициям)
//   getDiscrepancyReport — отчёт по расхождениям
// =============================================================================

async function createTask({
  tenantId,
  warehouseId,
  clientId,
  barcode,
  locationCode,
  reason,
  comment,
  priority,
  userId,
}) {
  const b = String(barcode || '').trim();
  const loc = String(locationCode || '').trim().toUpperCase();
  if (!loc) throw new ValidationError('location_code is required');

  return transaction(async (client) => {
    // Ячейка
    const locRes = await client.query(
      `SELECT id, location_code FROM wms.locations
       WHERE tenant_id=$1 AND warehouse_id=$2 AND location_code=$3 AND is_active=TRUE LIMIT 1`,
      [tenantId, warehouseId, loc]
    );
    if (locRes.rowCount === 0) throw new NotFoundError(`Location '${loc}'`);
    const location = locRes.rows[0];

    // Текущий остаток по системе
    let qtySystem = null;
    let itemId    = null;

    if (b) {
      const itemRes = await client.query(
        `SELECT id FROM wms.items WHERE tenant_id=$1 AND client_id=$2 AND barcode=$3 LIMIT 1`,
        [tenantId, clientId, b]
      );
      if (itemRes.rowCount > 0) {
        itemId = itemRes.rows[0].id;
        const balRes = await client.query(
          `SELECT qty_on_hand FROM wms.stock_balances
           WHERE tenant_id=$1 AND warehouse_id=$2 AND client_id=$3 AND item_id=$4 AND location_id=$5`,
          [tenantId, warehouseId, clientId, itemId, location.id]
        );
        qtySystem = balRes.rowCount > 0 ? Number(balRes.rows[0].qty_on_hand) : 0;
      }
    }

    // Проверяем нет ли открытой задачи на эту позицию
    if (b) {
      const dup = await client.query(
        `SELECT id FROM wms.inventory_tasks
         WHERE tenant_id=$1 AND barcode=$2 AND location_code=$3
           AND status IN ('open','in_progress')
         LIMIT 1`,
        [tenantId, b, loc]
      );
      if (dup.rowCount > 0) {
        throw new ValidationError(
          `Inventory task already exists for barcode='${b}' location='${loc}'`
        );
      }
    }

    const r = await client.query(
      `INSERT INTO wms.inventory_tasks
         (tenant_id, warehouse_id, client_id, item_id, barcode, location_id, location_code,
          qty_system, status, priority, reason, comment, created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10,$11,$12)
       RETURNING *`,
      [
        tenantId, warehouseId, clientId, itemId, b || null,
        location.id, loc,
        qtySystem, priority || 3,
        reason || null, comment || null, userId,
      ]
    );

    return r.rows[0];
  });
}

/**
 * Создать задачи по всем позициям ячейки (bulk)
 */
async function createBatchTasks({ tenantId, warehouseId, clientId, locationCode, reason, userId }) {
  const loc = String(locationCode || '').trim().toUpperCase();
  if (!loc) throw new ValidationError('location_code is required');

  return transaction(async (client) => {
    // Проверяем ячейку
    const locRes = await client.query(
      `SELECT id, location_code FROM wms.locations
       WHERE tenant_id=$1 AND warehouse_id=$2 AND location_code=$3 AND is_active=TRUE LIMIT 1`,
      [tenantId, warehouseId, loc]
    );
    if (locRes.rowCount === 0) throw new NotFoundError(`Location '${loc}'`);
    const location = locRes.rows[0];

    // Все позиции в этой ячейке
    const balRes = await client.query(
      `SELECT sb.barcode, sb.qty_on_hand, sb.item_id, sb.client_id
       FROM wms.stock_balances sb
       WHERE sb.tenant_id=$1 AND sb.warehouse_id=$2 AND sb.location_id=$3
         AND sb.qty_on_hand>0`,
      [tenantId, warehouseId, location.id]
    );

    const created = [];
    const skipped = [];

    for (const bal of balRes.rows) {
      // Пропускаем если уже есть открытая задача
      const dup = await client.query(
        `SELECT id FROM wms.inventory_tasks
         WHERE tenant_id=$1 AND barcode=$2 AND location_code=$3 AND status IN ('open','in_progress')
         LIMIT 1`,
        [tenantId, bal.barcode, loc]
      );
      if (dup.rowCount > 0) { skipped.push(bal.barcode); continue; }

      const r = await client.query(
        `INSERT INTO wms.inventory_tasks
           (tenant_id,warehouse_id,client_id,item_id,barcode,location_id,location_code,
            qty_system,status,priority,reason,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'open',3,$9,$10)
         RETURNING id, barcode, location_code, qty_system`,
        [tenantId, warehouseId, clientId || bal.client_id, bal.item_id,
         bal.barcode, location.id, loc, bal.qty_on_hand, reason || null, userId]
      );
      created.push(r.rows[0]);
    }

    // Если ячейка пуста — создаём одну задачу-пустышку (проверка что действительно пусто)
    if (balRes.rowCount === 0) {
      const r = await client.query(
        `INSERT INTO wms.inventory_tasks
           (tenant_id,warehouse_id,client_id,item_id,barcode,location_id,location_code,
            qty_system,status,priority,reason,created_by)
         VALUES($1,$2,$3,NULL,NULL,$4,$5,0,'open',3,$6,$7)
         RETURNING id, barcode, location_code, qty_system`,
        [tenantId, warehouseId, clientId, location.id, loc, reason || 'empty_check', userId]
      );
      created.push(r.rows[0]);
    }

    return { created: created.length, skipped: skipped.length, tasks: created };
  });
}

/**
 * Список задач инвентаризации
 */
async function listTasks({
  tenantId,
  warehouseId  = null,
  clientId     = null,
  status       = null,
  locationCode = null,
  barcode      = null,
  assigneeId   = null,
  dateFrom     = null,
  dateTo       = null,
  limit  = 200,
  offset = 0,
}) {
  const params = [tenantId];
  const conds  = ['it.tenant_id=$1'];
  let idx = 2;

  if (warehouseId)  { conds.push(`it.warehouse_id=$${idx++}`);   params.push(warehouseId); }
  if (clientId)     { conds.push(`it.client_id=$${idx++}`);      params.push(clientId); }
  if (status)       { conds.push(`it.status=$${idx++}`);         params.push(status); }
  if (locationCode) { conds.push(`it.location_code=$${idx++}`);  params.push(locationCode.toUpperCase()); }
  if (barcode)      { conds.push(`it.barcode=$${idx++}`);        params.push(barcode); }
  if (assigneeId)   { conds.push(`it.assignee_id=$${idx++}`);    params.push(assigneeId); }
  if (dateFrom)     { conds.push(`it.created_at>=$${idx++}::date`); params.push(dateFrom); }
  if (dateTo)       { conds.push(`it.created_at<($${idx++}::date+interval '1 day')`); params.push(dateTo); }

  const total = (await query(
    `SELECT COUNT(*)::int AS n FROM wms.inventory_tasks it WHERE ${conds.join(' AND ')}`,
    params
  )).rows[0].n;

  params.push(Math.min(limit, 2000), Math.max(offset, 0));
  const r = await query(
    `SELECT
       it.id, it.barcode, it.location_code, it.location_id,
       it.qty_system, it.qty_actual, it.qty_delta,
       it.status, it.priority, it.reason, it.comment,
       it.created_at, it.closed_at,
       i.item_name, i.vendor_code, i.unit,
       c.client_name,
       u.username  AS assignee_name,
       cb.username AS created_by_name,
       w.warehouse_name
     FROM wms.inventory_tasks it
     LEFT JOIN wms.items i ON i.id=it.item_id
     LEFT JOIN wms.clients c ON c.id=it.client_id
     LEFT JOIN wms.users u ON u.id=it.assignee_id
     LEFT JOIN wms.users cb ON cb.id=it.created_by
     LEFT JOIN wms.warehouses w ON w.id=it.warehouse_id
     WHERE ${conds.join(' AND ')}
     ORDER BY it.priority ASC, it.created_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params
  );
  return { tasks: r.rows, total, limit, offset };
}

async function getTask({ tenantId, taskId }) {
  const r = await query(
    `SELECT
       it.*, i.item_name, i.vendor_code, i.unit, i.preview_url,
       c.client_name, u.username AS assignee_name, w.warehouse_name
     FROM wms.inventory_tasks it
     LEFT JOIN wms.items i ON i.id=it.item_id
     LEFT JOIN wms.clients c ON c.id=it.client_id
     LEFT JOIN wms.users u ON u.id=it.assignee_id
     LEFT JOIN wms.warehouses w ON w.id=it.warehouse_id
     WHERE it.id=$1 AND it.tenant_id=$2`,
    [taskId, tenantId]
  );
  if (r.rowCount === 0) throw new NotFoundError('InventoryTask', taskId);
  return r.rows[0];
}

async function assignTask({ tenantId, taskId, assigneeId }) {
  const task = await getTask({ tenantId, taskId });
  if (!['open'].includes(task.status)) {
    throw new ValidationError(`Cannot assign task in status '${task.status}'`);
  }

  const r = await query(
    `UPDATE wms.inventory_tasks
     SET assignee_id=$1, status='in_progress', updated_at=NOW()
     WHERE id=$2 AND tenant_id=$3
     RETURNING *`,
    [assigneeId, taskId, tenantId]
  );
  return r.rows[0];
}

/**
 * Внести фактический счёт — ключевая операция
 * Вычисляет delta, создаёт stock_movement type='inventory'
 */
async function submitCount({ tenantId, taskId, qtyActual, userId, comment }) {
  if (qtyActual === undefined || qtyActual === null) {
    throw new ValidationError('qty_actual is required');
  }
  const actual = Number(qtyActual);
  if (!Number.isInteger(actual) || actual < 0) {
    throw new ValidationError('qty_actual must be a non-negative integer');
  }

  return transaction(async (client) => {
    // FOR UPDATE задачи
    const tRes = await client.query(
      `SELECT * FROM wms.inventory_tasks WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
      [taskId, tenantId]
    );
    if (tRes.rowCount === 0) throw new NotFoundError('InventoryTask', taskId);
    const task = tRes.rows[0];

    if (!['open','in_progress'].includes(task.status)) {
      throw new ValidationError(`Cannot submit count for task in status '${task.status}'`);
    }

    const systemQty = task.qty_system !== null ? Number(task.qty_system) : 0;
    const delta     = actual - systemQty;

    // Применяем корректировку через ledger если есть item и delta != 0
    if (task.item_id && task.location_id && delta !== 0) {
      // Получаем clientId и warehouseId для ledger
      const cliWh = { clientId: task.client_id, warehouseId: task.warehouse_id };

      // Получаем barcode
      const barcodeStr = task.barcode;

      if (delta > 0) {
        // Приход
        await client.query(
          `INSERT INTO wms.stock_movements
             (tenant_id,warehouse_id,client_id,item_id,barcode,movement_type,qty,
              to_location_id,to_location_code,ref_type,ref_id,user_id,comment)
           VALUES($1,$2,$3,$4,$5,'inventory',$6,$7,$8,'inventory_task',$9,$10,$11)`,
          [tenantId, task.warehouse_id, task.client_id, task.item_id, barcodeStr,
           delta, task.location_id, task.location_code,
           task.id, userId, comment || `Инвентаризация: факт=${actual}, система=${systemQty}`]
        );
        await client.query(
          `SELECT * FROM wms.apply_stock_movement($1,$2,$3,$4,$5,$6,$7,$8)`,
          [tenantId, task.warehouse_id, task.client_id, task.item_id, task.location_id, barcodeStr, delta, null]
        );
      } else {
        // Расход (delta < 0)
        // Проверяем доступный остаток
        const balRes = await client.query(
          `SELECT qty_on_hand FROM wms.stock_balances
           WHERE tenant_id=$1 AND warehouse_id=$2 AND client_id=$3 AND item_id=$4 AND location_id=$5
           FOR UPDATE`,
          [tenantId, task.warehouse_id, task.client_id, task.item_id, task.location_id]
        );
        const currentQty = balRes.rowCount > 0 ? Number(balRes.rows[0].qty_on_hand) : 0;
        // Если списываем больше чем есть — списываем сколько есть
        const safeAbsDelta = Math.min(Math.abs(delta), currentQty);

        if (safeAbsDelta > 0) {
          await client.query(
            `INSERT INTO wms.stock_movements
               (tenant_id,warehouse_id,client_id,item_id,barcode,movement_type,qty,
                from_location_id,from_location_code,ref_type,ref_id,user_id,comment)
             VALUES($1,$2,$3,$4,$5,'inventory',$6,$7,$8,'inventory_task',$9,$10,$11)`,
            [tenantId, task.warehouse_id, task.client_id, task.item_id, barcodeStr,
             -safeAbsDelta, task.location_id, task.location_code,
             task.id, userId, comment || `Инвентаризация: факт=${actual}, система=${systemQty}`]
          );
          await client.query(
            `SELECT * FROM wms.apply_stock_movement($1,$2,$3,$4,$5,$6,$7,$8)`,
            [tenantId, task.warehouse_id, task.client_id, task.item_id, task.location_id, barcodeStr, -safeAbsDelta, null]
          );
        }
      }
    }

    // Обновляем задачу
    const r = await client.query(
      `UPDATE wms.inventory_tasks
       SET qty_actual=$1, qty_delta=$2, status='done',
           comment=COALESCE($3,comment),
           closed_at=NOW(), closed_by=$4, updated_at=NOW()
       WHERE id=$5
       RETURNING *`,
      [actual, delta, comment || null, userId, taskId]
    );

    logger.info({ tenantId, taskId, delta, actual, systemQty }, 'Inventory count submitted');

    return r.rows[0];
  });
}

/**
 * Закрыть задачу без счёта (cancelled)
 */
async function closeTask({ tenantId, taskId, userId, status = 'cancelled', comment }) {
  if (!['done','cancelled'].includes(status)) {
    throw new ValidationError("status must be 'done' or 'cancelled'");
  }

  const task = await getTask({ tenantId, taskId });
  if (task.status === 'done' || task.status === 'cancelled') {
    throw new ValidationError(`Task already in status '${task.status}'`);
  }

  const r = await query(
    `UPDATE wms.inventory_tasks
     SET status=$1, comment=COALESCE($2,comment), closed_at=NOW(), closed_by=$3, updated_at=NOW()
     WHERE id=$4 AND tenant_id=$5
     RETURNING id, status, closed_at`,
    [status, comment || null, userId, taskId, tenantId]
  );
  return r.rows[0];
}

/**
 * Отчёт по расхождениям (только задачи с delta != 0)
 */
async function getDiscrepancyReport({
  tenantId,
  warehouseId = null,
  clientId    = null,
  dateFrom    = null,
  dateTo      = null,
  limit  = 500,
  offset = 0,
}) {
  const params = [tenantId];
  const conds  = [
    "it.tenant_id=$1",
    "it.status='done'",
    "it.qty_delta IS NOT NULL",
    "it.qty_delta <> 0",
  ];
  let idx = 2;

  if (warehouseId) { conds.push(`it.warehouse_id=$${idx++}`); params.push(warehouseId); }
  if (clientId)    { conds.push(`it.client_id=$${idx++}`);    params.push(clientId); }
  if (dateFrom)    { conds.push(`it.closed_at>=$${idx++}::date`); params.push(dateFrom); }
  if (dateTo)      { conds.push(`it.closed_at<($${idx++}::date+interval '1 day')`); params.push(dateTo); }

  params.push(Math.min(limit, 2000), Math.max(offset, 0));

  const r = await query(
    `SELECT
       it.id AS task_id,
       it.barcode, it.location_code,
       it.qty_system, it.qty_actual, it.qty_delta,
       it.closed_at,
       i.item_name, i.vendor_code, i.unit,
       i.cost_price,
       it.qty_delta * COALESCE(i.cost_price, 0) AS cost_delta,
       c.client_name,
       u.username AS closed_by_name,
       w.warehouse_name
     FROM wms.inventory_tasks it
     LEFT JOIN wms.items i ON i.id=it.item_id
     LEFT JOIN wms.clients c ON c.id=it.client_id
     LEFT JOIN wms.users u ON u.id=it.closed_by
     LEFT JOIN wms.warehouses w ON w.id=it.warehouse_id
     WHERE ${conds.join(' AND ')}
     ORDER BY ABS(it.qty_delta) DESC, it.closed_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params
  );
  return r.rows;
}

module.exports = {
  createTask,
  createBatchTasks,
  listTasks,
  getTask,
  assignTask,
  submitCount,
  closeTask,
  getDiscrepancyReport,
};
