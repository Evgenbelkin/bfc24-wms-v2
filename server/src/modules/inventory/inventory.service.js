'use strict';

const { query, transaction } = require('../../config/database');
const ledger = require('../stock/stock.ledger');
const { getDefaultWarehouse } = require('../warehouses/warehouses.service');
const {
  NotFoundError,
  ValidationError,
  ForbiddenError,
} = require('../../utils/errors');
const { validateBarcode, validatePositiveInt, validateQty } = require('../../utils/validators');
const { triggerRedistributionForClient } = require('../wb/wb.service');
const { getLocationByCode } = require('../masterdata/locations/locations.service');
const { InsufficientStockError } = require('../../utils/errors');
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
      } else {
        // Штрихкод не нашёлся у ВЫБРАННОГО клиента - barcode уникален только в
        // пределах (tenant_id, client_id, barcode) (см. UNIQUE в 003_masterdata.sql),
        // так что разные клиенты в принципе МОГУТ иметь разные товары с одним и
        // тем же значением barcode. Раньше в этом случае задача молча создавалась
        // с item_id=NULL и qty_system=NULL ("По системе: —") - пересчёт визуально
        // проходил нормально, но submitCount() ничего не мог применить к остаткам
        // (нет item_id), и товар в ячейке оставался как был - выглядело как "баг
        // с инвентаризацией", а на деле просто был выбран не тот клиент вверху
        // экрана. Проверяем, кому РЕАЛЬНО принадлежит остаток с этим штрихкодом
        // именно в этой ячейке - это физическая правда, ей и доверяем.
        const actualRes = await client.query(
          `SELECT i.client_id, c.client_name
           FROM wms.stock_balances sb
           JOIN wms.items i ON i.id = sb.item_id
           LEFT JOIN wms.clients c ON c.id = i.client_id
           WHERE sb.tenant_id=$1 AND sb.warehouse_id=$2 AND sb.location_id=$3
             AND i.barcode=$4 AND sb.qty_on_hand > 0
           LIMIT 1`,
          [tenantId, warehouseId, location.id, b]
        );
        if (actualRes.rowCount > 0 && actualRes.rows[0].client_id !== clientId) {
          throw new ValidationError(
            `Штрихкод '${b}' в ячейке '${loc}' числится за клиентом "${actualRes.rows[0].client_name || actualRes.rows[0].client_id}", а не за выбранным вверху экрана. Переключите клиента и создайте пересчёт заново.`
          );
        }
        // Иначе - штрихкода действительно нет ни у одного клиента в этой ячейке
        // (или он вообще не заведён в каталоге) - это законный случай "нашли
        // незнакомый товар", создаём задачу без привязки к каталогу, как раньше.
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

  const taskResult = await transaction(async (client) => {
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

    return { row: r.rows[0], clientId: task.client_id, delta };
  });

  // Пересчитать распределение по складам WB, только если реально что-то
  // изменилось (delta=0 - подтвердили то, что и так было, пересчитывать нечего).
  // Только по штрихкоду ЭТОЙ задачи (см. комментарий в wb.service.js) - не
  // пересчитываем заодно весь ассортимент клиента.
  if (taskResult.delta !== 0 && taskResult.row.barcode) {
    triggerRedistributionForClient({ tenantId, clientId: taskResult.clientId, barcodes: [taskResult.row.barcode] });
  }

  return taskResult.row;
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

/**
 * Сборка комплекта (kit) из базового товара — например, отпугиватель мышей
 * продаётся на WB как "1 шт"/"2 шт"/"3 шт"/"4 шт" под разными карточками
 * (разными штрихкодами), а физически на складе один и тот же товар. Комплект -
 * обычный wms.items с kit_of_item_id+kit_multiplier (см. migration 022).
 *
 * Списывает qty*kit_multiplier единиц базового товара с указанной ячейки,
 * зачисляет qty единиц комплекта на ту же ячейку - одной атомарной операцией
 * (movement_type='assembly'). После этого комплект - обычный физический
 * остаток: сборка/упаковка/отгрузка/распределение по складам WB работают с
 * ним точно так же, как с любым другим товаром, без специальной логики.
 */
async function assembleKit({ tenantId, warehouseId, clientId, kitItemId, qty, locationCode, userId, comment }) {
  const q = validateQty(qty, 'qty');

  const result = await transaction(async (client) => {
    const kitRes = await client.query(
      `SELECT id, barcode, item_name, kit_of_item_id, kit_multiplier FROM wms.items
       WHERE id=$1 AND tenant_id=$2 AND client_id=$3`,
      [kitItemId, tenantId, clientId]
    );
    if (kitRes.rowCount === 0) throw new NotFoundError('Item', kitItemId);
    const kit = kitRes.rows[0];
    if (!kit.kit_of_item_id) {
      throw new ValidationError('Этот товар не настроен как комплект (не указан базовый товар в карточке)');
    }

    const baseRes = await client.query(
      `SELECT id, barcode, item_name FROM wms.items WHERE id=$1 AND tenant_id=$2 AND client_id=$3`,
      [kit.kit_of_item_id, tenantId, clientId]
    );
    if (baseRes.rowCount === 0) throw new NotFoundError('Base item', kit.kit_of_item_id);
    const base = baseRes.rows[0];

    const loc = await getLocationByCode({ tenantId, warehouseId, locationCode });
    const baseQtyNeeded = q * Number(kit.kit_multiplier);

    // Проверяем остаток базового товара WITH LOCK
    const balRes = await client.query(
      `SELECT qty_available, avg_cost FROM wms.stock_balances
       WHERE tenant_id=$1 AND warehouse_id=$2 AND client_id=$3 AND item_id=$4 AND location_id=$5
       FOR UPDATE`,
      [tenantId, warehouseId, clientId, base.id, loc.id]
    );
    const available = balRes.rowCount > 0 ? Number(balRes.rows[0].qty_available) : 0;
    if (available < baseQtyNeeded) throw new InsufficientStockError(available, baseQtyNeeded, base.id, loc.id);
    const avgCost = balRes.rowCount > 0 ? balRes.rows[0].avg_cost : null;

    const commentText = comment || `Сборка: ${q} шт. комплекта из ${baseQtyNeeded} шт. базового товара`;

    // Списываем базовый товар
    await client.query(
      `INSERT INTO wms.stock_movements
         (tenant_id,warehouse_id,client_id,item_id,barcode,movement_type,qty,
          from_location_id,from_location_code,ref_type,ref_id,user_id,comment)
       VALUES($1,$2,$3,$4,$5,'assembly',$6,$7,$8,'item',$9,$10,$11)`,
      [tenantId, warehouseId, clientId, base.id, base.barcode, -baseQtyNeeded,
       loc.id, loc.location_code, kit.id, userId, commentText]
    );
    await client.query(
      `SELECT * FROM wms.apply_stock_movement($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, warehouseId, clientId, base.id, loc.id, base.barcode, -baseQtyNeeded, null]
    );

    // Зачисляем комплект
    await client.query(
      `INSERT INTO wms.stock_movements
         (tenant_id,warehouse_id,client_id,item_id,barcode,movement_type,qty,
          to_location_id,to_location_code,ref_type,ref_id,user_id,comment)
       VALUES($1,$2,$3,$4,$5,'assembly',$6,$7,$8,'item',$9,$10,$11)`,
      [tenantId, warehouseId, clientId, kit.id, kit.barcode, q,
       loc.id, loc.location_code, base.id, userId, commentText]
    );
    await client.query(
      `SELECT * FROM wms.apply_stock_movement($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, warehouseId, clientId, kit.id, loc.id, kit.barcode, q, avgCost]
    );

    logger.info({ tenantId, clientId, kitItemId: kit.id, baseItemId: base.id, qty: q, baseQtyNeeded, locationCode: loc.location_code }, 'Kit assembled');

    return {
      kitItemId: kit.id, kitItemName: kit.item_name, kitBarcode: kit.barcode,
      baseItemId: base.id, baseItemName: base.item_name, baseBarcode: base.barcode,
      qtyAssembled: q, baseQtyUsed: baseQtyNeeded, locationCode: loc.location_code,
    };
  });

  // Состав остатков изменился так, как WB сам узнать не мог (комплект
  // прибыл, базовый товар убыл) - пересчитываем распределение по складам WB.
  // Только по этим двум штрихкодам (см. комментарий в wb.service.js).
  triggerRedistributionForClient({ tenantId, clientId, barcodes: [result.kitBarcode, result.baseBarcode] });

  return result;
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
  assembleKit,
};
