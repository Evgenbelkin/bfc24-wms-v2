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
const { triggerRedistributionForClient } = require('../wb/wb.service');
const logger = require('../../utils/logger');

const QUARANTINE_LOCATION_CODE = 'КАРАНТИН';

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
  // Первый сегмент — буква(ы) зоны + необязательное число ряда, слитно (A, A1, A12...)
  const m = /^([A-ZА-Я]+)(\d*)-(\d+)-(\d+)$/.exec(raw);
  if (!m) return { pattern: false, raw };
  return {
    pattern: true,
    zoneLetter: m[1],
    zoneNum: m[2] ? parseInt(m[2], 10) : null,
    row: parseInt(m[3], 10),
    position: parseInt(m[4], 10),
  };
}
function compareWalkKeys(a, b) {
  if (a.pattern && b.pattern) {
    if (a.zoneLetter !== b.zoneLetter) return a.zoneLetter < b.zoneLetter ? -1 : 1;
    const an = a.zoneNum === null ? -1 : a.zoneNum;
    const bn = b.zoneNum === null ? -1 : b.zoneNum;
    if (an !== bn) return an - bn;
    if (a.position !== b.position) return a.position - b.position;
    return a.row - b.row;
  }
  if (a.pattern !== b.pattern) return a.pattern ? -1 : 1;
  return a.raw < b.raw ? -1 : (a.raw > b.raw ? 1 : 0);
}

// =============================================================================
// Доработка #6 (01.09.2026): "сборка пачкой по количеству" — вместо скана
// каждой единицы товара по отдельности (qty раз), для однородных партий можно
// один раз отсканировать ячейку, один раз штрихкод и ввести количество.
//
// Рубильник тенанта — platform.tenants.settings->>'picking_batch_mode_enabled'
// (тот же паттерн, что settings.stock_sync_disabled у wms.mp_accounts, см.
// wb.router.js). Специально сделан через JSONB-флаг, а не через код/деплой —
// по явной просьбе (доработку делаем осторожно, должна быть возможность
// оперативно откатиться): включить/выключить — один UPDATE, без рестарта
// сервера, подхватывается на следующем же скане ячейки.
//
// Порог qty=1 — жёстко в коде (не настройка), закреплено явным решением
// пользователя при обсуждении. Товары с поштучной маркировкой (Честный знак,
// marking_mode='scan') из батч-режима исключены всегда — там каждая единица
// имеет свой уникальный код, вводом одного числа это не заменить.
// =============================================================================

async function isBatchModeEnabled(tenantId) {
  const r = await query(
    `SELECT COALESCE((settings->>'picking_batch_mode_enabled')::boolean, false) AS enabled
     FROM platform.tenants WHERE id=$1`,
    [tenantId]
  );
  return r.rowCount > 0 && r.rows[0].enabled === true;
}

function isBatchEligibleTask(task) {
  return Number(task.qty) > 1 && !(task.requires_marking && task.marking_mode === 'scan');
}

/**
 * Закрыть батч-задачу как недостачу: собрано меньше, чем нужно, и по системе
 * живьём подтверждено, что остатка больше нигде нет. В отличие от skipTask()
 * (карантин + инвентаризация "не найден") — здесь никакой мистики нет, система
 * сама только что пересчитала остаток, поэтому просто закрываем как 'skipped'
 * с reason='insufficient_stock' — попадает в тот же экран супервайзера
 * "Пропущенные задания" (listSkippedTasks/requeueSkippedTask), без изменений
 * там. qty_picked сохраняет то, что реально собрано (не 0) — чтобы наклейка
 * поставки (сумма qty_picked по волне) и биллинг считали честно.
 */
async function closeShortageTask(client, { taskId, task, comment, currentQtyPicked }) {
  await ledger.releaseReservationByRef({ refType: 'picking_task', refId: taskId, status: 'cancelled', dbClient: client });
  const msg = comment || `Собрано ${currentQtyPicked} из ${task.qty}, остатка на складе больше нет`;
  await client.query(
    `UPDATE wms.picking_tasks
     SET status='skipped', scan_step='done', reason='insufficient_stock', comment=$1,
         qty_picked=$2, finished_at=NOW(), updated_at=NOW()
     WHERE id=$3`,
    [msg, currentQtyPicked, taskId]
  );
  if (task.wave_id) {
    const progress = await client.query(
      `SELECT COUNT(*) FILTER(WHERE status NOT IN ('done','skipped','cancelled'))::int AS remaining
       FROM wms.picking_tasks WHERE wave_id=$1`,
      [task.wave_id]
    );
    if (progress.rows[0].remaining === 0) {
      await client.query(`UPDATE wms.pick_waves SET status='ready', ready_at=NOW(), updated_at=NOW() WHERE id=$1`, [task.wave_id]);
    }
  }
  return {
    ok: true, result: 'shortage', done: false, skipped: true,
    qty_picked: currentQtyPicked, qty_total: task.qty,
    message: `Собрано ${currentQtyPicked} из ${task.qty} — остатка на складе больше нет, недостача зафиксирована для супервайзера`,
  };
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
      if (pinned) {
        // РЕГРЕССИЯ (найдено по жалобе "сборка гонит в пустую ячейку"): после
        // перехода findBestPickLocation на примерный FIFO (сначала самая давно
        // нетронутая ячейка) она стала осознанно выбирать ячейки с МАЛЫМ
        // остатком (старый товар обычно почти распродан именно там - см.
        // комментарий в locations.service.js). Раньше сортировка "сначала
        // наибольший остаток" случайно гарантировала, что запиненная на первую
        // задачу ячейка хватит и на остальные заказы этой волны по тому же
        // товару. Теперь это НЕ гарантировано: 2-й, 3-й... заказ волны на тот
        // же товар слепо переиспользовал pinned-ячейку, даже если её уже
        // выбрали в ноль предыдущими сборщиками этой же волны - сборщика
        // отправляло в ячейку, где по системе тоже пусто. Проверяем остаток
        // ПРЯМО ПЕРЕД тем, как довериться пину; если он кончился - падаем в
        // обычный подбор лучшей ячейки ниже (FIFO сам возьмёт следующую по
        // старшинству, у которой остаток ещё есть).
        // Заодно та же проверка "карантина" (см. findBestPickLocation в
        // locations.service.js) - если по этой ячейке+товару уже открыта
        // задача инвентаризации из-за "не найден" (пусть и по другой задаче
        // этой же волны), пин на неё доверять нельзя, даже если сам остаток
        // формально ещё не обнулился.
        const pinnedStockRes = await query(
          `SELECT sb.qty_available FROM wms.stock_balances sb
           JOIN wms.locations l ON l.id = sb.location_id
           WHERE sb.tenant_id=$1 AND sb.warehouse_id=$2 AND sb.item_id=$3 AND sb.client_id=$4
             AND UPPER(l.location_code)=UPPER($5)
             AND NOT EXISTS (
               SELECT 1 FROM wms.inventory_tasks it
               WHERE it.tenant_id=sb.tenant_id AND it.item_id=sb.item_id AND it.location_id=l.id
                 AND it.status IN ('open','in_progress') AND it.reason='picker_not_found'
             )`,
          [tenantId, c.warehouse_id, c.item_id, c.client_id, pinned]
        );
        const pinnedHasStock = pinnedStockRes.rowCount > 0 && Number(pinnedStockRes.rows[0].qty_available) > 0;
        if (pinnedHasStock) { resolvedById.set(c.id, { code: pinned, id: null }); return; }
      }
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
      `SELECT t.*, i.requires_marking, i.marking_mode
       FROM wms.picking_tasks t
       LEFT JOIN wms.items i ON i.id = t.item_id
       WHERE t.id=$1 AND t.tenant_id=$2 FOR UPDATE OF t`, [taskId, tenantId]
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

    // Доработка #6: решаем, каким шагом идти дальше — обычным поштучным
    // сканом ('await_item', как было всегда) или новым шагом с вводом
    // количества ('await_item_qty'). Флаг тенанта проверяется здесь заново
    // при КАЖДОМ скане ячейки (не кэшируется) — это и есть мгновенный откат:
    // выключили в settings — на следующем же скане сборщик автоматически
    // вернётся на старый поштучный флоу, без рестарта сервера.
    const finalLocCode = scanned || expected || task.location_code;
    let nextStep = 'await_item';
    let batchAllowedQty = null;
    if (isBatchEligibleTask(task) && await isBatchModeEnabled(tenantId)) {
      nextStep = 'await_item_qty';
      const remaining = Number(task.qty) - Number(task.qty_picked || 0);
      const locRes = await client.query(
        `SELECT id FROM wms.locations WHERE tenant_id=$1 AND UPPER(location_code)=UPPER($2) AND is_active=TRUE LIMIT 1`,
        [tenantId, finalLocCode]
      );
      let availAtLoc = 0;
      if (locRes.rowCount > 0) {
        const balRes = await client.query(
          `SELECT qty_on_hand FROM wms.stock_balances
           WHERE tenant_id=$1 AND warehouse_id=$2 AND client_id=$3 AND item_id=$4 AND location_id=$5`,
          [tenantId, task.warehouse_id, task.client_id, task.item_id, locRes.rows[0].id]
        );
        // Берём qty_on_hand (физический остаток по этой ячейке+товару), а не
        // qty_available — под эту же задачу здесь уже стоит собственный
        // резерв (см. getNextTask/reserveStock), из-за которого qty_available
        // заведомо занижен ровно на него и показал бы сборщику меньше, чем
        // реально можно взять. Это только подсказка для UI — окончательная
        // проверка остатка всё равно происходит заново в scanItemQty().
        availAtLoc = balRes.rowCount > 0 ? Number(balRes.rows[0].qty_on_hand) : 0;
      }
      batchAllowedQty = Math.max(0, Math.min(availAtLoc, remaining));
    }

    // Если ячейка не была задана — фиксируем канонический (uppercase) код,
    // а не сырой ввод — иначе следующий SELECT по location_code (например,
    // при списании остатка в scanItem) не найдёт ячейку из-за регистра.
    await client.query(
      `UPDATE wms.picking_tasks SET scan_step=$1, location_code=COALESCE($2,location_code), updated_at=NOW() WHERE id=$3`,
      [nextStep, scanned || null, taskId]
    );
    await client.query(
      `INSERT INTO wms.picking_scans(picking_task_id,picker_id,scan_type,expected,scanned,result) VALUES($1,$2,'location',$3,$4,'ok')`,
      [taskId, pickerId, task.location_code||scannedLocationCode, scannedLocationCode]
    );
    return { ok: true, result: 'ok', next_step: nextStep, batch_allowed_qty: batchAllowedQty };
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

    // Снимаем резерв на этой задаче ПЕРЕД проверкой остатка. Пока резерв
    // активен, qty_available на ячейке уже уменьшен на него самого — если
    // проверять доступность до снятия, ровно "впритык" достаточный остаток
    // всегда выглядит как недостаточный (задача видит нехватку из-за
    // собственного же резерва), и сборщика кидает между двумя ячейками
    // бесконечно (12 → 32 → 12 → 32...), потому что на каждой из них по
    // очереди свежесозданный резерв этой же задачи "съедает" ровно то, что
    // требуется. Снимаем сразу — ниже, если решим списывать отсюда же,
    // это чисто техническая деталь аудита резервов.
    await ledger.releaseReservationByRef({ refType: 'picking_task', refId: taskId, status: 'cancelled', dbClient: client });

    // Ищем location_id
    const locRes = await client.query(
      `SELECT id FROM wms.locations WHERE tenant_id=$1 AND location_code=$2 AND is_active=TRUE LIMIT 1`,
      [tenantId, locCode]
    );
    if (locRes.rowCount === 0) throw new ValidationError(`Location '${locCode}' not found or inactive`);

    // Ячейка, к которой привязано задание, могла реально опустеть между тем,
    // как её подобрали (см. getNextTask/pinnedMap), и этим моментом -
    // например, её же забрал параллельно другой сборщик по другому заказу на
    // тот же товар в этой же волне (несколько заданий на один товар
    // "прикрепляются" к одной ячейке без учёта суммарной потребности всех
    // сразу). Теперь, когда собственный резерв уже снят, эта проверка
    // отражает истинную доступность, а не искажённую своим же резервом.
    const availRes = await client.query(
      `SELECT qty_available FROM wms.stock_balances
       WHERE tenant_id=$1 AND warehouse_id=$2 AND client_id=$3 AND item_id=$4 AND location_id=$5
       FOR UPDATE`,
      [tenantId, task.warehouse_id, task.client_id, task.item_id, locRes.rows[0].id]
    );
    const availAtLoc = availRes.rowCount > 0 ? Number(availRes.rows[0].qty_available) : 0;

    if (availAtLoc < qtyToPick && task.item_id) {
      const alt = await findBestPickLocation({
        tenantId, warehouseId: task.warehouse_id, itemId: task.item_id, clientId: task.client_id,
      });
      // findBestPickLocation читает вне этой транзакции — снимок мог чуть
      // устареть. Перед тем как реально перенаправлять туда сборщика,
      // перепроверяем доступность живым запросом в этой же транзакции
      // (FOR UPDATE), иначе рискуем перенаправить на ячейку, которая
      // на самом деле тоже недостаточна, и получить тот же бесконечный скачок.
      let altLocId = null, altAvail = 0;
      if (alt && alt.location_code !== locCode) {
        const altLocRes = await client.query(
          `SELECT id FROM wms.locations WHERE tenant_id=$1 AND location_code=$2 AND is_active=TRUE LIMIT 1`,
          [tenantId, alt.location_code]
        );
        if (altLocRes.rowCount > 0) {
          altLocId = altLocRes.rows[0].id;
          const altAvailRes = await client.query(
            `SELECT qty_available FROM wms.stock_balances
             WHERE tenant_id=$1 AND warehouse_id=$2 AND client_id=$3 AND item_id=$4 AND location_id=$5
             FOR UPDATE`,
            [tenantId, task.warehouse_id, task.client_id, task.item_id, altLocId]
          );
          altAvail = altAvailRes.rowCount > 0 ? Number(altAvailRes.rows[0].qty_available) : 0;
        }
      }

      if (altLocId && altAvail >= qtyToPick) {
        await ledger.reserveStock({
          tenantId, warehouseId: task.warehouse_id, clientId: task.client_id,
          itemId: task.item_id, locationId: altLocId, barcode: expected,
          qty: qtyToPick, refType: 'picking_task', refId: taskId, dbClient: client,
        });
        await client.query(
          `UPDATE wms.picking_tasks
           SET location_code=$1, scan_step='await_location', qty_picked=0, updated_at=NOW()
           WHERE id=$2`,
          [alt.location_code, taskId]
        );
        await client.query(
          `INSERT INTO wms.picking_scans(picking_task_id,picker_id,scan_type,expected,scanned,result,message)
           VALUES($1,$2,'item',$3,$4,'relocated',$5)`,
          [taskId, pickerId, expected, scanned, `Ячейка '${locCode}' пуста, перенаправлено на '${alt.location_code}'`]
        );
        return {
          ok: false, result: 'relocated',
          new_location_code: alt.location_code,
          message: `Ячейка ${locCode} пуста — товар нашёлся в ${alt.location_code}, идите туда`,
        };
      }

      // Реальной альтернативы нет — восстанавливаем резерв на исходной ячейке
      // (сняли его выше) и бросаем обычную ошибку, сборщику придётся
      // "Пропустить".
      await ledger.reserveStock({
        tenantId, warehouseId: task.warehouse_id, clientId: task.client_id,
        itemId: task.item_id, locationId: locRes.rows[0].id, barcode: expected,
        qty: qtyToPick, refType: 'picking_task', refId: taskId, dbClient: client,
      });
      throw new InsufficientStockError(availAtLoc, qtyToPick, task.item_id, locRes.rows[0].id);
    }

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

/**
 * Скан товара с вводом количества — доработка #6 ("сборка пачкой"). Работает
 * ТОЛЬКО когда scan_step='await_item_qty' (этот шаг ставит только scanLocation()
 * и только для батч-приемлемых задач при включённом рубильнике тенанта —
 * см. isBatchModeEnabled/isBatchEligibleTask выше). scanItem() (обычный
 * поштучный скан, шаг 'await_item') этой функцией никак не затронут и
 * продолжает работать как раньше для qty=1, маркированных товаров и
 * тенантов с выключенным рубильником.
 *
 * В отличие от scanItem() (где задача обязана целиком закрыться на одной
 * ячейке или целиком переехать на другую) — здесь "пачка" может быть МЕНЬШЕ
 * остатка, который нужен всего: списываем сколько реально ввели, и если не
 * хватило на весь qty — ведём сборщика на следующую ячейку с этим же товаром
 * (та же задача, id не меняется, qty_picked копится), а если остатков больше
 * нигде нет — закрываем задачу как 'skipped'/insufficient_stock (см.
 * closeShortageTask) — попадает в тот же экран супервайзера "Пропущенные".
 */
async function scanItemQty({ tenantId, pickerId, taskId, scannedBarcode, qty, comment }) {
  let chargeClientId = null, chargeQty = 0;

  const result = await transaction(async (client) => {
    const tRes = await client.query(
      `SELECT * FROM wms.picking_tasks WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [taskId, tenantId]
    );
    if (tRes.rowCount === 0) throw new NotFoundError('PickingTask', taskId);
    const task = tRes.rows[0];

    if (task.status !== 'in_progress') throw new ValidationError(`Task status is '${task.status}'`);
    if (Number(task.picker_id) !== pickerId) throw new ForbiddenError('Not your task');
    if (task.scan_step !== 'await_item_qty') throw new ValidationError(`Expected scan_step='await_item_qty', got '${task.scan_step}'`);

    const expected = String(task.barcode || '').trim();
    const scanned  = String(scannedBarcode || '').trim();

    let matched = scanned === expected;
    let matchedVia = 'barcode';
    // КИЗ-скан в батч-режиме теоретически не должен встречаться (см.
    // isBatchEligibleTask — маркированные scan-товары туда не попадают), но
    // проверку оставляем той же, что в scanItem — на случай если requires_marking
    // у товара поменяли уже ПОСЛЕ того, как задача перешла на этот шаг.
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

    const remaining = Number(task.qty) - Number(task.qty_picked || 0);
    const enteredQty = validatePositiveInt(qty, 'qty');
    if (enteredQty > remaining) {
      throw new ValidationError(`Нельзя ввести больше, чем нужно (осталось ${remaining} шт.)`);
    }

    const locCode = task.location_code;
    if (!locCode) throw new ValidationError('Location code is not set for this task');

    // Снимаем резерв ПЕРЕД проверкой остатка — та же причина, что в scanItem
    // (пока резерв активен, qty_available уже уменьшен на него самого, и
    // задача видит нехватку из-за собственного же резерва).
    await ledger.releaseReservationByRef({ refType: 'picking_task', refId: taskId, status: 'cancelled', dbClient: client });

    const locRes = await client.query(
      `SELECT id FROM wms.locations WHERE tenant_id=$1 AND location_code=$2 AND is_active=TRUE LIMIT 1`,
      [tenantId, locCode]
    );
    if (locRes.rowCount === 0) throw new ValidationError(`Location '${locCode}' not found or inactive`);

    const availRes = await client.query(
      `SELECT qty_available FROM wms.stock_balances
       WHERE tenant_id=$1 AND warehouse_id=$2 AND client_id=$3 AND item_id=$4 AND location_id=$5
       FOR UPDATE`,
      [tenantId, task.warehouse_id, task.client_id, task.item_id, locRes.rows[0].id]
    );
    const availAtLoc = availRes.rowCount > 0 ? Number(availRes.rows[0].qty_available) : 0;

    // Сколько реально можно списать с ЭТОЙ ячейки прямо сейчас — не больше,
    // чем показывает система, и не больше, чем ввёл сборщик (если физически
    // оказалось меньше — сборщик мог сам исправить число вниз при вводе).
    const takeQty = Math.min(enteredQty, availAtLoc);

    if (takeQty <= 0) {
      // На ячейке по факту пусто (например, увели параллельно под другую
      // задачу этой же волны на тот же товар) — пробуем перенаправить на
      // другую ячейку с этим товаром, как и в scanItem.
      const alt = task.item_id
        ? await findBestPickLocation({ tenantId, warehouseId: task.warehouse_id, itemId: task.item_id, clientId: task.client_id })
        : null;
      if (alt && alt.location_code !== locCode) {
        await ledger.reserveStock({
          tenantId, warehouseId: task.warehouse_id, clientId: task.client_id,
          itemId: task.item_id, locationId: alt.location_id, barcode: expected,
          qty: remaining, refType: 'picking_task', refId: taskId, dbClient: client,
        });
        await client.query(
          `UPDATE wms.picking_tasks SET location_code=$1, scan_step='await_location', updated_at=NOW() WHERE id=$2`,
          [alt.location_code, taskId]
        );
        await client.query(
          `INSERT INTO wms.picking_scans(picking_task_id,picker_id,scan_type,expected,scanned,result,message)
           VALUES($1,$2,'item',$3,$4,'relocated',$5)`,
          [taskId, pickerId, expected, scanned, `Ячейка '${locCode}' пуста, перенаправлено на '${alt.location_code}'`]
        );
        return {
          ok: false, result: 'relocated', new_location_code: alt.location_code,
          message: `Ячейка ${locCode} пуста — товар нашёлся в ${alt.location_code}, идите туда`,
        };
      }

      // Больше нигде нет — фиксируем то, что уже собрано (может быть и 0,
      // если это вообще первая ячейка задачи), остальное — в "Пропущенные".
      const closeRes = await closeShortageTask(client, {
        taskId, task, comment, currentQtyPicked: Number(task.qty_picked || 0),
      });
      if (Number(task.qty_picked || 0) > 0) {
        chargeClientId = task.client_id;
        chargeQty = Number(task.qty_picked || 0);
      }
      return closeRes;
    }

    await ledger.consumeStock({
      tenantId, warehouseId: task.warehouse_id, clientId: task.client_id,
      barcode: expected, itemId: task.item_id,
      locationId: locRes.rows[0].id, locationCode: locCode,
      qty: takeQty, movementType: 'picking',
      refType: 'picking_task', refId: taskId,
      userId: pickerId, comment: comment||null, dbClient: client,
    });

    const newPicked = Number(task.qty_picked || 0) + takeQty;

    await client.query(
      `INSERT INTO wms.picking_scans(picking_task_id,picker_id,scan_type,expected,scanned,result) VALUES($1,$2,'item',$3,$4,'ok')`,
      [taskId, pickerId, expected, scanned]
    );

    if (newPicked >= Number(task.qty)) {
      // Полностью собрано (возможно, за несколько ячеек).
      await client.query(
        `UPDATE wms.picking_tasks
         SET status='done', scan_step='done', qty_picked=$1, finished_at=NOW(), updated_at=NOW(), updated_by=$2
         WHERE id=$3`,
        [newPicked, pickerId, taskId]
      );
      if (task.wave_id) {
        await client.query(`UPDATE wms.pick_waves SET done_tasks=done_tasks+1, updated_at=NOW() WHERE id=$1`, [task.wave_id]);
        const progress = await client.query(
          `SELECT COUNT(*) FILTER(WHERE status!='done')::int AS remaining FROM wms.picking_tasks WHERE wave_id=$1`,
          [task.wave_id]
        );
        if (progress.rows[0].remaining === 0) {
          await client.query(`UPDATE wms.pick_waves SET status='ready', ready_at=NOW(), updated_at=NOW() WHERE id=$1`, [task.wave_id]);
        }
      }
      chargeClientId = task.client_id;
      chargeQty = newPicked;
      return { ok: true, result: 'ok', done: true, qty_picked: newPicked, qty_total: task.qty, matched_via: matchedVia };
    }

    // Пачка взята, но этого не хватило на весь qty — ищем следующую ячейку с
    // этим же товаром для остатка. Задача остаётся той же (id, in_progress),
    // qty_picked копится, ячейка/scan_step переставляются на новый круг.
    await client.query(
      `UPDATE wms.picking_tasks SET qty_picked=$1, updated_at=NOW() WHERE id=$2`,
      [newPicked, taskId]
    );

    const stillNeeded = Number(task.qty) - newPicked;
    const alt2 = task.item_id
      ? await findBestPickLocation({ tenantId, warehouseId: task.warehouse_id, itemId: task.item_id, clientId: task.client_id })
      : null;

    if (alt2) {
      await ledger.reserveStock({
        tenantId, warehouseId: task.warehouse_id, clientId: task.client_id,
        itemId: task.item_id, locationId: alt2.location_id, barcode: expected,
        qty: stillNeeded, refType: 'picking_task', refId: taskId, dbClient: client,
      });
      await client.query(
        `UPDATE wms.picking_tasks SET location_code=$1, scan_step='await_location', updated_at=NOW() WHERE id=$2`,
        [alt2.location_code, taskId]
      );
      return {
        ok: true, result: 'partial', done: false, qty_picked: newPicked, qty_total: task.qty,
        remaining: stillNeeded, new_location_code: alt2.location_code,
        message: `Собрано ${newPicked} из ${task.qty}. Ещё ${stillNeeded} шт — в ячейке ${alt2.location_code}`,
      };
    }

    // Остатков больше нигде нет вообще — закрываем задачу как недостачу.
    const closeRes2 = await closeShortageTask(client, {
      taskId, task, comment, currentQtyPicked: newPicked,
    });
    chargeClientId = task.client_id;
    chargeQty = newPicked;
    return closeRes2;
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

    // Создаём inventory task если есть ячейка.
    //
    // Карантин (шаг 2): если по системе в этой ячейке числится товар, которого
    // сборщик не нашёл, — считаем остаток "подозрительным" (фантомным) и сразу
    // физически переносим его ВЕСЬ (весь qty_on_hand по этой ячейке+товару) в
    // виртуальную карантинную ячейку склада (location_type='quarantine',
    // is_pick_location=FALSE). Благодаря этому флагу карантинный остаток
    // автоматически перестаёт быть доступным и для сборки (findBestPickLocation
    // фильтрует is_pick_location=TRUE), и для выгрузки в WB (та же фильтрация
    // в wb.service.js) — без единой правки в этих местах.
    //
    // Задачу инвентаризации создаём/обновляем НЕ на исходной ячейке (там после
    // переноса физически и по системе уже 0 — считать там больше нечего), а на
    // самой карантинной ячейке: qty_system = то, что реально там лежит. Так
    // пересчёт остаётся содержательным — подтвердили "нашли" (факт=система,
    // расхождения нет, дальше вручную перемещают из карантина обратно обычным
    // перемещением) или подтвердили "не нашли" (факт=0, излишек списывается
    // по инвентаризации прямо с карантинной ячейки).
    let inventoryTaskId = null;
    let quarantined = false;
    if (task.barcode && task.location_code) {
      let movedQty = 0;

      // wms.picking_tasks.location_id НИКОГДА не заполняется (ни при создании
      // волны, ни при взятии задания — везде пишется только текстовый
      // location_code, id резолвится ad-hoc где нужен) — поэтому task.location_id
      // всегда NULL, и проверка на него ниже раньше всегда проваливалась в
      // фолбэк, даже когда остаток на ячейке реально был. Резолвим id сами.
      const origLoc = task.item_id
        ? await getLocationByCode({ tenantId, warehouseId: task.warehouse_id, locationCode: task.location_code }).catch(() => null)
        : null;
      const origLocId = origLoc?.id || null;

      if (task.item_id && origLocId) {
        // qty_available (= qty_on_hand - qty_reserved) — а не весь qty_on_hand.
        // Часть остатка в этой же ячейке может быть уже зарезервирована под
        // ДРУГОЕ сборочное задание (другая волна, тот же товар) — её трогать
        // нельзя: apply_stock_movement уменьшает только qty_on_hand, и если
        // увести больше свободного, останется qty_reserved > qty_on_hand, что
        // запрещено constraint'ом balance_reserved_le_on_hand и уронит
        // транзакцию. В карантин уходит только то, что реально ничьё.
        const balRes = await client.query(
          `SELECT qty_on_hand, qty_available FROM wms.stock_balances
           WHERE tenant_id=$1 AND warehouse_id=$2 AND client_id=$3 AND item_id=$4 AND location_id=$5
           FOR UPDATE`,
          [tenantId, task.warehouse_id, task.client_id, task.item_id, origLocId]
        );
        const qtyFree = balRes.rowCount > 0 ? Number(balRes.rows[0].qty_available) : 0;

        if (qtyFree > 0) {
          const quarantineLoc = await getOrCreateQuarantineLocation(client, tenantId, task.warehouse_id, pickerId);

          await client.query(
            `INSERT INTO wms.stock_movements
               (tenant_id,warehouse_id,client_id,item_id,barcode,movement_type,qty,
                from_location_id,from_location_code,to_location_id,to_location_code,
                ref_type,ref_id,user_id,comment)
             VALUES($1,$2,$3,$4,$5,'move',$6,$7,$8,$9,$10,'picking_task',$11,$12,$13)`,
            [tenantId, task.warehouse_id, task.client_id, task.item_id, task.barcode, -qtyFree,
             origLocId, task.location_code, quarantineLoc.id, quarantineLoc.location_code,
             taskId, pickerId, 'Карантин: сборщик не нашёл товар']
          );
          await client.query(
            `SELECT * FROM wms.apply_stock_movement($1,$2,$3,$4,$5,$6,$7,$8)`,
            [tenantId, task.warehouse_id, task.client_id, task.item_id, origLocId, task.barcode, -qtyFree, null]
          );
          await client.query(
            `INSERT INTO wms.stock_movements
               (tenant_id,warehouse_id,client_id,item_id,barcode,movement_type,qty,
                from_location_id,from_location_code,to_location_id,to_location_code,
                ref_type,ref_id,user_id,comment)
             VALUES($1,$2,$3,$4,$5,'move',$6,$7,$8,$9,$10,'picking_task',$11,$12,$13)`,
            [tenantId, task.warehouse_id, task.client_id, task.item_id, task.barcode, qtyFree,
             origLocId, task.location_code, quarantineLoc.id, quarantineLoc.location_code,
             taskId, pickerId, 'Карантин: сборщик не нашёл товар']
          );
          const quarBal = await client.query(
            `SELECT * FROM wms.apply_stock_movement($1,$2,$3,$4,$5,$6,$7,$8)`,
            [tenantId, task.warehouse_id, task.client_id, task.item_id, quarantineLoc.id, task.barcode, qtyFree, null]
          );
          movedQty = Number(quarBal.rows[0].qty_on_hand);
          quarantined = true;

          const existingQuar = await client.query(
            `SELECT id FROM wms.inventory_tasks
             WHERE tenant_id=$1 AND item_id=$2 AND location_id=$3 AND status IN ('open','in_progress') LIMIT 1`,
            [tenantId, task.item_id, quarantineLoc.id]
          );
          if (existingQuar.rowCount === 0) {
            const inv = await client.query(
              `INSERT INTO wms.inventory_tasks
                 (tenant_id,warehouse_id,client_id,item_id,barcode,location_code,location_id,
                  qty_system,status,priority,reason,comment,created_by)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,'open',1,'picker_not_found',$9,$10)
               RETURNING id`,
              [tenantId, task.warehouse_id, task.client_id, task.item_id,
               task.barcode, quarantineLoc.location_code, quarantineLoc.id, movedQty,
               `${comment || 'Picker не нашёл товар'} (исходная ячейка: ${task.location_code})`, pickerId]
            );
            inventoryTaskId = inv.rows[0].id;
          } else {
            inventoryTaskId = existingQuar.rows[0].id;
            await client.query(
              `UPDATE wms.inventory_tasks SET qty_system=$1, updated_at=NOW() WHERE id=$2`,
              [movedQty, inventoryTaskId]
            );
          }
        }
      }

      // Фолбэк: нечего было переносить (нет привязки к товару в системе, или
      // остаток по этой ячейке уже 0/полностью зарезервирован) — оставляем
      // старое поведение (задача на исходной ячейке) как подстраховку на
      // случай "штрихкод в системе вообще не значится тут". qty_system всё
      // равно заполняем реальным остатком, если item_id/location_id известны —
      // раньше это поле оставалось NULL ("По системе: —"), и submitCount()
      // считал расхождение как факт-0, а не факт-реальный_остаток, из-за чего
      // ввод "0" при пересчёте ничего физически не списывал (баг: "инвентаризация
      // не удаляет товар из ячейки").
      if (!inventoryTaskId) {
        let fallbackQtySystem = null;
        if (task.item_id && origLocId) {
          const balRes2 = await client.query(
            `SELECT qty_on_hand FROM wms.stock_balances
             WHERE tenant_id=$1 AND warehouse_id=$2 AND client_id=$3 AND item_id=$4 AND location_id=$5`,
            [tenantId, task.warehouse_id, task.client_id, task.item_id, origLocId]
          );
          fallbackQtySystem = balRes2.rowCount > 0 ? Number(balRes2.rows[0].qty_on_hand) : 0;
        }
        const existing = await client.query(
          `SELECT id FROM wms.inventory_tasks
           WHERE tenant_id=$1 AND barcode=$2 AND location_code=$3 AND status IN ('open','in_progress') LIMIT 1`,
          [tenantId, task.barcode, task.location_code]
        );
        if (existing.rowCount === 0) {
          const inv = await client.query(
            `INSERT INTO wms.inventory_tasks
               (tenant_id,warehouse_id,client_id,item_id,barcode,location_code,location_id,
                qty_system,status,priority,reason,comment,created_by)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,'open',1,'picker_not_found',$9,$10)
             RETURNING id`,
            [tenantId, task.warehouse_id, task.client_id, task.item_id,
             task.barcode, task.location_code, origLocId, fallbackQtySystem,
             comment||'Picker не нашёл товар', pickerId]
          );
          inventoryTaskId = inv.rows[0].id;
        } else {
          inventoryTaskId = existing.rows[0].id;
        }
      }
    }

    // Авто-повтор в конце волны: если по факту пропуска остаток реально ушёл в
    // карантин (значит на исходной ячейке для этого товара сейчас 0), и по
    // системе есть тот же товар в ДРУГОЙ ячейке отбора (не карантин, не под
    // открытой инвентаризацией "не найден" — см. фильтры внутри
    // findBestPickLocation) — не оставляем задачу висеть 'skipped' до
    // ручного возврата супервайзером, а сразу переоткрываем её на новую
    // ячейку. Приоритет намеренно поднимаем выше остальных задач волны, чтобы
    // сборщик сначала прошёл весь обычный маршрут и только в конце вернулся
    // за этим товаром, а не прыгал туда-сюда посреди волны.
    // Если альтернативной ячейки с остатком нет — поведение как раньше:
    // задача остаётся 'skipped', и уже супервайзер решает (см.
    // requeueSkippedTask) после того как разберётся с самим карантином
    // (нашёлся товар — вернуть, не нашёлся — списать по инвентаризации).
    let requeued = false;
    if (quarantined && task.item_id) {
      const alt = await findBestPickLocation({
        tenantId, warehouseId: task.warehouse_id, itemId: task.item_id, clientId: task.client_id,
      });
      if (alt) {
        const prioRes = await client.query(
          `SELECT COALESCE(MAX(priority),0)+1 AS next_priority FROM wms.picking_tasks WHERE wave_id=$1`,
          [task.wave_id]
        );
        // scan_step - NOT NULL (см. 006_warehouse_flows.sql), а не NULL - когда
        // задачу возьмут заново, takeTask() всё равно принудительно ставит
        // 'await_location' (см. выше), так что значение здесь чисто "на всякий
        // случай, пока задача висит 'new'". Раньше тут стоял NULL - валил ВСЮ
        // транзакцию (карантин, инвентаризацию, снятие резерва) constraint'ом
        // NOT NULL и сборщик не мог пропустить товар вообще (500 на каждую
        // попытку, если для товара нашлась другая ячейка для авто-повтора).
        //
        // picker_id - ОСТАЁТСЯ тем же сборщиком (pickerId), а не NULL. Все
        // 'new'-задачи волны пиннятся на picker_id при takeWave() (см. выше) -
        // именно по этому полю getNextTask() фильтрует "мои" задачи волны
        // (t.picker_id=$2, БЕЗ варианта "или ничья"). Если тут обнулить -
        // задача формально снова 'new', но выпадает из выборки getNextTask
        // для этого сборщика насовсем (баг: "не выпадает новая ячейка после
        // пропуска", 31.08.2026 - пришлось бы супервайзеру вручную возвращать
        // через requeueSkippedTask).
        await client.query(
          `UPDATE wms.picking_tasks
           SET status='new', location_code=NULL, picker_id=$1, started_at=NULL,
               finished_at=NULL, scan_step='await_location', qty_picked=0, priority=$2, updated_at=NOW()
           WHERE id=$3`,
          [pickerId, prioRes.rows[0].next_priority, taskId]
        );
        requeued = true;
      }
    }

    // Обновляем волну — как в scanItem, иначе волна никогда не станет 'ready'.
    // Если requeued=true, задача снова 'new' и естественным образом попадёт
    // в remaining ниже — волна не станет 'ready', пока сборщик не дойдёт и до
    // неё (уже в конце маршрута, см. приоритет выше).
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

    return { ok: true, taskId, inventoryTaskId, quarantined, requeued, clientId: task.client_id, barcode: task.barcode };
  });

  // Перенос в карантин меняет qty_available в ячейках отбора (было в обычной
  // ячейке — стало в карантинной, is_pick_location=FALSE) — так же, как и
  // обычное перемещение (см. moveItem в movement.service.js), нужно сразу
  // пересчитать остаток, отдаваемый в WB, а не ждать следующего цикла синка.
  if (result.quarantined && result.barcode) {
    logger.info({ tenantId, barcode: result.barcode }, 'Skip→quarantine triggered WB redistribution');
    triggerRedistributionForClient({ tenantId, clientId: result.clientId, barcodes: [result.barcode] });
  }

  return { ok: true, taskId: result.taskId, inventoryTaskId: result.inventoryTaskId };
}

/**
 * Get-or-create виртуальной ячейки "КАРАНТИН" на складе — используется при
 * пропуске сборщика (skipTask), чтобы физически изолировать фантомный
 * остаток. is_pick_location=FALSE — этого одного флага достаточно, чтобы
 * ячейка автоматически перестала участвовать и в подборе (findBestPickLocation),
 * и в остатке, отдаваемом в WB (wb.service.js), без отдельных правок там.
 * location_type='quarantine' уже существует в wms.location_type (миграция 003).
 */
async function getOrCreateQuarantineLocation(client, tenantId, warehouseId, userId) {
  const existing = await client.query(
    `SELECT id, location_code FROM wms.locations
     WHERE tenant_id=$1 AND warehouse_id=$2 AND location_code=$3 LIMIT 1`,
    [tenantId, warehouseId, QUARANTINE_LOCATION_CODE]
  );
  if (existing.rowCount > 0) return existing.rows[0];

  const created = await client.query(
    `INSERT INTO wms.locations
       (tenant_id, warehouse_id, location_code, description, location_type, is_active, is_pick_location, created_by)
     VALUES ($1,$2,$3,'Карантин: спорные остатки после пропуска сборки','quarantine',TRUE,FALSE,$4)
     ON CONFLICT (tenant_id, warehouse_id, location_code) DO UPDATE SET location_code=EXCLUDED.location_code
     RETURNING id, location_code`,
    [tenantId, warehouseId, QUARANTINE_LOCATION_CODE, userId]
  );
  return created.rows[0];
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

    // location_code/location_id ОБЯЗАТЕЛЬНО в NULL, а не просто status='new':
    // при взятии задания кандидат с уже проставленной ячейкой переиспользуется
    // as-is, БЕЗ повторного подбора (см. resolvedById в claimNextTask — если
    // c.location_code уже есть, findBestPickLocation вообще не вызывается).
    // Если оставить старую ячейку, сборщика после карантина/инвентаризации
    // снова отправит в ту же (уже пустую) ячейку — тот же пропуск по кругу.
    // С NULL — при следующем взятии ячейка подбирается заново (findBestPickLocation
    // уже сам исключает и карантин, и обнулившиеся остатки).
    await client.query(
      `UPDATE wms.picking_tasks
       SET status='new', qty_picked=0, scan_step='await_location',
           location_code=NULL, location_id=NULL,
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
          // Кол-во ШК на наклейке — суммарно собрано по волне (qty_picked по
          // всем задачам, включая довезённые после реквеue) - то, что реально
          // физически лежит в коробе, а не сколько было задач/позиций.
          const qtyRes = await client.query(
            `SELECT COALESCE(SUM(qty_picked),0)::int AS qty FROM wms.picking_tasks WHERE wave_id=$1`,
            [wave.id]
          );
          const svg = await generateShipmentLabelSvg(shipmentCode, qtyRes.rows[0].qty);
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
  getNextTask, scanLocation, scanItem, scanItemQty, skipTask,
  listSkippedTasks, requeueSkippedTask,
  closeWave, getWaveStatus,
  createManualWave,
};
