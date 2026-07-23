'use strict';

const { query, transaction } = require('../../config/database');
const ledger = require('../stock/stock.ledger');
const { resolveOrCreateItem } = require('../masterdata/items/items.service');
const { findBestPickLocation, getLocationByCode } = require('../masterdata/locations/locations.service');
const { NotFoundError, ValidationError, ForbiddenError, ConflictError, InsufficientStockError } = require('../../utils/errors');
const { validateBarcode, validateQty, validatePositiveInt } = require('../../utils/validators');
const { generateQrSvg } = require('../../utils/qrcode');
const logger = require('../../utils/logger');

// =============================================================================
// Picking Service — Waves + Tasks + Scan flows
// =============================================================================

// ===== WAVES =====

async function listWaves({ tenantId, warehouseId = null, status = null, pickerId = null, limit = 50 }) {
  const params = [tenantId]; const conds = ['w.tenant_id=$1']; let idx = 2;
  if (warehouseId) { conds.push(`w.warehouse_id=$${idx++}`); params.push(warehouseId); }
  if (status)      { conds.push(`w.status=$${idx++}`); params.push(status); }
  if (pickerId)    { conds.push(`w.picker_id=$${idx++}`); params.push(pickerId); }
  params.push(Math.min(limit, 200));
  const r = await query(
    `SELECT w.*,
       u.username AS picker_name,
       (SELECT COUNT(*)::int FROM wms.picking_tasks t WHERE t.wave_id=w.id) AS task_count,
       (SELECT COUNT(*)::int FROM wms.picking_tasks t WHERE t.wave_id=w.id AND t.status='done') AS done_count
     FROM wms.pick_waves w
     LEFT JOIN wms.users u ON u.id=w.picker_id
     WHERE ${conds.join(' AND ')} ORDER BY w.created_at DESC LIMIT $${idx}`,
    params
  );
  return r.rows;
}

async function getWaveByShipmentCode({ tenantId, shipmentCode }) {
  const r = await query(
    `SELECT w.*, u.username AS picker_name,
       (SELECT COUNT(*)::int FROM wms.picking_tasks t WHERE t.wave_id=w.id) AS task_count,
       (SELECT COUNT(*)::int FROM wms.picking_tasks t WHERE t.wave_id=w.id AND t.status='done') AS done_count
     FROM wms.pick_waves w LEFT JOIN wms.users u ON u.id=w.picker_id
     WHERE w.tenant_id=$1 AND w.shipment_code=$2 LIMIT 1`,
    [tenantId, shipmentCode]
  );
  if (r.rowCount === 0) throw new NotFoundError(`Wave for shipment '${shipmentCode}'`);
  return r.rows[0];
}

/** Взять волну (picker берёт в работу) */
async function takeWave({ tenantId, pickerId }) {
  return transaction(async (client) => {
    // Проверяем активную волну ВНУТРИ транзакции с блокировкой
    // чтобы избежать race condition при параллельных вызовах от одного picker
    const active = await client.query(
      `SELECT id, shipment_code, status FROM wms.pick_waves
       WHERE tenant_id=$1 AND picker_id=$2 AND status IN ('active','offered')
       LIMIT 1
       FOR UPDATE`,
      [tenantId, pickerId]
    );
    if (active.rowCount > 0) return { has_wave: true, wave: active.rows[0] };

    // Берём первую свободную 'open' волну FOR UPDATE SKIP LOCKED
    const open = await client.query(
      `SELECT id, shipment_code, client_id, warehouse_id
       FROM wms.pick_waves
       WHERE tenant_id=$1 AND status='open' AND picker_id IS NULL
         AND EXISTS (
           SELECT 1 FROM wms.picking_tasks t
           WHERE t.wave_id=wms.pick_waves.id AND t.status='new'
         )
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED LIMIT 1`,
      [tenantId]
    );
    if (open.rowCount === 0) return { has_wave: false };

    const wave = open.rows[0];
    await client.query(
      `UPDATE wms.pick_waves SET status='active', picker_id=$1, accepted_at=NOW(), updated_at=NOW()
       WHERE id=$2`,
      [pickerId, wave.id]
    );
    // Назначаем задачи
    await client.query(
      `UPDATE wms.picking_tasks SET picker_id=$1, updated_at=NOW(), updated_by=$1
       WHERE wave_id=$2 AND status='new'`,
      [pickerId, wave.id]
    );
    return { has_wave: true, wave: { ...wave, status: 'active' } };
  });
}

/** Следующая задача для picker'а */
async function getNextTask({ tenantId, pickerId, shipmentCode }) {
  // Сначала — задача в in_progress у этого picker
  const inProg = await query(
    `SELECT t.id, t.barcode, t.qty, t.qty_picked, t.scan_step,
       t.location_code, t.shipment_code, t.wave_id, t.wb_order_id,
       i.item_name, i.preview_url
     FROM wms.picking_tasks t
     LEFT JOIN wms.items i ON i.id=t.item_id
     WHERE t.tenant_id=$1 AND t.picker_id=$2 AND t.status='in_progress'
       AND ($3::text IS NULL OR t.shipment_code=$3)
     ORDER BY t.id LIMIT 1`,
    [tenantId, pickerId, shipmentCode||null]
  );
  if (inProg.rowCount > 0) return inProg.rows[0];

  // Берём новую задачу
  return transaction(async (client) => {
    const newTask = await client.query(
      `SELECT t.id FROM wms.picking_tasks t
       WHERE t.tenant_id=$1 AND t.status='new'
         AND ($2::int IS NULL OR t.picker_id=$2)
         AND ($3::text IS NULL OR t.shipment_code=$3)
       ORDER BY t.priority ASC, t.id ASC
       FOR UPDATE SKIP LOCKED LIMIT 1`,
      [tenantId, pickerId||null, shipmentCode||null]
    );
    if (newTask.rowCount === 0) return null;

    const taskId = newTask.rows[0].id;

    // Ищем лучшую ячейку если не заполнена
    const taskRes = await client.query(
      `SELECT t.*, i.item_name, i.preview_url FROM wms.picking_tasks t
       LEFT JOIN wms.items i ON i.id=t.item_id
       WHERE t.id=$1`, [taskId]
    );
    const task = taskRes.rows[0];

    let locCode = task.location_code;
    let locId = null;
    if (!locCode && task.item_id) {
      const best = await findBestPickLocation({
        tenantId, warehouseId: task.warehouse_id,
        itemId: task.item_id, clientId: task.client_id,
      });
      if (best) { locCode = best.location_code; locId = best.location_id; }
    }
    if (locCode && !locId) {
      const loc = await getLocationByCode({ tenantId, warehouseId: task.warehouse_id, locationCode: locCode }).catch(() => null);
      locId = loc?.id || null;
    }

    // Резервируем остаток на этой ячейке под эту задачу — чтобы другой сборщик
    // не мог одновременно претендовать на тот же последний остаток. Если резерва
    // не хватает (например, физически на ячейке меньше, чем нужно задаче) —
    // reserveStock сама логирует и возвращает null, задачу это не блокирует.
    if (locId && task.item_id) {
      await ledger.reserveStock({
        tenantId, warehouseId: task.warehouse_id, clientId: task.client_id,
        itemId: task.item_id, locationId: locId, barcode: task.barcode,
        qty: Number(task.qty) - Number(task.qty_picked || 0),
        refType: 'picking_task', refId: taskId,
        dbClient: client,
      });
    }

    await client.query(
      `UPDATE wms.picking_tasks
       SET status='in_progress', picker_id=$1, started_at=NOW(),
           location_code=COALESCE($2, location_code),
           scan_step='await_location', updated_at=NOW(), updated_by=$1
       WHERE id=$3`,
      [pickerId, locCode, taskId]
    );

    return { ...task, status: 'in_progress', location_code: locCode, scan_step: 'await_location' };
  });
}

/** Скан ячейки */
async function scanLocation({ tenantId, pickerId, taskId, scannedLocationCode }) {
  return transaction(async (client) => {
    const tRes = await client.query(
      `SELECT * FROM wms.picking_tasks WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [taskId, tenantId]
    );
    if (tRes.rowCount === 0) throw new NotFoundError('PickingTask', taskId);
    const task = tRes.rows[0];
    if (task.status !== 'in_progress') throw new ValidationError(`Task status is '${task.status}', expected in_progress`);
    if (Number(task.picker_id) !== pickerId) throw new ForbiddenError('This task belongs to another picker');
    if (task.scan_step !== 'await_location') throw new ValidationError(`Expected scan_step='await_location', got '${task.scan_step}'`);

    const scanned = String(scannedLocationCode || '').trim().toUpperCase();
    const expected = String(task.location_code || '').trim().toUpperCase();

    if (expected && scanned !== expected) {
      // Логируем промах
      await client.query(
        `INSERT INTO wms.picking_scans(picking_task_id,picker_id,scan_type,expected,scanned,result,message)
         VALUES($1,$2,'location',$3,$4,'mismatch','Wrong location')`,
        [taskId, pickerId, task.location_code, scannedLocationCode]
      );
      return { ok: false, result: 'mismatch', expected: task.location_code, scanned: scannedLocationCode };
    }

    // Если ячейка не была задана — фиксируем канонический (uppercase) код,
    // а не сырой ввод — иначе следующий SELECT по location_code (например,
    // при списании остатка в scanItem) не найдёт ячейку из-за регистра.
    await client.query(
      `UPDATE wms.picking_tasks SET scan_step='await_item', location_code=COALESCE($1,location_code), updated_at=NOW() WHERE id=$2`,
      [scanned || null, taskId]
    );
    await client.query(
      `INSERT INTO wms.picking_scans(picking_task_id,picker_id,scan_type,expected,scanned,result) VALUES($1,$2,'location',$3,$4,'ok')`,
      [taskId, pickerId, task.location_code||scannedLocationCode, scannedLocationCode]
    );
    return { ok: true, result: 'ok', next_step: 'await_item' };
  });
}

/** Скан товара */
async function scanItem({ tenantId, pickerId, taskId, scannedBarcode, comment }) {
  return transaction(async (client) => {
    const tRes = await client.query(
      `SELECT * FROM wms.picking_tasks WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [taskId, tenantId]
    );
    if (tRes.rowCount === 0) throw new NotFoundError('PickingTask', taskId);
    const task = tRes.rows[0];

    if (task.status !== 'in_progress') throw new ValidationError(`Task status is '${task.status}'`);
    if (Number(task.picker_id) !== pickerId) throw new ForbiddenError('Not your task');
    if (task.scan_step !== 'await_item') throw new ValidationError(`Expected scan_step='await_item', got '${task.scan_step}'`);

    const expected = String(task.barcode || '').trim();
    const scanned  = String(scannedBarcode || '').trim();

    if (scanned !== expected) {
      await client.query(
        `INSERT INTO wms.picking_scans(picking_task_id,picker_id,scan_type,expected,scanned,result,message) VALUES($1,$2,'item',$3,$4,'mismatch','Wrong barcode')`,
        [taskId, pickerId, expected, scanned]
      );
      return { ok: false, result: 'mismatch', expected, scanned };
    }

    const qtyToPick = Number(task.qty);
    let pickedQty = Number(task.qty_picked || 0) + 1;
    if (pickedQty > qtyToPick) pickedQty = qtyToPick;

    // Если ещё не все — просто обновляем прогресс
    if (pickedQty < qtyToPick) {
      await client.query(
        `UPDATE wms.picking_tasks SET qty_picked=$1, updated_at=NOW() WHERE id=$2`,
        [pickedQty, taskId]
      );
      await client.query(
        `INSERT INTO wms.picking_scans(picking_task_id,picker_id,scan_type,expected,scanned,result) VALUES($1,$2,'item',$3,$4,'ok')`,
        [taskId, pickerId, expected, scanned]
      );
      return { ok: true, result: 'ok', done: false, qty_picked: pickedQty, qty_total: qtyToPick, next_step: 'await_item' };
    }

    // Все отсканированы — списываем со склада
    const locCode = task.location_code;
    if (!locCode) throw new ValidationError('Location code is not set for this task');

    // Ищем location_id
    const locRes = await client.query(
      `SELECT id FROM wms.locations WHERE tenant_id=$1 AND location_code=$2 AND is_active=TRUE LIMIT 1`,
      [tenantId, locCode]
    );
    if (locRes.rowCount === 0) throw new ValidationError(`Location '${locCode}' not found or inactive`);

    // Снимаем резерв ДО списания: qty_available у ячейки учитывает qty_reserved,
    // а резерв на эту же задачу как раз "съедал" доступность, которую сейчас
    // будет проверять consumeStock. Снимаем как 'fulfilled' — резерв дошёл до цели.
    await ledger.releaseReservationByRef({ refType: 'picking_task', refId: taskId, status: 'fulfilled', dbClient: client });

    await ledger.consumeStock({
      tenantId, warehouseId: task.warehouse_id, clientId: task.client_id,
      barcode: expected, itemId: task.item_id,
      locationId: locRes.rows[0].id, locationCode: locCode,
      qty: qtyToPick, movementType: 'picking',
      refType: 'picking_task', refId: taskId,
      userId: pickerId, comment: comment||null, dbClient: client,
    });

    await client.query(
      `UPDATE wms.picking_tasks
       SET status='done', scan_step='done', qty_picked=$1, finished_at=NOW(), updated_at=NOW(), updated_by=$2
       WHERE id=$3`,
      [qtyToPick, pickerId, taskId]
    );
    await client.query(
      `INSERT INTO wms.picking_scans(picking_task_id,picker_id,scan_type,expected,scanned,result) VALUES($1,$2,'item',$3,$4,'ok')`,
      [taskId, pickerId, expected, scanned]
    );

    // Обновляем волну
    if (task.wave_id) {
      await client.query(
        `UPDATE wms.pick_waves SET done_tasks=done_tasks+1, updated_at=NOW() WHERE id=$1`,
        [task.wave_id]
      );
      // Проверяем — все ли задачи done?
      const progress = await client.query(
        `SELECT COUNT(*) FILTER(WHERE status!='done')::int AS remaining FROM wms.picking_tasks WHERE wave_id=$1`,
        [task.wave_id]
      );
      if (progress.rows[0].remaining === 0) {
        await client.query(
          `UPDATE wms.pick_waves SET status='ready', ready_at=NOW(), updated_at=NOW() WHERE id=$1`,
          [task.wave_id]
        );
      }
    }

    return { ok: true, result: 'ok', done: true, qty_picked: qtyToPick, qty_total: qtyToPick };
  });
}

/** Пропустить задачу (товар не найден) */
async function skipTask({ tenantId, pickerId, taskId, reason, comment }) {
  return transaction(async (client) => {
    const tRes = await client.query(
      `SELECT * FROM wms.picking_tasks WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [taskId, tenantId]
    );
    if (tRes.rowCount === 0) throw new NotFoundError('PickingTask', taskId);
    const task = tRes.rows[0];
    if (task.status !== 'in_progress') throw new ValidationError('Can only skip in_progress tasks');
    if (Number(task.picker_id) !== pickerId) throw new ForbiddenError('Not your task');

    // Снимаем резерв — задача не будет собрана, ячейка больше не закреплена под неё
    await ledger.releaseReservationByRef({ refType: 'picking_task', refId: taskId, status: 'cancelled', dbClient: client });

    // Отменяем задачу
    await client.query(
      `UPDATE wms.picking_tasks SET status='skipped', reason=$1, comment=$2, finished_at=NOW(), updated_at=NOW()
       WHERE id=$3`,
      [reason||'not_found', comment||null, taskId]
    );

    // Создаём inventory task если есть ячейка
    let inventoryTaskId = null;
    if (task.barcode && task.location_code) {
      const existing = await client.query(
        `SELECT id FROM wms.inventory_tasks
         WHERE tenant_id=$1 AND barcode=$2 AND location_code=$3 AND status IN ('open','in_progress') LIMIT 1`,
        [tenantId, task.barcode, task.location_code]
      );
      if (existing.rowCount === 0) {
        const inv = await client.query(
          `INSERT INTO wms.inventory_tasks
             (tenant_id,warehouse_id,client_id,item_id,barcode,location_code,location_id,
              status,priority,reason,comment,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,'open',1,'picker_not_found',$8,$9)
           RETURNING id`,
          [tenantId, task.warehouse_id, task.client_id, task.item_id,
           task.barcode, task.location_code, task.location_id,
           comment||'Picker не нашёл товар', pickerId]
        );
        inventoryTaskId = inv.rows[0].id;
      } else {
        inventoryTaskId = existing.rows[0].id;
      }
    }

    // Обновляем волну — как в scanItem, иначе волна никогда не станет 'ready'
    if (task.wave_id) {
      const progress = await client.query(
        `SELECT COUNT(*) FILTER(WHERE status NOT IN ('done','skipped','cancelled'))::int AS remaining
         FROM wms.picking_tasks WHERE wave_id=$1`,
        [task.wave_id]
      );
      if (progress.rows[0].remaining === 0) {
        await client.query(
          `UPDATE wms.pick_waves SET status='ready', ready_at=NOW(), updated_at=NOW() WHERE id=$1`,
          [task.wave_id]
        );
      }
    }

    return { ok: true, taskId, inventoryTaskId };
  });
}

/** Закрыть волну (все задачи done + парковка короба) */
async function closeWave({ tenantId, pickerId, shipmentCode, bufferLocationCode }) {
  return transaction(async (client) => {
    const wRes = await client.query(
      `SELECT * FROM wms.pick_waves WHERE tenant_id=$1 AND shipment_code=$2 AND picker_id=$3 FOR UPDATE`,
      [tenantId, shipmentCode, pickerId]
    );
    if (wRes.rowCount === 0) throw new NotFoundError('Wave', shipmentCode);
    const wave = wRes.rows[0];
    if (!['active','ready'].includes(wave.status)) throw new ValidationError(`Cannot close wave in status '${wave.status}'`);

    const remaining = await client.query(
      `SELECT COUNT(*)::int AS n FROM wms.picking_tasks WHERE wave_id=$1 AND status NOT IN ('done','skipped','cancelled')`,
      [wave.id]
    );
    if (remaining.rows[0].n > 0) throw new ValidationError(`Cannot close wave: ${remaining.rows[0].n} tasks are not done`);

    // Короб можно парковать только в ячейку буферной зоны (МХ) — иначе сборщик
    // может отсканировать/вбить любую ячейку, какую увидит, и упаковщик потом
    // не найдёт короб там, где реально ищет (в буферной зоне).
    const code = String(bufferLocationCode || '').trim().toUpperCase();
    if (!code) throw new ValidationError('buffer_location_code is required');

    const bufLoc = await client.query(
      `SELECT id, location_type FROM wms.locations
       WHERE tenant_id=$1 AND warehouse_id=$2 AND UPPER(location_code)=$3 AND is_active=TRUE LIMIT 1`,
      [tenantId, wave.warehouse_id, code]
    );
    if (bufLoc.rowCount === 0) {
      throw new ValidationError(`Ячейка '${code}' не найдена на этом складе`);
    }
    if (bufLoc.rows[0].location_type !== 'buffer') {
      throw new ValidationError(
        `Ячейка '${code}' не является буферной зоной (МХ). Поставьте короб в ячейку с типом "МХ/буфер" и отсканируйте её.`
      );
    }
    const bufLocId = bufLoc.rows[0].id;

    await client.query(
      `UPDATE wms.pick_waves
       SET status='done', buffer_location_id=$1, buffer_location_code=$2, closed_at=NOW(), updated_at=NOW()
       WHERE id=$3`,
      [bufLocId, bufferLocationCode||null, wave.id]
    );

    // Передаём волну на упаковку — раньше на этом моменте всё и заканчивалось,
    // wms.packing_tasks нигде не заполнялся, и упаковщик никогда не видел эту
    // отгрузку. Теперь создаём задание на упаковку прямо здесь.
    const shipRes = await client.query(
      `SELECT id, warehouse_id, client_id FROM wms.shipments WHERE tenant_id=$1 AND external_id=$2 LIMIT 1`,
      [tenantId, shipmentCode]
    );
    let printJobCreated = false;
    if (shipRes.rowCount > 0) {
      const shipment = shipRes.rows[0];

      await client.query(
        `INSERT INTO wms.packing_tasks(tenant_id,warehouse_id,client_id,shipment_code,status,priority,comment,created_by,updated_by)
         VALUES($1,$2,$3,$4,'new',100,$5,$6,$6)`,
        [tenantId, shipment.warehouse_id, shipment.client_id, shipmentCode,
         bufferLocationCode ? `Забрать с МХ ${bufferLocationCode}` : null, pickerId]
      );

      // Внутренняя наклейка с кодом отгрузки — soft-fail, как и печать WB-стикеров:
      // ошибка печати не должна блокировать закрытие волны.
      try {
        const routeRes = await client.query(
          `SELECT pr.id, pr.printer_id FROM wms.printer_routes pr
           JOIN wms.printers p ON p.id=pr.printer_id
           WHERE pr.tenant_id=$1 AND pr.doc_type='pick_list_label' AND pr.is_active=TRUE AND p.is_active=TRUE
           ORDER BY pr.is_default DESC, pr.id LIMIT 1`,
          [tenantId]
        );
        if (routeRes.rowCount > 0) {
          const route = routeRes.rows[0];
          const svg = await generateQrSvg(shipmentCode);
          const jobCode = `PICKLIST-${shipment.id}-${Date.now()}`;
          await client.query(
            `INSERT INTO wms.print_jobs
               (tenant_id,job_code,printer_id,route_id,doc_type,entity_type,entity_id,copies,payload_json,status,created_by)
             VALUES($1,$2,$3,$4,'pick_list_label','shipment',$5,1,$6::jsonb,'new',$7)`,
            [
              tenantId, jobCode, route.printer_id, route.id, shipment.id,
              JSON.stringify({ sticker: svg, shipment_code: shipmentCode, buffer_location_code: bufferLocationCode || null }),
              pickerId,
            ]
          );
          printJobCreated = true;
        }
      } catch (err) {
        logger.warn({ err: err.message, shipmentCode }, 'Failed to create pick_list_label print job (non-fatal)');
      }
    }

    return { ok: true, shipmentCode, status: 'done', printJobCreated };
  });
}

/** Статус волны */
async function getWaveStatus({ tenantId, pickerId }) {
  const r = await query(
    `SELECT w.shipment_code, w.status, w.client_id,
       COUNT(t.id)::int AS total,
       COUNT(t.id) FILTER(WHERE t.status='done')::int AS done,
       COUNT(t.id) FILTER(WHERE t.status IN ('new','in_progress'))::int AS remaining
     FROM wms.pick_waves w
     LEFT JOIN wms.picking_tasks t ON t.wave_id=w.id
     WHERE w.tenant_id=$1 AND w.picker_id=$2 AND w.status IN ('active','ready')
     GROUP BY w.id ORDER BY w.created_at DESC LIMIT 1`,
    [tenantId, pickerId]
  );
  if (r.rowCount === 0) return { has_wave: false };
  return { has_wave: true, ...r.rows[0] };
}

// ===== РУЧНОЙ ЗАКАЗ (без маркетплейса) =====
// Ровно та же цель, что и wb.generateWave — отгрузка + волна + задачи на сборку,
// только без похода в WB API: заказ вводится вручную (свой магазин, звонок,
// клиент без WB и т.п.). Дальше по цепочке (сборка/упаковка/отгрузка) не
// отличается никак — эти экраны не знают и не спрашивают, откуда взялась волна.

/**
 * @param lines [{ barcode, qty }]
 */
async function createManualWave({ tenantId, warehouseId, clientId, externalId, lines, comment, createdById }) {
  if (!Array.isArray(lines) || !lines.length) {
    throw new ValidationError('lines is required and must be a non-empty array of {barcode, qty}');
  }

  const shipmentCode = (externalId && String(externalId).trim()) || `MANUAL-${Date.now()}`;

  return transaction(async (client) => {
    const dup = await client.query(
      `SELECT id FROM wms.shipments WHERE tenant_id=$1 AND external_id=$2`,
      [tenantId, shipmentCode]
    );
    if (dup.rowCount > 0) throw new ConflictError(`Shipment '${shipmentCode}' already exists`);

    let totalQty = 0;
    const resolvedLines = [];
    for (const line of lines) {
      const barcode = validateBarcode(line.barcode);
      const qty = validateQty(line.qty);
      const itemId = await resolveOrCreateItem({ tenantId, clientId, barcode, dbClient: client });
      resolvedLines.push({ barcode, qty, itemId });
      totalQty += qty;
    }

    await client.query(
      `INSERT INTO wms.shipments(tenant_id,warehouse_id,client_id,external_id,marketplace,status,total_planned_qty,created_by)
       VALUES($1,$2,$3,$4,'manual','new',$5,$6)`,
      [tenantId, warehouseId, clientId, shipmentCode, totalQty, createdById]
    );

    await client.query(
      `INSERT INTO wms.pick_waves(tenant_id,warehouse_id,client_id,shipment_code,status,total_tasks,notes,created_by)
       VALUES($1,$2,$3,$4,'open',$5,$6,$7)`,
      [tenantId, warehouseId, clientId, shipmentCode, resolvedLines.length, comment || null, createdById]
    );

    const waveRes = await client.query(
      `SELECT id FROM wms.pick_waves WHERE tenant_id=$1 AND shipment_code=$2`,
      [tenantId, shipmentCode]
    );
    const waveId = waveRes.rows[0].id;

    for (const line of resolvedLines) {
      await client.query(
        `INSERT INTO wms.picking_tasks
           (tenant_id,warehouse_id,client_id,wave_id,item_id,barcode,qty,status,priority,shipment_code,order_ref,created_by,updated_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,'new',3,$8,$9,$10,$10)`,
        [tenantId, warehouseId, clientId, waveId, line.itemId, line.barcode, line.qty, shipmentCode, externalId || null, createdById]
      );
    }

    return {
      shipment_code: shipmentCode,
      wave_id: waveId,
      tasks_created: resolvedLines.length,
      total_qty: totalQty,
    };
  });
}

module.exports = {
  listWaves, getWaveByShipmentCode, takeWave,
  getNextTask, scanLocation, scanItem, skipTask,
  closeWave, getWaveStatus,
  createManualWave,
};
