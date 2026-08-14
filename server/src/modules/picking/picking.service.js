'use strict';

const { query, transaction } = require('../../config/database');
const ledger = require('../stock/stock.ledger');
const { resolveOrCreateItem } = require('../masterdata/items/items.service');
const { findBestPickLocation, getLocationByCode } = require('../masterdata/locations/locations.service');
const { NotFoundError, ValidationError, ForbiddenError, ConflictError, InsufficientStockError } = require('../../utils/errors');
const { validateBarcode, validateQty, validatePositiveInt, isValidKizCode } = require('../../utils/validators');
const { generateShipmentLabelSvg } = require('../../utils/qrcode');
const { resolvePrinter } = require('../printing/printerResolver');
const { chargeForOperation } = require('../billing/billing.service');
const logger = require('../../utils/logger');

// =============================================================================
// Picking Service — Waves + Tasks + Scan flows
// =============================================================================

/**
 * Порядок обхода склада по коду ячейки вида "A-<ряд>-<позиция>" (например
 * A-01-01 .. A-01-20) — где буква это стеллаж/зона, второе число это ряд
 * (уровень полки по высоте, набор для одной точки прохода), третье число —
 * позиция ВДОЛЬ стеллажа. Идти нужно по позиции (это и есть ходьба вдоль
 * стеллажа), а ряд (высоту полки) можно взять "по пути" не отходя в сторону —
 * поэтому позиция первична, ряд вторичен. Простая сортировка по строке кода
 * дала бы обратный эффект (сначала весь ряд 01 по всем позициям, потом
 * заново от начала ряд 02) — то самое хождение туда-обратно, от которого
 * уходим. Коды, не подходящие под этот шаблон (буферные/технические ячейки
 * вроде SBORKA-01, PRM-01) сортируются как есть, отдельным блоком после
 * "настоящих" стеллажных ячеек.
 */
function locationWalkKey(code) {
  const raw = String(code || '').trim().toUpperCase();
  const m = /^([A-ZА-Я]+)-(\d+)-(\d+)$/.exec(raw);
  if (!m) return { pattern: false, raw };
  return { pattern: true, zone: m[1], row: parseInt(m[2], 10), position: parseInt(m[3], 10) };
}
function compareWalkKeys(a, b) {
  if (a.pattern && b.pattern) {
    if (a.zone !== b.zone) return a.zone < b.zone ? -1 : 1;
    if (a.position !== b.position) return a.position - b.position;
    return a.row - b.row;
  }
  if (a.pattern !== b.pattern) return a.pattern ? -1 : 1;
  return a.raw < b.raw ? -1 : (a.raw > b.raw ? 1 : 0);
}

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
       t.warehouse_id, t.client_id, t.item_id,
       i.item_name, i.vendor_code, i.size, i.preview_url,
       i.requires_marking, i.marking_mode
     FROM wms.picking_tasks t
     LEFT JOIN wms.items i ON i.id=t.item_id
     WHERE t.tenant_id=$1 AND t.picker_id=$2 AND t.status='in_progress'
       AND ($3::text IS NULL OR t.shipment_code=$3)
     ORDER BY t.id LIMIT 1`,
    [tenantId, pickerId, shipmentCode||null]
  );
  if (inProg.rowCount > 0) {
    const task = inProg.rows[0];
    // Задачу могли взять в работу, когда товара ещё нигде не было на складе
    // (ячейка тогда осталась пустой, "—"). Раньше ячейка так и оставалась
    // пустой навсегда, даже после того, как товар приняли через приёмку —
    // потому что для уже in_progress задачи повторный поиск ячейки никогда
    // не запускался. Теперь при каждом обращении к задаче без ячейки пробуем
    // найти её заново — как только товар появится на любой ячейке, сборщик
    // увидит её без необходимости пересоздавать волну.
    if (!task.location_code && task.item_id) {
      const resolved = await transaction(async (client) => {
        const best = await findBestPickLocation({
          tenantId, warehouseId: task.warehouse_id,
          itemId: task.item_id, clientId: task.client_id,
        });
        if (!best) return null;
        const loc = await getLocationByCode({ tenantId, warehouseId: task.warehouse_id, locationCode: best.location_code }).catch(() => null);
        const locId = loc?.id || null;
        if (locId) {
          await ledger.reserveStock({
            tenantId, warehouseId: task.warehouse_id, clientId: task.client_id,
            itemId: task.item_id, locationId: locId, barcode: task.barcode,
            qty: Number(task.qty) - Number(task.qty_picked || 0),
            refType: 'picking_task', refId: task.id,
            dbClient: client,
          });
        }
        await client.query(
          `UPDATE wms.picking_tasks SET location_code=$1, updated_at=NOW() WHERE id=$2`,
          [best.location_code, task.id]
        );
        return best.location_code;
      });
      if (resolved) task.location_code = resolved;
    }
    return task;
  }

  // Берём новую задачу — среди ВСЕХ ещё не взятых задач этой волны (не только
  // самой старой по порядку создания), чтобы выбрать физически ближайшую по
  // ходу склада, а не следующую по порядку строк в заказе. См. locationWalkKey()
  // выше — идём по одному стеллажу от начала до конца, не возвращаясь.
  return transaction(async (client) => {
    const candidates = await client.query(
      `SELECT t.id, t.item_id, t.client_id, t.warehouse_id, t.location_code, t.priority, t.wave_id
       FROM wms.picking_tasks t
       WHERE t.tenant_id=$1 AND t.status='new'
         AND ($2::int IS NULL OR t.picker_id=$2)
         AND ($3::text IS NULL OR t.shipment_code=$3)
       ORDER BY t.priority ASC, t.id ASC
       FOR UPDATE SKIP LOCKED LIMIT 500`,
      [tenantId, pickerId||null, shipmentCode||null]
    );
    if (candidates.rowCount === 0) return null;

    // Внутри одной волны один и тот же товар часто нужен НЕСКОЛЬКИМ заказам
    // сразу. Если для этого товара в ЭТОЙ ЖЕ волне где-то уже зафиксирована
    // ячейка (у другой задачи — взятой, выполненной или ещё ожидающей) —
    // переиспользуем её, а не пересчитываем "лучшую по остаткам" заново.
    // Без этого ячейка для второго/третьего заказа на тот же товар могла
    // резолвиться иначе (остаток на ней тает после каждой брони), и
    // сборщика уводило в сторону, а потом возвращало обратно за тем же
    // товаром для другого заказа — "хождение туда-обратно" внутри волны.
    const pinnedMap = new Map(); // `${wave_id}:${item_id}` -> location_code
    const waveIds = [...new Set(candidates.rows.filter(c => !c.location_code && c.item_id && c.wave_id).map(c => c.wave_id))];
    const itemIds = [...new Set(candidates.rows.filter(c => !c.location_code && c.item_id && c.wave_id).map(c => c.item_id))];
    if (waveIds.length && itemIds.length) {
      const pinnedRes = await client.query(
        `SELECT DISTINCT ON (wave_id, item_id) wave_id, item_id, location_code
         FROM wms.picking_tasks
         WHERE tenant_id=$1 AND wave_id = ANY($2::bigint[]) AND item_id = ANY($3::int[])
           AND location_code IS NOT NULL
         ORDER BY wave_id, item_id, id ASC`,
        [tenantId, waveIds, itemIds]
      );
      for (const r of pinnedRes.rows) pinnedMap.set(`${r.wave_id}:${r.item_id}`, r.location_code);
    }

    // Для задач без заранее известной ячейки (и без "закреплённой" за товаром
    // в этой волне) подбираем лучшую (read-only, без резерва — резервируем
    // только ту задачу, которую реально выберем ниже) — чтобы можно было
    // сравнить их всех по физическому расположению. Идут по отдельным (не
    // транзакционным) коннектам из пула — параллельно, чтобы не держать
    // блокировку кандидатов дольше необходимого.
    const resolvedById = new Map();
    await Promise.all(candidates.rows.map(async (c) => {
      if (c.location_code) { resolvedById.set(c.id, { code: c.location_code, id: null }); return; }
      if (!c.item_id) { resolvedById.set(c.id, { code: null, id: null }); return; }
      const pinned = c.wave_id ? pinnedMap.get(`${c.wave_id}:${c.item_id}`) : null;
      if (pinned) { resolvedById.set(c.id, { code: pinned, id: null }); return; }
      const best = await findBestPickLocation({
        tenantId, warehouseId: c.warehouse_id, itemId: c.item_id, clientId: c.client_id,
      });
      resolvedById.set(c.id, best ? { code: best.location_code, id: best.location_id } : { code: null, id: null });
    }));

    let best = candidates.rows[0];
    let bestKey = locationWalkKey(resolvedById.get(best.id).code);
    for (const c of candidates.rows.slice(1)) {
      if (c.priority !== best.priority) continue; // приоритет главнее маршрута
      const key = locationWalkKey(resolvedById.get(c.id).code);
      if (compareWalkKeys(key, bestKey) < 0) { best = c; bestKey = key; }
    }
    const taskId = best.id;

    const taskRes = await client.query(
      `SELECT t.*, i.item_name, i.vendor_code, i.size, i.preview_url, i.requires_marking, i.marking_mode FROM wms.picking_tasks t
       LEFT JOIN wms.items i ON i.id=t.item_id
       WHERE t.id=$1`, [taskId]
    );
    const task = taskRes.rows[0];

    const preResolved = resolvedById.get(taskId);
    let locCode = task.location_code || preResolved?.code || null;
    let locId = preResolved?.id || null;
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
  let chargeClientId = null, chargeQty = 0;

  const result = await transaction(async (client) => {
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

    let matched = scanned === expected;
    let matchedVia = 'barcode';

    // Промаркированные товары (Честный знак): вместо обычного штрихкода можно
    // отсканировать сам киз конкретной единицы — если он числится в пуле
    // именно этого товара и ещё доступен (не использован раньше), засчитываем
    // забор одной единицы точно так же, как обычный скан штрихкода. Код при
    // этом НЕ помечается использованным — статус меняется только на упаковке
    // (см. consumeScannedCodeAtPacking), здесь только проверка принадлежности
    // к пулу. Для товаров без маркировки пул пуст — эта ветка просто не
    // сработает, обычное поведение не меняется.
    if (!matched && task.item_id && isValidKizCode(scanned)) {
      const kizRes = await client.query(
        `SELECT id FROM wms.marking_codes WHERE tenant_id=$1 AND item_id=$2 AND code=$3 AND status='available' LIMIT 1`,
        [tenantId, task.item_id, scanned]
      );
      if (kizRes.rowCount > 0) { matched = true; matchedVia = 'kiz'; }
    }

    if (!matched) {
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
      return { ok: true, result: 'ok', done: false, qty_picked: pickedQty, qty_total: qtyToPick, next_step: 'await_item', matched_via: matchedVia };
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

    chargeClientId = task.client_id;
    chargeQty = qtyToPick;

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

    return { ok: true, result: 'ok', done: true, qty_picked: qtyToPick, qty_total: qtyToPick, matched_via: matchedVia };
  });

  if (chargeClientId) {
    chargeForOperation({ tenantId, clientId: chargeClientId, serviceType: 'picking', quantity: chargeQty, refType: 'picking_task', refId: taskId });
  }

  return result;
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

/**
 * Пропущенные задания (для супервайзера/админа) — например, после того как по
 * задаче инвентаризации, созданной автоматически при пропуске, товар нашёлся
 * и остаток на ячейке подтверждён, но само задание сборки так и осталось
 * 'skipped' навсегда (skipTask его туда и не двигает обратно).
 */
async function listSkippedTasks({ tenantId, warehouseId = null, limit = 100 }) {
  const r = await query(
    `SELECT t.id, t.barcode, t.qty, t.location_code, t.shipment_code, t.wave_id,
       t.reason, t.comment, t.finished_at, t.warehouse_id,
       i.item_name,
       u.username AS picker_name,
       w.status AS wave_status,
       COALESCE(sb.qty_available, 0) AS qty_available_now
     FROM wms.picking_tasks t
     LEFT JOIN wms.items i ON i.id = t.item_id
     LEFT JOIN wms.users u ON u.id = t.picker_id
     LEFT JOIN wms.pick_waves w ON w.id = t.wave_id
     LEFT JOIN wms.locations l ON l.tenant_id = t.tenant_id
       AND l.warehouse_id = t.warehouse_id AND UPPER(l.location_code) = UPPER(t.location_code)
     LEFT JOIN wms.stock_balances sb ON sb.location_id = l.id
       AND sb.item_id = t.item_id AND sb.client_id = t.client_id
     WHERE t.tenant_id=$1 AND t.status='skipped'
       AND ($2::int IS NULL OR t.warehouse_id=$2)
     ORDER BY t.finished_at DESC
     LIMIT $3`,
    [tenantId, warehouseId, Math.min(limit, 200)]
  );
  return r.rows;
}

/**
 * Вернуть пропущенное задание обратно в сборку (только supervisor/tenant_admin —
 * не сам сборщик, чтобы не получилось "пропустил → сразу вернул себе то же самое").
 * Сбрасывает задание в статус 'new' в той же волне; если волна уже успела стать
 * 'ready' (потому что при пропуске remaining считался без учёта skipped), возвращает
 * её обратно в 'active', иначе закрыть волну с недобранной позицией будет нельзя.
 */
async function requeueSkippedTask({ tenantId, taskId, actorId }) {
  return transaction(async (client) => {
    const tRes = await client.query(
      `SELECT * FROM wms.picking_tasks WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
      [taskId, tenantId]
    );
    if (tRes.rowCount === 0) throw new NotFoundError('PickingTask', taskId);
    const task = tRes.rows[0];
    if (task.status !== 'skipped') {
      throw new ValidationError(`Вернуть в сборку можно только пропущенное задание (сейчас статус '${task.status}')`);
    }

    let wave = null;
    if (task.wave_id) {
      const wRes = await client.query(`SELECT * FROM wms.pick_waves WHERE id=$1 FOR UPDATE`, [task.wave_id]);
      wave = wRes.rows[0] || null;
      if (wave && wave.status === 'done') {
        throw new ValidationError(
          'Волна уже закрыта и короб передан на упаковку — вернуть это задание в сборку автоматически нельзя. Оформите недостающий товар отдельным ручным заказом.'
        );
      }
    }

    await client.query(
      `UPDATE wms.picking_tasks
       SET status='new', qty_picked=0, scan_step='await_location',
           reason=NULL, comment=NULL, started_at=NULL, finished_at=NULL,
           updated_at=NOW(), updated_by=$1
       WHERE id=$2`,
      [actorId, taskId]
    );

    if (wave && wave.status === 'ready') {
      await client.query(
        `UPDATE wms.pick_waves SET status='active', ready_at=NULL, updated_at=NOW() WHERE id=$1`,
        [wave.id]
      );
    }

    return { ok: true, taskId, waveId: task.wave_id || null };
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
        // Сначала рабочее место сборщика (если он привязан к зоне сборки со
        // своим принтером), иначе — общий маршрут pick_list_label как раньше.
        const resolved = await resolvePrinter(client.query.bind(client), {
          tenantId, docType: 'pick_list_label', employeeId: pickerId,
        });
        if (resolved) {
          const svg = await generateShipmentLabelSvg(shipmentCode);
          const jobCode = `PICKLIST-${shipment.id}-${Date.now()}`;
          await client.query(
            `INSERT INTO wms.print_jobs
               (tenant_id,job_code,printer_id,route_id,doc_type,entity_type,entity_id,copies,payload_json,status,created_by)
             VALUES($1,$2,$3,$4,'pick_list_label','shipment',$5,1,$6::jsonb,'new',$7)`,
            [
              tenantId, jobCode, resolved.printerId, resolved.routeId, shipment.id,
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
  listSkippedTasks, requeueSkippedTask,
  closeWave, getWaveStatus,
  createManualWave,
};
