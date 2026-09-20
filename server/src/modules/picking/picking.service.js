'use strict';

const { query, transaction } = require('../../config/database');
const ledger = require('../stock/stock.ledger');
const { resolveOrCreateItem, findItemIdByBarcode, resolveStockKey } = require('../masterdata/items/items.service');
const { findBestPickLocation, getLocationByCode } = require('../masterdata/locations/locations.service');
const { NotFoundError, ValidationError, ForbiddenError, ConflictError, InsufficientStockError } = require('../../utils/errors');
const { validateBarcode, validateQty, validatePositiveInt, isValidKizCode } = require('../../utils/validators');
const { generateShipmentLabelSvg } = require('../../utils/qrcode');
const { resolvePrinter } = require('../printing/printerResolver');
const { chargeForOperation } = require('../billing/billing.service');
const { triggerRedistributionForClient, moveOrderToDeficitSupply } = require('../wb/wb.service');
const wbClient = require('../wb/wb.client');
const { locationWalkKey, compareWalkKeys } = require('../../utils/warehouseLayout');
const logger = require('../../utils/logger');

const QUARANTINE_LOCATION_CODE = 'КАРАНТИН';

/**
 * Пул остатков (миграция 061) — короткий хелпер для мест этого файла, которые
 * читают/пишут wms.stock_balances НАПРЯМУЮ (не через wms.stock.ledger, тот уже
 * сам резолвит пул внутри себя). Возвращает {itemId, clientId}, куда физически
 * нужно смотреть/писать остаток — пуловые, если item с пулом связан, иначе
 * ровно то же task.item_id/task.client_id, что и раньше (для тенантов без
 * пулинга — поведение не меняется). НЕ использовать для полей самой задачи
 * (picking_tasks.item_id/client_id, биллинг, inventory_tasks для отображения
 * "чей это заказ") — там по-прежнему нужен настоящий клиент.
 */
async function _stockScope(tenantId, itemId, clientId, dbClient) {
  if (!itemId) return { itemId, clientId };
  const k = await resolveStockKey({ tenantId, itemId, clientId, dbClient });
  return { itemId: k.stockItemId, clientId: k.stockClientId };
}

// =============================================================================
// Picking Service — Waves + Tasks + Scan flows
//
// Порядок обхода склада по коду ячейки (locationWalkKey/compareWalkKeys) —
// см. server/src/utils/warehouseLayout.js (вынесено оттуда 01.09.2026, та же
// логика понадобилась и в placement.service.js для подсказки ячейки).
// =============================================================================

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
// Порог "нужно больше 1 шт" — жёстко в коде (не настройка), закреплено явным
// решением пользователя при обсуждении. НО (правка от 01.09.2026, по факту
// реальной сборки): порог считается не по qty ОДНОГО задания, а по сумме
// потребности этого задания + всех ещё не собранных заданий этой же волны на
// тот же штрихкод — см. computeBatchGroupNeed() ниже. Почти каждый заказ WB
// это отдельное задание с qty=1, поэтому проверка "qty>1 у одного задания"
// почти никогда не срабатывала на практике, хотя один и тот же товар в одной
// волне сплошь и рядом нужен сразу нескольким заказам подряд из одной и той
// же ячейки — ровно тот случай, для которого пачка задумывалась.
//
// Товары с поштучной маркировкой (Честный знак, marking_mode='scan') из
// батч-режима исключены всегда — там каждая единица имеет свой уникальный
// код, вводом одного числа это не заменить.
// =============================================================================

async function isBatchModeEnabled(tenantId) {
  const r = await query(
    `SELECT COALESCE((settings->>'picking_batch_mode_enabled')::boolean, false) AS enabled
     FROM platform.tenants WHERE id=$1`,
    [tenantId]
  );
  return r.rowCount > 0 && r.rows[0].enabled === true;
}

function isBatchModeExcluded(task) {
  return !!(task.requires_marking && task.marking_mode === 'scan');
}

/**
 * Сколько всего нужно этого штрихкода в этой волне прямо сейчас — это
 * задание (task) + другие ЕЩЁ НЕ ВЗЯТЫЕ ('new') задания той же волны на тот
 * же item_id/barcode. Именно эта сумма, а не task.qty само по себе, решает,
 * включать ли пачку (см. комментарий выше). dbClient — опционально, чтобы
 * можно было вызвать как внутри уже открытой транзакции (scanLocation), так
 * и отдельным запросом.
 */
async function computeBatchGroupNeed(dbClient, { tenantId, waveId, itemId, barcode, excludeTaskId }) {
  const q = dbClient ? dbClient.query.bind(dbClient) : query;
  const ownRes = await q(
    `SELECT qty, qty_picked FROM wms.picking_tasks WHERE id=$1 AND tenant_id=$2`,
    [excludeTaskId, tenantId]
  );
  const own = ownRes.rowCount > 0 ? (Number(ownRes.rows[0].qty) - Number(ownRes.rows[0].qty_picked || 0)) : 0;
  const groupRes = await q(
    `SELECT COALESCE(SUM(qty - qty_picked),0)::int AS need
     FROM wms.picking_tasks
     WHERE tenant_id=$1 AND wave_id=$2 AND item_id=$3 AND barcode=$4 AND id<>$5 AND status='new'`,
    [tenantId, waveId, itemId, barcode, excludeTaskId]
  );
  return own + Number(groupRes.rows[0].need);
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
       COALESCE(u.full_name, u.username) AS picker_name,
       c.client_name,
       (SELECT COUNT(*)::int FROM wms.picking_tasks t WHERE t.wave_id=w.id) AS task_count,
       (SELECT COUNT(*)::int FROM wms.picking_tasks t WHERE t.wave_id=w.id AND t.status='done') AS done_count
     FROM wms.pick_waves w
     LEFT JOIN wms.users u ON u.id=w.picker_id
     LEFT JOIN wms.clients c ON c.id=w.client_id
     WHERE ${conds.join(' AND ')} ORDER BY w.created_at DESC LIMIT $${idx}`,
    params
  );
  return r.rows;
}

async function getWaveByShipmentCode({ tenantId, shipmentCode }) {
  const r = await query(
    `SELECT w.*, COALESCE(u.full_name, u.username) AS picker_name, c.client_name,
       (SELECT COUNT(*)::int FROM wms.picking_tasks t WHERE t.wave_id=w.id) AS task_count,
       (SELECT COUNT(*)::int FROM wms.picking_tasks t WHERE t.wave_id=w.id AND t.status='done') AS done_count
     FROM wms.pick_waves w
     LEFT JOIN wms.users u ON u.id=w.picker_id
     LEFT JOIN wms.clients c ON c.id=w.client_id
     WHERE w.tenant_id=$1 AND w.shipment_code=$2 LIMIT 1`,
    [tenantId, shipmentCode]
  );
  if (r.rowCount === 0) throw new NotFoundError(`Wave for shipment '${shipmentCode}'`);
  return r.rows[0];
}

/**
 * Детали волны для диспетчерской (клик по карточке волны) — сама волна
 * (клиент, сборщик, статус) + полный список её заданий в порядке обхода
 * склада (тот же priority/id, которым фактически водит сборщика getNextTask,
 * см. locationWalkKey выше), с ячейкой, товаром, количеством и статусом
 * каждого. Задача #67, обсуждение с пользователем 07.09.2026 — раньше узнать
 * состав волны и путь сборщика можно было только прямыми запросами в БД.
 */
async function getWaveDetail({ tenantId, waveId }) {
  const wRes = await query(
    `SELECT w.*, COALESCE(u.full_name, u.username) AS picker_name, c.client_name
     FROM wms.pick_waves w
     LEFT JOIN wms.users u ON u.id=w.picker_id
     LEFT JOIN wms.clients c ON c.id=w.client_id
     WHERE w.tenant_id=$1 AND w.id=$2 LIMIT 1`,
    [tenantId, waveId]
  );
  if (wRes.rowCount === 0) throw new NotFoundError('Wave', waveId);

  const tasksRes = await query(
    `SELECT t.id, t.barcode, t.location_code, t.qty, t.qty_picked, t.status,
       t.priority, t.started_at, t.finished_at, t.reason, t.comment,
       i.item_name, i.vendor_code, i.size
     FROM wms.picking_tasks t
     LEFT JOIN wms.items i ON i.id=t.item_id
     WHERE t.tenant_id=$1 AND t.wave_id=$2
     ORDER BY t.priority ASC, t.id ASC`,
    [tenantId, waveId]
  );

  return { wave: wRes.rows[0], tasks: tasksRes.rows };
}

/** Взять волну (picker берёт в работу) */
async function takeWave({ tenantId, pickerId }) {
  return transaction(async (client) => {
    // 17.09.2026: обнаружен реальный случай (скриншот диспетчерской) — один
    // сборщик одновременно 'active' на ДВУХ разных волнах. Причина: "SELECT
    // ... FOR UPDATE" ниже блокирует только УЖЕ СУЩЕСТВУЮЩИЕ строки активной
    // волны этого пикера — если у него их ЕЩЁ НЕТ (обычный случай для двух
    // быстрых подряд тапов "взять волну" на медленной сети / повторный запрос
    // от ТСД после таймаута), блокировать нечего, и обе параллельные
    // транзакции проходят проверку "активной волны нет" одновременно, каждая
    // берёт СВОЮ отдельную открытую волну. FOR UPDATE тут бессилен - нельзя
    // заблокировать отсутствие строки. Правильное решение - advisory-лок на
    // пару (tenant, picker) ДО проверки: вторая параллельная транзакция
    // просто ждёт первую и увидит её результат в SELECT ниже как обычно.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('pick_wave_take:' || $1::text || ':' || $2::text))`,
      [tenantId, pickerId]
    );

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

    // Берём первую свободную 'open' волну FOR UPDATE SKIP LOCKED.
    // Приоритет (17.09.2026, запрос пользователя): (1) волна, ЯВНО назначенная
    // этому сборщику (assigned_picker_id) — забирается ПЕРВОЙ, независимо от
    // priority/даты, и волны, назначенные ДРУГОМУ сборщику, этому вообще не
    // видны (AND (assigned_picker_id IS NULL OR assigned_picker_id=$2)) —
    // иначе их мог бы перехватить кто угодно; (2) среди остальных — по
    // priority (меньше = раньше), потом по дате как раньше.
    const open = await client.query(
      `SELECT id, shipment_code, client_id, warehouse_id
       FROM wms.pick_waves
       WHERE tenant_id=$1 AND status='open' AND picker_id IS NULL
         AND (assigned_picker_id IS NULL OR assigned_picker_id=$2)
         AND EXISTS (
           SELECT 1 FROM wms.picking_tasks t
           WHERE t.wave_id=wms.pick_waves.id AND t.status='new'
         )
       ORDER BY CASE WHEN assigned_picker_id=$2 THEN 0 ELSE 1 END, priority ASC, created_at ASC
       FOR UPDATE SKIP LOCKED LIMIT 1`,
      [tenantId, pickerId]
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

/**
 * Приоритет волны (17.09.2026, "волны падают по порядку, нужно задать
 * приоритет") — общий на picking+packing одной и той же отгрузки, ставится
 * ОДНИМ действием в диспетчерской. Меньше число — выше приоритет (тот же
 * порядок, что уже был у picking_tasks.priority/packing_tasks.priority).
 * Задаём только для ещё НЕ взятых в работу волны/задачи ('open'/'new') —
 * приоритет решает, кто возьмёт СЛЕДУЮЩИМ, на уже идущую работу не влияет.
 */
async function setShipmentPriority({ tenantId, shipmentCode, priority }) {
  const p = Math.max(0, Math.min(1000, Number(priority)));
  if (!Number.isFinite(p)) throw new ValidationError('Некорректный приоритет');
  return transaction(async (client) => {
    const waveRes = await client.query(
      `UPDATE wms.pick_waves SET priority=$1, updated_at=NOW()
       WHERE tenant_id=$2 AND shipment_code=$3 AND status='open'
       RETURNING id`,
      [p, tenantId, shipmentCode]
    );
    const packRes = await client.query(
      `UPDATE wms.packing_tasks SET priority=$1, updated_at=NOW()
       WHERE tenant_id=$2 AND shipment_code=$3 AND status='new'
       RETURNING id`,
      [p, tenantId, shipmentCode]
    );
    if (waveRes.rowCount === 0 && packRes.rowCount === 0) {
      throw new NotFoundError('Открытая волна или задача упаковки для этой отгрузки', shipmentCode);
    }
    return { shipment_code: shipmentCode, priority: p, wave_updated: waveRes.rowCount > 0, packing_updated: packRes.rowCount > 0 };
  });
}

/**
 * Назначить (или снять, pickerId=null) волну конкретному сборщику заранее —
 * см. комментарий у takeWave() выше про приоритет выборки. Действует только
 * на ещё не взятую ('open'/picker_id IS NULL) волну.
 */
async function assignWavePicker({ tenantId, shipmentCode, pickerId }) {
  if (pickerId != null) {
    const check = await query(
      `SELECT id FROM wms.users
       WHERE id=$1 AND tenant_id=$2 AND is_active=TRUE
         AND (role='picker' OR EXISTS(SELECT 1 FROM wms.user_roles WHERE user_id=$1 AND role='picker'))`,
      [pickerId, tenantId]
    );
    if (check.rowCount === 0) throw new ValidationError('Сотрудник не найден или не является сборщиком');
  }
  const r = await query(
    `UPDATE wms.pick_waves SET assigned_picker_id=$1, updated_at=NOW()
     WHERE tenant_id=$2 AND shipment_code=$3 AND status='open' AND picker_id IS NULL
     RETURNING id`,
    [pickerId, tenantId, shipmentCode]
  );
  if (r.rowCount === 0) throw new NotFoundError('Свободная (ещё не взятая) волна для этой отгрузки', shipmentCode);
  return { shipment_code: shipmentCode, assigned_picker_id: pickerId };
}

/** Список активных сборщиков — для выпадашки "назначить" в диспетчерской. */
async function listPickers({ tenantId }) {
  const r = await query(
    `SELECT DISTINCT u.id, u.full_name, u.username
     FROM wms.users u
     LEFT JOIN wms.user_roles ur ON ur.user_id=u.id
     WHERE u.tenant_id=$1 AND u.is_active=TRUE AND (u.role='picker' OR ur.role='picker')
     ORDER BY u.full_name NULLS LAST, u.username`,
    [tenantId]
  );
  return r.rows;
}

/**
 * Сбросить "зависшую" волну — сборщик взял её в работу (status='active'/
 * 'offered'), но физически бросил (пропал, не закрыл сканом ячейки буфера) -
 * в диспетчерской такая волна долго висит "в простое" без прогресса, и до
 * этой функции единственным способом её высвободить было лезть прямо в БД.
 * Снимаем picker_id с волны и НЕзавершённых заданий (status IN ('new',
 * 'in_progress')) - они возвращаются в свободный пул и их сможет забрать
 * любой другой сборщик через обычный "взять волну". Уже собранные (done),
 * пропущенные (skipped) и отменённые (cancelled) задания НЕ трогаем - их
 * прогресс/решение сохраняется как есть, в том числе частично собранные
 * (qty_picked>0, status='in_progress') - qty_picked не обнуляем, новый
 * сборщик продолжит с того места, докуда физически успели собрать.
 * Обсуждение с пользователем 07.09.2026 (диспетчерская, зависшая волна 38+ч).
 */
async function resetWave({ tenantId, waveId, actorId, actorUsername }) {
  return transaction(async (client) => {
    const wRes = await client.query(
      `SELECT * FROM wms.pick_waves WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
      [tenantId, waveId]
    );
    if (wRes.rowCount === 0) throw new NotFoundError('Wave', waveId);
    const wave = wRes.rows[0];
    if (!['active', 'offered'].includes(wave.status)) {
      throw new ValidationError(
        `Волна в статусе '${wave.status}' не назначена сборщику сейчас — сбрасывать нечего.`
      );
    }

    // Защита от ложного срабатывания (обсуждение с пользователем 07.09.2026):
    // волна может "зависнуть" не только потому что сборщик её физически
    // бросил, но и потому что саму отгрузку закрыли В ОБХОД ВМС (продавец
    // отгрузил прямо в кабинете WB, см. cancelShipment в shipping.service.js)
    // - тогда собирать уже нечего, товар физически уехал, и вернуть волну в
    // очередь на сборку было бы неправильно (сборщик пойдёт искать то, чего
    // уже нет). Если у этой волны уже есть реальная отгрузка НЕ в статусе
    // 'new'/'picking' - значит с ней что-то уже сделали помимо сборки, и
    // правильный инструмент тут "Отменить отгрузку" в карточке отгрузки, а
    // не сброс волны.
    const shipRes = await client.query(
      `SELECT status FROM wms.shipments WHERE tenant_id=$1 AND external_id=$2 ORDER BY id DESC LIMIT 1`,
      [tenantId, wave.shipment_code]
    );
    if (shipRes.rowCount > 0 && !['new', 'picking'].includes(shipRes.rows[0].status)) {
      throw new ValidationError(
        `Отгрузка '${wave.shipment_code}' уже в статусе '${shipRes.rows[0].status}' (не 'сборка') — похоже, с ней что-то ` +
        `сделали помимо сборки (например, отгрузили в обход ВМС). Возвращать волну в очередь на сборку не нужно — ` +
        `откройте карточку этой отгрузки в модуле "Отгрузка" и используйте там кнопку "Отменить отгрузку".`
      );
    }

    const tasksRes = await client.query(
      `UPDATE wms.picking_tasks
       SET picker_id=NULL, status='new', updated_at=NOW(), updated_by=$1
       WHERE wave_id=$2 AND status IN ('new','in_progress')
       RETURNING id`,
      [actorId, wave.id]
    );

    const noteLine = `Сброшена вручную (${actorUsername || 'supervisor'}, ${new Date().toISOString()}) — возвращено в пул заданий: ${tasksRes.rowCount}.`;
    await client.query(
      `UPDATE wms.pick_waves
       SET status='open', picker_id=NULL, accepted_at=NULL, updated_at=NOW(),
           notes=CASE WHEN notes IS NULL OR notes='' THEN $1 ELSE notes || E'\n' || $1 END
       WHERE id=$2`,
      [noteLine, wave.id]
    );

    return { ok: true, waveId: wave.id, tasksReturned: tasksRes.rowCount };
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
        const pinnedScope = await _stockScope(tenantId, c.item_id, c.client_id);
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
          [tenantId, c.warehouse_id, pinnedScope.itemId, pinnedScope.clientId, pinned]
        );
        const pinnedHasStock = pinnedStockRes.rowCount > 0 && Number(pinnedStockRes.rows[0].qty_available) > 0;
        if (pinnedHasStock) { resolvedById.set(c.id, { code: pinned, id: null }); return; }
      }
      // afterCode=pinned (обсуждение с пользователем 16.09.2026) — если у
      // этого товара в волне УЖЕ была запиненная ячейка (просто в ней кончился
      // остаток на этот добор), новую ячейку ищем предпочтительно ВПЕРЕДИ неё
      // по маршруту, а не где попало по чистому FIFO — иначе добор мог
      // отправить сборщика на более старую, но уже пройденную ячейку сзади
      // (см. findBestPickLocation). Если pinned не было вообще (первая задача
      // на этот товар в волне) - afterCode=null, поведение как раньше.
      const best = await findBestPickLocation({
        tenantId, warehouseId: c.warehouse_id, itemId: c.item_id, clientId: c.client_id,
        afterCode: pinned || null,
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
      return { result: 'mismatch', expected: task.location_code, scanned: scannedLocationCode };
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
    let batchGroupNeed = null;
    if (!isBatchModeExcluded(task) && await isBatchModeEnabled(tenantId)) {
      // Порог считаем по ГРУППЕ — это задание + другие ещё не взятые задания
      // этой же волны на тот же товар (см. computeBatchGroupNeed) — не по
      // task.qty самого по себе (см. комментарий у isBatchModeExcluded выше).
      const groupNeed = await computeBatchGroupNeed(client, {
        tenantId, waveId: task.wave_id, itemId: task.item_id, barcode: task.barcode, excludeTaskId: taskId,
      });
      if (groupNeed > 1) {
        batchGroupNeed = groupNeed;
        nextStep = 'await_item_qty';
        const locRes = await client.query(
          `SELECT id FROM wms.locations WHERE tenant_id=$1 AND UPPER(location_code)=UPPER($2) AND is_active=TRUE LIMIT 1`,
          [tenantId, finalLocCode]
        );
        let availAtLoc = 0;
        if (locRes.rowCount > 0) {
          const batchScope = await _stockScope(tenantId, task.item_id, task.client_id, client);
          const balRes = await client.query(
            `SELECT qty_on_hand FROM wms.stock_balances
             WHERE tenant_id=$1 AND warehouse_id=$2 AND client_id=$3 AND item_id=$4 AND location_id=$5`,
            [tenantId, task.warehouse_id, batchScope.clientId, batchScope.itemId, locRes.rows[0].id]
          );
          // Берём qty_on_hand (физический остаток по этой ячейке+товару), а не
          // qty_available — под эту же задачу здесь уже стоит собственный
          // резерв (см. getNextTask/reserveStock), из-за которого qty_available
          // заведомо занижен ровно на него и показал бы сборщику меньше, чем
          // реально можно взять. Это только подсказка для UI — окончательная
          // проверка остатка всё равно происходит заново в scanItemQty().
          availAtLoc = balRes.rowCount > 0 ? Number(balRes.rows[0].qty_on_hand) : 0;
        }
        batchAllowedQty = Math.max(0, Math.min(availAtLoc, groupNeed));
      }
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
    return { ok: true, result: 'ok', next_step: nextStep, batch_allowed_qty: batchAllowedQty, batch_group_need: batchGroupNeed };
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

    // Алиасы штрихкодов (см. миграцию 060 / wms.item_barcodes): у товара
    // может быть несколько зарегистрированных в ВБ штрихкодов на один и тот
    // же физический товар/размер. Задание хранит один конкретный (тот, что
    // пришёл в заказе от ВБ), но с полки сборщик мог взять экземпляр с
    // ДРУГИМ валидным штрихкодом того же товара — считаем это тем же самым
    // сканом, а не браком.
    if (!matched && task.item_id) {
      const resolved = await findItemIdByBarcode({ tenantId, clientId: task.client_id, barcode: scanned, dbClient: client });
      if (resolved && resolved.is_active && resolved.id === task.item_id) {
        matched = true; matchedVia = 'alias_barcode';
      }
    }

    if (!matched) {
      await client.query(
        `INSERT INTO wms.picking_scans(picking_task_id,picker_id,scan_type,expected,scanned,result,message) VALUES($1,$2,'item',$3,$4,'mismatch','Wrong barcode')`,
        [taskId, pickerId, expected, scanned]
      );
      return { result: 'mismatch', expected, scanned };
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
    const confirmScope = await _stockScope(tenantId, task.item_id, task.client_id, client);
    const availRes = await client.query(
      `SELECT qty_available FROM wms.stock_balances
       WHERE tenant_id=$1 AND warehouse_id=$2 AND client_id=$3 AND item_id=$4 AND location_id=$5
       FOR UPDATE`,
      [tenantId, task.warehouse_id, confirmScope.clientId, confirmScope.itemId, locRes.rows[0].id]
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
            [tenantId, task.warehouse_id, confirmScope.clientId, confirmScope.itemId, altLocId]
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
          result: 'relocated',
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
 * и только при включённом рубильнике тенанта — см. isBatchModeEnabled выше).
 * scanItem() (обычный поштучный скан, шаг 'await_item') этой функцией никак
 * не затронут и продолжает работать как раньше.
 *
 * ВАЖНО (правка от 01.09.2026, по факту реальной сборки — см. комментарий у
 * computeBatchGroupNeed): введённое количество распределяется НЕ только на
 * это задание, а на ГРУППУ — это задание + другие ещё не взятые ('new')
 * задания этой же волны на тот же item_id/barcode. Именно так закрывается
 * типичный WB-случай "5 разных заказов на один и тот же товар подряд из
 * одной ячейки" одним вводом количества вместо пяти отдельных сканов.
 *
 * Это задание (primary) может быть добрано ЧАСТИЧНО (как и раньше для
 * одиночной задачи — если на ячейке не хватило, остаток ведёт на другую
 * ячейку). Задания-соседи закрываются ТОЛЬКО целиком, никогда наполовину —
 * если введённого количества хватает на primary, но не хватает на ЦЕЛОГО
 * следующего соседа, этот хвост просто не берём сейчас (ничего не портит,
 * сосед остаётся 'new' и разрешится сам по себе, когда до него дойдёт
 * очередь обычным порядком).
 */
async function scanItemQty({ tenantId, pickerId, taskId, scannedBarcode, qty, comment }) {
  const chargeEntries = []; // [{clientId, qty, taskId}]

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
    if (!matched && task.item_id && isValidKizCode(scanned)) {
      const kizRes = await client.query(
        `SELECT id FROM wms.marking_codes WHERE tenant_id=$1 AND item_id=$2 AND code=$3 AND status='available' LIMIT 1`,
        [tenantId, task.item_id, scanned]
      );
      if (kizRes.rowCount > 0) { matched = true; matchedVia = 'kiz'; }
    }

    // Алиасы штрихкодов (см. миграцию 060 / wms.item_barcodes): у товара
    // может быть несколько зарегистрированных в ВБ штрихкодов на один и тот
    // же физический товар/размер. Задание хранит один конкретный (тот, что
    // пришёл в заказе от ВБ), но с полки сборщик мог взять экземпляр с
    // ДРУГИМ валидным штрихкодом того же товара — считаем это тем же самым
    // сканом, а не браком.
    if (!matched && task.item_id) {
      const resolved = await findItemIdByBarcode({ tenantId, clientId: task.client_id, barcode: scanned, dbClient: client });
      if (resolved && resolved.is_active && resolved.id === task.item_id) {
        matched = true; matchedVia = 'alias_barcode';
      }
    }

    if (!matched) {
      await client.query(
        `INSERT INTO wms.picking_scans(picking_task_id,picker_id,scan_type,expected,scanned,result,message) VALUES($1,$2,'item',$3,$4,'mismatch','Wrong barcode')`,
        [taskId, pickerId, expected, scanned]
      );
      return { result: 'mismatch', expected, scanned };
    }

    // Группа: это задание + соседи (см. doc-комментарий выше). Лочим соседей
    // FOR UPDATE сразу — единственный сборщик на волну, реальной конкуренции
    // нет, но защищаемся от гонки на всякий случай.
    const siblingsRes = await client.query(
      `SELECT * FROM wms.picking_tasks
       WHERE tenant_id=$1 AND wave_id=$2 AND item_id=$3 AND barcode=$4 AND id<>$5 AND status='new'
       ORDER BY id ASC
       FOR UPDATE`,
      [tenantId, task.wave_id, task.item_id, task.barcode, taskId]
    );
    const siblings = siblingsRes.rows;

    const primaryNeed = Number(task.qty) - Number(task.qty_picked || 0);
    const groupNeed = primaryNeed + siblings.reduce((s, r) => s + (Number(r.qty) - Number(r.qty_picked || 0)), 0);

    const enteredQty = validatePositiveInt(qty, 'qty');
    if (enteredQty > groupNeed) {
      throw new ValidationError(`Нельзя ввести больше, чем нужно (осталось ${groupNeed} шт.)`);
    }

    const locCode = task.location_code;
    if (!locCode) throw new ValidationError('Location code is not set for this task');

    // Снимаем резерв ПЕРЕД проверкой остатка — та же причина, что в scanItem
    // (пока резерв активен, qty_available уже уменьшен на него самого, и
    // задача видит нехватку из-за собственного же резерва). У соседей своего
    // резерва нет (они ещё ни разу не резолвились через getNextTask) —
    // снимать нечего.
    await ledger.releaseReservationByRef({ refType: 'picking_task', refId: taskId, status: 'cancelled', dbClient: client });

    const locRes = await client.query(
      `SELECT id FROM wms.locations WHERE tenant_id=$1 AND location_code=$2 AND is_active=TRUE LIMIT 1`,
      [tenantId, locCode]
    );
    if (locRes.rowCount === 0) throw new ValidationError(`Location '${locCode}' not found or inactive`);

    const qtyScope = await _stockScope(tenantId, task.item_id, task.client_id, client);
    const availRes = await client.query(
      `SELECT qty_available FROM wms.stock_balances
       WHERE tenant_id=$1 AND warehouse_id=$2 AND client_id=$3 AND item_id=$4 AND location_id=$5
       FOR UPDATE`,
      [tenantId, task.warehouse_id, qtyScope.clientId, qtyScope.itemId, locRes.rows[0].id]
    );
    const availAtLoc = availRes.rowCount > 0 ? Number(availRes.rows[0].qty_available) : 0;

    // Сколько реально можно списать с ЭТОЙ ячейки прямо сейчас — не больше,
    // чем показывает система, и не больше, чем ввёл сборщик.
    const takeQtyRaw = Math.min(enteredQty, availAtLoc);

    // Распределение: сначала primary (может остаться частично добранным —
    // см. doc-комментарий), остаток — соседям строго целиком по порядку id,
    // пока хватает; на первом, кому не хватает целиком, останавливаемся.
    const primaryGive = Math.min(takeQtyRaw, primaryNeed);
    let pool = takeQtyRaw - primaryGive;
    const completedSiblings = [];
    for (const sib of siblings) {
      const need = Number(sib.qty) - Number(sib.qty_picked || 0);
      if (need > 0 && pool >= need) { completedSiblings.push(sib); pool -= need; }
      else break;
    }
    const actualTakeQty = primaryGive + completedSiblings.reduce((s, r) => s + (Number(r.qty) - Number(r.qty_picked || 0)), 0);
    const newPrimaryPicked = Number(task.qty_picked || 0) + primaryGive;
    const primaryFullyDone = newPrimaryPicked >= Number(task.qty);

    if (actualTakeQty > 0) {
      await ledger.consumeStock({
        tenantId, warehouseId: task.warehouse_id, clientId: task.client_id,
        barcode: expected, itemId: task.item_id,
        locationId: locRes.rows[0].id, locationCode: locCode,
        qty: actualTakeQty, movementType: 'picking',
        refType: 'picking_task', refId: taskId,
        userId: pickerId, comment: comment||null, dbClient: client,
      });
      await client.query(
        `INSERT INTO wms.picking_scans(picking_task_id,picker_id,scan_type,expected,scanned,result) VALUES($1,$2,'item',$3,$4,'ok')`,
        [taskId, pickerId, expected, scanned]
      );
    }

    if (!primaryFullyDone) {
      // Это задание (primary) не добрано целиком — либо на ячейке было
      // пусто, либо хватило только на часть. Соседей в этом случае не
      // трогаем НИКОГДА (pool здесь всегда 0 — им ничего не досталось,
      // остаются 'new' и разрешатся сами по себе позже). Ищем другую
      // ячейку под остаток primary — как и раньше для одиночной задачи.
      if (actualTakeQty > 0) {
        await client.query(`UPDATE wms.picking_tasks SET qty_picked=$1, updated_at=NOW() WHERE id=$2`, [newPrimaryPicked, taskId]);
      }
      const stillNeeded = Number(task.qty) - newPrimaryPicked;
      const alt = task.item_id
        ? await findBestPickLocation({ tenantId, warehouseId: task.warehouse_id, itemId: task.item_id, clientId: task.client_id })
        : null;
      if (alt && alt.location_code !== locCode) {
        await ledger.reserveStock({
          tenantId, warehouseId: task.warehouse_id, clientId: task.client_id,
          itemId: task.item_id, locationId: alt.location_id, barcode: expected,
          qty: stillNeeded, refType: 'picking_task', refId: taskId, dbClient: client,
        });
        await client.query(
          `UPDATE wms.picking_tasks SET location_code=$1, scan_step='await_location', updated_at=NOW() WHERE id=$2`,
          [alt.location_code, taskId]
        );
        await client.query(
          `INSERT INTO wms.picking_scans(picking_task_id,picker_id,scan_type,expected,scanned,result,message)
           VALUES($1,$2,'item',$3,$4,'relocated',$5)`,
          [taskId, pickerId, expected, scanned, actualTakeQty > 0
            ? `Частично собрано, остаток — в '${alt.location_code}'`
            : `Ячейка '${locCode}' пуста, перенаправлено на '${alt.location_code}'`]
        );
        return {
          ok: actualTakeQty > 0, result: actualTakeQty > 0 ? 'partial' : 'relocated',
          done: false, qty_picked: newPrimaryPicked, qty_total: task.qty,
          remaining: stillNeeded, new_location_code: alt.location_code,
          message: actualTakeQty > 0
            ? `Собрано ${newPrimaryPicked} из ${task.qty}. Ещё ${stillNeeded} шт — в ячейке ${alt.location_code}`
            : `Ячейка ${locCode} пуста — товар нашёлся в ${alt.location_code}, идите туда`,
        };
      }

      // Альтернативы нет — закрываем как недостачу.
      const closeRes = await closeShortageTask(client, { taskId, task, comment, currentQtyPicked: newPrimaryPicked });
      if (newPrimaryPicked > 0) chargeEntries.push({ clientId: task.client_id, qty: newPrimaryPicked, taskId });
      return closeRes;
    }

    // Primary полностью собрано (возможно, за несколько ячеек за всё время) —
    // закрываем его и всех соседей, кому в эту же пачку хватило целиком.
    await client.query(
      `UPDATE wms.picking_tasks
       SET status='done', scan_step='done', qty_picked=$1, finished_at=NOW(), updated_at=NOW(), updated_by=$2
       WHERE id=$3`,
      [newPrimaryPicked, pickerId, taskId]
    );
    chargeEntries.push({ clientId: task.client_id, qty: newPrimaryPicked, taskId });

    for (const sib of completedSiblings) {
      await client.query(
        `UPDATE wms.picking_tasks
         SET status='done', scan_step='done', qty_picked=$1, location_code=COALESCE(location_code,$2),
             started_at=COALESCE(started_at,NOW()), finished_at=NOW(), updated_at=NOW(), updated_by=$3
         WHERE id=$4`,
        [sib.qty, locCode, pickerId, sib.id]
      );
      await client.query(
        `INSERT INTO wms.picking_scans(picking_task_id,picker_id,scan_type,expected,scanned,result,message)
         VALUES($1,$2,'item',$3,$4,'ok',$5)`,
        [sib.id, pickerId, expected, scanned, `Собрано пачкой вместе с заданием #${taskId} из ячейки ${locCode}`]
      );
      chargeEntries.push({ clientId: sib.client_id, qty: sib.qty, taskId: sib.id });
    }

    if (task.wave_id) {
      const doneCount = 1 + completedSiblings.length;
      await client.query(`UPDATE wms.pick_waves SET done_tasks=done_tasks+$1, updated_at=NOW() WHERE id=$2`, [doneCount, task.wave_id]);
      const progress = await client.query(
        `SELECT COUNT(*) FILTER(WHERE status!='done')::int AS remaining FROM wms.picking_tasks WHERE wave_id=$1`,
        [task.wave_id]
      );
      if (progress.rows[0].remaining === 0) {
        await client.query(`UPDATE wms.pick_waves SET status='ready', ready_at=NOW(), updated_at=NOW() WHERE id=$1`, [task.wave_id]);
      }
    }

    return {
      ok: true, result: 'ok', done: true, qty_picked: newPrimaryPicked, qty_total: task.qty,
      matched_via: matchedVia, extra_completed: completedSiblings.length,
      message: completedSiblings.length > 0
        ? `Заодно закрыто ещё ${completedSiblings.length} заказ(ов) на этот же товар из этой ячейки.`
        : null,
    };
  });

  for (const c of chargeEntries) {
    chargeForOperation({ tenantId, clientId: c.clientId, serviceType: 'picking', quantity: c.qty, refType: 'picking_task', refId: c.taskId });
  }

  return result;
}

/** Пропустить задачу (товар не найден) */
async function skipTask({ tenantId, pickerId, taskId, reason, comment }) {
  // ВАЖНО (найдено 21.09.2026): раньше здесь стояло `return transaction(...)` -
  // это завершало функцию СРАЗУ на конце транзакции, и весь код ниже (триггер
  // пересчёта остатка для ВБ при карантине, перенос заказа в "Дефициты") был
  // мёртвым - физически никогда не выполнялся (недостижимый код после return).
  // Именно поэтому перенос в "Дефициты" не срабатывал в тесте на staging.
  const result = await transaction(async (client) => {
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

      // Пул остатков — карантин физически трогает тот же баланс, что и любая
      // другая операция с остатком, поэтому резолвим один раз и используем
      // везде ниже вместо task.item_id/task.client_id напрямую.
      const quarScope = task.item_id
        ? await _stockScope(tenantId, task.item_id, task.client_id, client)
        : { itemId: task.item_id, clientId: task.client_id };

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
          [tenantId, task.warehouse_id, quarScope.clientId, quarScope.itemId, origLocId]
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
            [tenantId, task.warehouse_id, quarScope.clientId, quarScope.itemId, task.barcode, -qtyFree,
             origLocId, task.location_code, quarantineLoc.id, quarantineLoc.location_code,
             taskId, pickerId, 'Карантин: сборщик не нашёл товар']
          );
          await client.query(
            `SELECT * FROM wms.apply_stock_movement($1,$2,$3,$4,$5,$6,$7,$8)`,
            [tenantId, task.warehouse_id, quarScope.clientId, quarScope.itemId, origLocId, task.barcode, -qtyFree, null]
          );
          await client.query(
            `INSERT INTO wms.stock_movements
               (tenant_id,warehouse_id,client_id,item_id,barcode,movement_type,qty,
                from_location_id,from_location_code,to_location_id,to_location_code,
                ref_type,ref_id,user_id,comment)
             VALUES($1,$2,$3,$4,$5,'move',$6,$7,$8,$9,$10,'picking_task',$11,$12,$13)`,
            [tenantId, task.warehouse_id, quarScope.clientId, quarScope.itemId, task.barcode, qtyFree,
             origLocId, task.location_code, quarantineLoc.id, quarantineLoc.location_code,
             taskId, pickerId, 'Карантин: сборщик не нашёл товар']
          );
          const quarBal = await client.query(
            `SELECT * FROM wms.apply_stock_movement($1,$2,$3,$4,$5,$6,$7,$8)`,
            [tenantId, task.warehouse_id, quarScope.clientId, quarScope.itemId, quarantineLoc.id, task.barcode, qtyFree, null]
          );
          movedQty = Number(quarBal.rows[0].qty_on_hand);
          quarantined = true;

          const existingQuar = await client.query(
            `SELECT id FROM wms.inventory_tasks
             WHERE tenant_id=$1 AND item_id=$2 AND location_id=$3 AND status IN ('open','in_progress') LIMIT 1`,
            [tenantId, quarScope.itemId, quarantineLoc.id]
          );
          if (existingQuar.rowCount === 0) {
            const inv = await client.query(
              `INSERT INTO wms.inventory_tasks
                 (tenant_id,warehouse_id,client_id,item_id,barcode,location_code,location_id,
                  qty_system,status,priority,reason,comment,created_by)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,'open',1,'picker_not_found',$9,$10)
               RETURNING id`,
              [tenantId, task.warehouse_id, quarScope.clientId, quarScope.itemId,
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
            [tenantId, task.warehouse_id, quarScope.clientId, quarScope.itemId, origLocId]
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
            [tenantId, task.warehouse_id, quarScope.clientId, quarScope.itemId,
             task.barcode, task.location_code, origLocId, fallbackQtySystem,
             comment||'Picker не нашёл товар', pickerId]
          );
          inventoryTaskId = inv.rows[0].id;
        } else {
          inventoryTaskId = existing.rows[0].id;
        }
      }
    }

    // Авто-повтор в конце волны: по системе есть тот же товар в ДРУГОЙ ячейке
    // отбора (не карантин, не под открытой инвентаризацией "не найден" — см.
    // фильтры внутри findBestPickLocation) — не оставляем задачу висеть
    // 'skipped' до ручного возврата супервайзером, а сразу переоткрываем её
    // на новую ячейку. Приоритет намеренно поднимаем выше остальных задач
    // волны, чтобы сборщик сначала прошёл весь обычный маршрут и только в
    // конце вернулся за этим товаром, а не прыгал туда-сюда посреди волны.
    //
    // ВАЖНО (найдено 21.09.2026 при тесте переноса в "Дефициты"): раньше эта
    // проверка была под условием quarantined - но quarantined означает только
    // "в ИСХОДНОЙ ячейке по системе что-то числилось, и мы физически перенесли
    // это в карантин" - а НЕ "остатка нет нигде". Если по системе на исходной
    // ячейке и так уже было 0 (самый частый случай - товар реально
    // закончился, без фантомного остатка) - quarantined оставался false, и
    // проверка альтернативной ячейки вообще не запускалась: задача просто
    // зависала 'skipped' без единой попытки найти товар в другом месте склада
    // и без переноса в "Дефициты". Убрали зависимость от quarantined -
    // проверяем альтернативу всегда, когда известен item_id.
    //
    // Если альтернативной ячейки с остатком нет - задача остаётся 'skipped'
    // (супервайзер видит её в "Пропущенные позиции"), а wbOrderId уходит в
    // поставку "Дефициты" (см. вызов moveOrderToDeficitSupply ниже, за
    // пределами транзакции).
    let requeued = false;
    if (task.item_id) {
      // dbClient: client (найдено 21.09.2026) - без этого findBestPickLocation
      // шёл через отдельное соединение из пула и не видел ещё незакоммиченный
      // перенос остатка исходной ячейки в карантин чуть выше в ЭТОЙ ЖЕ
      // транзакции - видел старое (пока ещё не обнулённое снаружи) значение
      // исходной ячейки и ошибочно "находил" её же саму как альтернативу.
      // Задача requeue'илась туда же, откуда её только что убрали - сборщик
      // получал следующее задание с ячейкой, которая по факту (после коммита)
      // тоже 0 - "прочерк" на ТСД, а в "Дефициты" заказ не уходил, хотя должен
      // был (реальной альтернативы не было).
      const alt = await findBestPickLocation({
        tenantId, warehouseId: task.warehouse_id, itemId: task.item_id, clientId: task.client_id,
        dbClient: client,
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

    return {
      ok: true, taskId, inventoryTaskId, quarantined, requeued,
      clientId: task.client_id, barcode: task.barcode, wbOrderId: task.wb_order_id,
    };
  });

  // Перенос в карантин меняет qty_available в ячейках отбора (было в обычной
  // ячейке — стало в карантинной, is_pick_location=FALSE) — так же, как и
  // обычное перемещение (см. moveItem в movement.service.js), нужно сразу
  // пересчитать остаток, отдаваемый в WB, а не ждать следующего цикла синка.
  if (result.quarantined && result.barcode) {
    logger.info({ tenantId, barcode: result.barcode }, 'Skip→quarantine triggered WB redistribution');
    triggerRedistributionForClient({ tenantId, clientId: result.clientId, barcodes: [result.barcode] });
  }

  // requeued=false здесь означает, что альтернативной ячейки с остатком для
  // этого товара НЕ нашлось нигде на складе (см. проверку выше, теперь не
  // зависящую от quarantined) — переносим заказ в поставку "Дефициты" его
  // склада, чтобы он не тормозил закрытие исходной поставки ВБ (см. миграцию
  // 071_wb_deficit_supplies.sql). Best-effort и намеренно ПОСЛЕ основной
  // транзакции (сетевой вызов к WB) — неудача здесь не должна откатывать уже
  // состоявшийся skip, сборщик и так увидит задачу в обычном списке
  // пропущенных (listSkippedTasks) для ручного разбора.
  if (!result.requeued && result.wbOrderId) {
    moveOrderToDeficitSupply({ tenantId, wbOrderId: result.wbOrderId }).catch(e => {
      logger.warn({ err: e, tenantId, wbOrderId: result.wbOrderId }, 'skipTask: moveOrderToDeficitSupply failed (non-fatal)');
    });
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
       COALESCE(u.full_name, u.username) AS picker_name,
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

function _escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Общая часть экспорта пропущенных позиций (стикеры ВБ + справочные поля) —
 * используется и для печатной HTML-страницы, и для Excel-выгрузки под ручное
 * сканирование КИЗ (обсуждение с пользователем 16.09.2026). Стикер (base64
 * svg) обычно уже закэширован в wms.wb_orders при формировании волны — если
 * по какой-то задаче его там нет (старое/восстановленное вручную задание),
 * дотягиваем его живьём у ВБ по api_token нужного кабинета и заодно
 * сохраняем в кэш тем же способом, что и generate-wave (wb.router.js).
 */
async function _getSkippedForExport({ tenantId, warehouseId = null, clientId = null }) {
  const r = await query(
    `SELECT t.id, t.barcode, t.qty, t.location_code, t.shipment_code, t.wb_order_id,
       i.item_name, i.vendor_code,
       c.client_name,
       wo.wb_sticker, wo.wb_sticker_code, wo.mp_account_id
     FROM wms.picking_tasks t
     LEFT JOIN wms.items i ON i.id = t.item_id
     LEFT JOIN wms.clients c ON c.id = t.client_id
     LEFT JOIN wms.wb_orders wo ON wo.tenant_id = t.tenant_id AND wo.wb_order_id = t.wb_order_id
     WHERE t.tenant_id=$1 AND t.status='skipped' AND t.wb_order_id IS NOT NULL
       AND ($2::int IS NULL OR t.warehouse_id=$2)
       AND ($3::int IS NULL OR t.client_id=$3)
     ORDER BY c.client_name, i.item_name`,
    [tenantId, warehouseId, clientId]
  );
  const rows = r.rows;

  // Дотягиваем недостающие стикеры живьём у ВБ, группируя по кабинету —
  // на всякий случай (обычно все уже есть из generate-wave).
  const missing = rows.filter((row) => !row.wb_sticker && row.mp_account_id);
  if (missing.length) {
    const byAccount = new Map();
    for (const row of missing) {
      if (!byAccount.has(row.mp_account_id)) byAccount.set(row.mp_account_id, []);
      byAccount.get(row.mp_account_id).push(row);
    }
    // Кабинеты — параллельно, и внутри кабинета UPDATE-ы тоже параллельно
    // (обсуждение с пользователем 16.09.2026: раньше ходили к ВБ и писали в
    // базу строго по одному, на 20+ пропущенных позиций скачивание растягивалось
    // на минуту+; между разными кабинетами и между отдельными строками
    // зависимостей нет, так что ждать друг друга незачем).
    await Promise.all(Array.from(byAccount.entries()).map(async ([mpAccountId, accRows]) => {
      const accRes = await query(`SELECT api_token FROM wms.mp_accounts WHERE id=$1 AND tenant_id=$2`, [mpAccountId, tenantId]);
      const token = accRes.rows[0] && accRes.rows[0].api_token;
      if (!token) return;
      let stickers = [];
      try {
        stickers = await wbClient.fetchOrderStickers(token, accRows.map((row) => Number(row.wb_order_id)));
      } catch (e) {
        logger.warn({ err: e, mpAccountId }, '_getSkippedForExport: fetchOrderStickers failed, skipping account');
        return;
      }
      const byOrderId = new Map(stickers.map((st) => [Number(st.orderId), st]));
      await Promise.all(accRows.map(async (row) => {
        const st = byOrderId.get(Number(row.wb_order_id));
        if (!st || !st.file) return;
        const code = wbClient.extractStickerCode(st.file);
        row.wb_sticker = st.file;
        row.wb_sticker_code = code;
        await query(
          `UPDATE wms.wb_orders SET wb_sticker=$1, wb_sticker_code=$2 WHERE tenant_id=$3 AND mp_account_id=$4 AND wb_order_id=$5`,
          [st.file, code, tenantId, mpAccountId, Number(row.wb_order_id)]
        );
      }));
    }));
  }
  return rows;
}

/**
 * mode='reference' (по умолчанию) — обычная A4-страница: таблица-справочник
 * (найти товар на складе) + превью стикеров с подписью, на обычном принтере.
 * mode='thermal' — ЧИСТЫЕ стикеры ВБ без каких-либо подписей, ровно один на
 * страницу размером 58×40мм (@page), под настоящий термопринтер этикеток —
 * подпись поверх могла бы наехать на штрихкод/код ВБ, поэтому в этом режиме
 * её нет вообще; для сверки "какой стикер к какому товару" используется
 * порядок — он тот же, что и в справочной таблице режима reference.
 * В диалоге печати браузера нужно выбрать бумагу/этикетку 58×40мм и поля "0".
 */
async function exportSkippedStickers({ tenantId, warehouseId = null, clientId = null, mode = 'reference' }) {
  const rows = await _getSkippedForExport({ tenantId, warehouseId, clientId });
  const withSticker = rows.filter((row) => row.wb_sticker);
  const withoutSticker = rows.filter((row) => !row.wb_sticker);

  if (mode === 'thermal') {
    const pages = withSticker.map((row) => `
      <div class="label"><img src="data:image/svg+xml;base64,${row.wb_sticker}" /></div>`).join('');
    return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8">
<title>Термоэтикетки 58×40 — пропущенные позиции</title>
<style>
  @page { size: 58mm 40mm; margin: 0; }
  html,body{margin:0;padding:0;}
  .label{width:58mm;height:40mm;page-break-after:always;display:flex;align-items:center;justify-content:center;}
  .label img{width:58mm;height:40mm;display:block;}
  .no-print{padding:10px;font-family:Arial,sans-serif;}
  @media print { .no-print{display:none;} }
</style>
</head><body>
  <div class="no-print">
    <button onclick="window.print()">🖨 Печать (${withSticker.length} шт., в диалоге печати выбрать этикетку 58×40мм, поля 0)</button>
    ${withoutSticker.length ? `<p style="color:#dc2626">Без стикера (распечатать вручную из ЛК ВБ): ${withoutSticker.map((row) => _escHtml(row.wb_order_id)).join(', ')}</p>` : ''}
  </div>
  ${pages}
</body></html>`;
  }

  const tableRows = rows.map((row, idx) => `
    <tr>
      <td>${idx + 1}</td>
      <td>${_escHtml(row.client_name || '—')}</td>
      <td>${_escHtml(row.item_name || row.barcode || '—')}</td>
      <td>${_escHtml(row.vendor_code || '—')}</td>
      <td>${_escHtml(row.barcode || '—')}</td>
      <td>${_escHtml(row.location_code || '—')}</td>
      <td>${_escHtml(row.wb_order_id)}</td>
      <td>${row.wb_sticker ? 'есть' : '<b style="color:#dc2626">нет</b>'}</td>
    </tr>`).join('');

  const labelBlocks = withSticker.map((row) => `
    <div class="label">
      <img class="label-svg" src="data:image/svg+xml;base64,${row.wb_sticker}" />
      <div class="label-caption">
        <div class="label-item">${_escHtml(row.item_name || row.barcode)}</div>
        <div class="label-sub">${_escHtml(row.vendor_code || '')} · ${_escHtml(row.client_name || '')}</div>
      </div>
    </div>`).join('');

  const missingNote = withoutSticker.length
    ? `<p style="color:#dc2626">Не удалось получить стикер для ${withoutSticker.length} заказ(ов) — распечатайте их вручную из личного кабинета ВБ: ${withoutSticker.map((row) => _escHtml(row.wb_order_id)).join(', ')}.</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8">
<title>Стикеры на печать — пропущенные позиции</title>
<style>
  body{font-family:Arial,sans-serif;margin:20px;color:#111;}
  h1{font-size:18px;margin-bottom:4px;}
  .meta{color:#666;font-size:13px;margin-bottom:16px;}
  table{border-collapse:collapse;width:100%;margin-bottom:24px;font-size:13px;}
  th,td{border:1px solid #ddd;padding:6px 8px;text-align:left;}
  th{background:#f4f4f4;}
  .labels{display:flex;flex-wrap:wrap;gap:8px;}
  .label{width:58mm;min-height:44mm;border:1px dashed #bbb;padding:2mm;box-sizing:border-box;page-break-inside:avoid;}
  .label-svg{width:100%;height:auto;display:block;}
  .label-caption{font-size:7pt;line-height:1.2;margin-top:1mm;}
  .label-item{font-weight:bold;}
  @media print { .no-print{display:none;} .label{border:none;} }
</style>
</head><body>
  <h1>Стикеры ВБ — пропущенные позиции сборки</h1>
  <div class="meta">Сформировано: ${new Date().toLocaleString('ru-RU')} · позиций: ${rows.length}, стикеров получено: ${withSticker.length}</div>
  <p class="no-print"><button onclick="window.print()">🖨 Печать</button></p>
  ${missingNote}
  <table>
    <thead><tr><th>#</th><th>Клиент</th><th>Товар</th><th>Артикул</th><th>Баркод</th><th>Последняя ячейка</th><th>Заказ ВБ</th><th>Стикер</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
  <div class="labels">${labelBlocks}</div>
</body></html>`;
}

/**
 * Excel-выгрузка тех же пропущенных позиций с пустой колонкой "КИЗ" — чтобы
 * физически собирая товар вручную, сразу сканировать код Честного знака
 * прямо в файл (сканер работает как клавиатура + Enter), без ТСД и без
 * обычного экрана упаковки. Порядок строк совпадает с порядком стикеров в
 * exportSkippedStickers(mode='thermal') — так проще сверять по ходу сборки.
 */
async function exportSkippedXlsx({ tenantId, warehouseId = null, clientId = null }) {
  const rows = await _getSkippedForExport({ tenantId, warehouseId, clientId });
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Пропущено');
  sheet.columns = [
    { header: '#', key: 'idx', width: 5 },
    { header: 'Клиент', key: 'client', width: 22 },
    { header: 'Товар', key: 'item', width: 40 },
    { header: 'Артикул', key: 'vendor', width: 16 },
    { header: 'Баркод', key: 'barcode', width: 18 },
    { header: 'Последняя ячейка', key: 'loc', width: 16 },
    { header: 'Заказ ВБ', key: 'order', width: 14 },
    { header: 'Код стикера', key: 'stickerCode', width: 18 },
    { header: 'КИЗ (отсканировать)', key: 'kiz', width: 45 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F0F0' } };
  rows.forEach((row, idx) => {
    sheet.addRow({
      idx: idx + 1,
      client: row.client_name || '',
      item: row.item_name || row.barcode || '',
      vendor: row.vendor_code || '',
      barcode: row.barcode || '',
      loc: row.location_code || '',
      order: row.wb_order_id,
      stickerCode: row.wb_sticker_code || '',
      kiz: '',
    });
  });
  sheet.autoFilter = { from: 'A1', to: 'I1' };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  const buffer = await wb.xlsx.writeBuffer();
  return { buffer, count: rows.length };
}

/**
 * Отменить (снять) пропущенное задание — не возвращать в сборку, а окончательно
 * убрать из списка "Пропущенные позиции" супервайзера, потому что недостача уже
 * признана и закрыта другим способом (актом списания, ручной корректировкой и
 * т.п.) и держать её дальше в очереди "требует решения" не нужно. Задача #69,
 * обсуждение с пользователем 07.09.2026 — до этого пропущенные задания
 * копились в списке навсегда без возможности их разобрать.
 * Только supervisor/tenant_admin — та же причина, что у requeueSkippedTask.
 */
async function cancelSkippedTask({ tenantId, taskId, actorId, comment }) {
  return transaction(async (client) => {
    const tRes = await client.query(
      `SELECT * FROM wms.picking_tasks WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
      [taskId, tenantId]
    );
    if (tRes.rowCount === 0) throw new NotFoundError('PickingTask', taskId);
    const task = tRes.rows[0];
    if (task.status !== 'skipped') {
      throw new ValidationError(`Отменить можно только пропущенное задание (сейчас статус '${task.status}')`);
    }
    await client.query(
      `UPDATE wms.picking_tasks
       SET status='cancelled', comment=COALESCE($1, comment), updated_at=NOW(), updated_by=$2
       WHERE id=$3`,
      [comment || null, actorId, taskId]
    );
    return { ok: true, taskId };
  });
}

/**
 * Отменённые задания (для отдельной вкладки в диспетчерской) — сюда попадают
 * и задания, снятые вручную через cancelSkippedTask() выше, и задания,
 * отменённые целиком вместе с отгрузкой (см. cancelShipment в
 * shipping.service.js) — оба случая одинаково "больше не актуально", разница
 * видна по reason/comment.
 */
async function listCancelledTasks({ tenantId, warehouseId = null, limit = 100 }) {
  const r = await query(
    `SELECT t.id, t.barcode, t.qty, t.qty_picked, t.location_code, t.shipment_code, t.wave_id,
       t.reason, t.comment, t.updated_at, t.warehouse_id,
       i.item_name,
       COALESCE(u.full_name, u.username) AS picker_name,
       w.status AS wave_status
     FROM wms.picking_tasks t
     LEFT JOIN wms.items i ON i.id = t.item_id
     LEFT JOIN wms.users u ON u.id = t.picker_id
     LEFT JOIN wms.pick_waves w ON w.id = t.wave_id
     WHERE t.tenant_id=$1 AND t.status='cancelled'
       AND ($2::int IS NULL OR t.warehouse_id=$2)
     ORDER BY t.updated_at DESC
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

    // Пустая поставка (21.09.2026, "не должна пустая поставка попадать на
    // упаковку, она блокирует работу") - если ВСЕ задачи волны пропущены (и,
    // как правило, уехали в "Дефициты" - см. moveOrderToDeficitSupply в
    // skipTask), собирать в коробе физически нечего: ноль штук, нулевой
    // вес. Раньше closeWave() всё равно безусловно создавал packing_tasks -
    // упаковщик получал в очередь пустую отгрузку без единой строки состава
    // и без возможности её закрыть (нечего сканировать, "Подтвердить
    // упаковку" рассчитан на реальные короба) - зависшая задача блокировала
    // весь стол упаковки. Если ни одна задача волны не 'done' - в упаковку
    // вообще не отправляем, сразу закрываем саму отгрузку как отменённую
    // (содержимое целиком уехало в "Дефициты", исходная поставка ВБ пуста).
    const doneCountRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM wms.picking_tasks WHERE wave_id=$1 AND status='done'`,
      [wave.id]
    );
    const nothingPicked = doneCountRes.rows[0].n === 0;
    if (nothingPicked && shipRes.rowCount > 0) {
      await client.query(
        `UPDATE wms.shipments
         SET status='cancelled', cancelled_at=NOW(), cancelled_by=$1,
             cancel_reason=$2, updated_at=NOW()
         WHERE id=$3`,
        [pickerId, 'Все позиции пропущены и перенесены в поставку «Дефициты» — упаковывать нечего (авто, при закрытии волны)', shipRes.rows[0].id]
      );
      return { ok: true, shipmentCode, status: 'cancelled', emptyShipment: true, printJobCreated: false };
    }

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

    const resolvedLines = [];
    for (const line of lines) {
      const barcode = validateBarcode(line.barcode);
      const qty = validateQty(line.qty);
      const itemId = await resolveOrCreateItem({ tenantId, clientId, barcode, dbClient: client });
      resolvedLines.push({ barcode, qty, itemId });
    }

    // 18.09.2026: раньше волна создавалась из ВСЕХ строк как есть, даже если
    // товара физически нет ни на одной ячейке — сборщик получал задание с
    // пустой ячейкой ("—") и упирался в это только в момент сборки. Теперь,
    // как и в generate-wave для WB (см. wb.router.js), заранее считаем
    // реальный остаток и урезаем количество каждой строки до доступного —
    // если просили 10, а на складе 6, в задачу уйдёт 6, а недостающие 4
    // попадут в stock_shortage в ответе (строка при этом не выбрасывается
    // целиком — частично собрать лучше, чем не собрать ничего). Пул остатков
    // (resolveStockKey) учитываем так же, как и везде — резолвим стоковый
    // ключ товара, а не читаем баланс по исходному item_id напрямую.
    const stockKeyByItemId = new Map();
    const uniqueItemIds = [...new Set(resolvedLines.map((l) => l.itemId))];
    for (const itemId of uniqueItemIds) {
      stockKeyByItemId.set(itemId, await resolveStockKey({ tenantId, itemId, clientId, dbClient: client }));
    }
    const itemIdsByStockClient = new Map(); // stockClientId -> Set(stockItemId)
    for (const key of stockKeyByItemId.values()) {
      if (!itemIdsByStockClient.has(key.stockClientId)) itemIdsByStockClient.set(key.stockClientId, new Set());
      itemIdsByStockClient.get(key.stockClientId).add(key.stockItemId);
    }
    const availByStockKey = new Map(); // `${stockClientId}:${stockItemId}` -> qty
    for (const [stockClientId, stockItemIdSet] of itemIdsByStockClient) {
      const stockItemIds = [...stockItemIdSet];
      const availRes = await client.query(
        `SELECT item_id, COALESCE(SUM(qty_available),0)::int AS qty
         FROM wms.stock_balances
         WHERE tenant_id=$1 AND warehouse_id=$2 AND client_id=$3 AND item_id=ANY($4::int[])
         GROUP BY item_id`,
        [tenantId, warehouseId, stockClientId, stockItemIds]
      );
      for (const row of availRes.rows) availByStockKey.set(`${stockClientId}:${row.item_id}`, row.qty);
    }
    // Уже "занято" незавершёнными задачами сборки ДРУГИХ волн (остаток ещё не
    // списан физически, спишется только при реальном скане) — та же логика,
    // что и в generate-wave: без этого можно случайно пообещать один и тот же
    // остаток двум волнам, созданным почти одновременно.
    const allStockItemIds = [...new Set(uniqueItemIds.map((id) => stockKeyByItemId.get(id).stockItemId))];
    if (allStockItemIds.length) {
      const poolSourcesRes = await client.query(
        `SELECT item_id, pool_item_id FROM wms.item_pool_links WHERE tenant_id=$1 AND pool_item_id = ANY($2::int[])`,
        [tenantId, allStockItemIds]
      );
      const sourceItemIdsByStockItemId = new Map();
      for (const id of allStockItemIds) sourceItemIdsByStockItemId.set(id, [id]);
      for (const row of poolSourcesRes.rows) {
        sourceItemIdsByStockItemId.get(row.pool_item_id)?.push(row.item_id);
      }
      const allSourceItemIds = [...new Set([...sourceItemIdsByStockItemId.values()].flat())];
      const pendingRes = await client.query(
        `SELECT item_id, COALESCE(SUM(qty - qty_picked),0)::int AS pending
         FROM wms.picking_tasks
         WHERE tenant_id=$1 AND item_id=ANY($2::int[]) AND status NOT IN ('done','cancelled')
         GROUP BY item_id`,
        [tenantId, allSourceItemIds]
      );
      const pendingByItemId = new Map(pendingRes.rows.map((r) => [r.item_id, r.pending]));
      for (const [stockClientId, stockItemIdSet] of itemIdsByStockClient) {
        for (const stockItemId of stockItemIdSet) {
          const sources = sourceItemIdsByStockItemId.get(stockItemId) || [stockItemId];
          const pending = sources.reduce((s, id) => s + (pendingByItemId.get(id) || 0), 0);
          if (pending <= 0) continue;
          const k = `${stockClientId}:${stockItemId}`;
          availByStockKey.set(k, Math.max(0, (availByStockKey.get(k) ?? 0) - pending));
        }
      }
    }

    const includedLines = [];
    const shortageLines = [];
    for (const line of resolvedLines) {
      const key = stockKeyByItemId.get(line.itemId);
      const mapKey = `${key.stockClientId}:${key.stockItemId}`;
      const avail = Math.max(0, availByStockKey.get(mapKey) ?? 0);
      const take = Math.min(line.qty, avail);
      if (take > 0) {
        includedLines.push({ ...line, qty: take });
        availByStockKey.set(mapKey, avail - take);
      }
      if (take < line.qty) {
        shortageLines.push({
          barcode: line.barcode,
          qty_requested: line.qty,
          qty_available: take,
          qty_short: line.qty - take,
        });
      }
    }

    if (!includedLines.length) {
      throw new ValidationError(
        `Нет остатка ни по одной позиции заказа — волну создать не из чего (штрихкоды: ${shortageLines.map((s) => s.barcode).join(', ')})`
      );
    }

    // Наименования для читаемого списка дефицита в ответе (штрихкод сам по
    // себе диспетчеру ни о чём не скажет).
    if (shortageLines.length) {
      const shortageItemIds = resolvedLines
        .filter((l) => shortageLines.some((s) => s.barcode === l.barcode))
        .map((l) => l.itemId);
      const namesRes = await client.query(
        `SELECT barcode, item_name FROM wms.items WHERE tenant_id=$1 AND id = ANY($2::int[])`,
        [tenantId, shortageItemIds]
      );
      const nameByBarcode = new Map(namesRes.rows.map((r) => [r.barcode, r.item_name]));
      for (const s of shortageLines) s.item_name = nameByBarcode.get(s.barcode) || null;
    }

    const totalQty = includedLines.reduce((s, l) => s + l.qty, 0);

    await client.query(
      `INSERT INTO wms.shipments(tenant_id,warehouse_id,client_id,external_id,marketplace,status,total_planned_qty,created_by)
       VALUES($1,$2,$3,$4,'manual','new',$5,$6)`,
      [tenantId, warehouseId, clientId, shipmentCode, totalQty, createdById]
    );

    await client.query(
      `INSERT INTO wms.pick_waves(tenant_id,warehouse_id,client_id,shipment_code,status,total_tasks,notes,created_by)
       VALUES($1,$2,$3,$4,'open',$5,$6,$7)`,
      [tenantId, warehouseId, clientId, shipmentCode, includedLines.length, comment || null, createdById]
    );

    const waveRes = await client.query(
      `SELECT id FROM wms.pick_waves WHERE tenant_id=$1 AND shipment_code=$2`,
      [tenantId, shipmentCode]
    );
    const waveId = waveRes.rows[0].id;

    for (const line of includedLines) {
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
      tasks_created: includedLines.length,
      total_qty: totalQty,
      stock_shortage: shortageLines,
    };
  });
}

/**
 * Разбор выгрузки заказа из 1С ("Заказ покупателя") в строки {barcode, qty, item_name}
 * для ручного заказа — см. createManualWave выше. Только парсинг, БЕЗ записи в БД:
 * результат отдаётся на фронт, диспетчер видит распознанные строки и уже сам
 * жмёт "Создать волну на сборку" (существующий /manual-wave, без изменений).
 *
 * Формат 1С — печатный документ с объединёнными ячейками: номер/дата заказа
 * одной строкой текста ("Заказ покупателя № 171 от 18 сентября 2026 г."),
 * дальше строка-заголовок таблицы ("№", "Код", "Кол-во" и т.п. в разных
 * колонках), затем по одной строке на позицию (могут перемежаться пустыми
 * строками-спейсерами), и в конце строка "Всего наименований N, на сумму
 * X руб." — это и есть стоп-маркер конца таблицы.
 *
 * Файл может быть старым .xls (BIFF8) — exceljs (см. importItemsFromExcel в
 * items.service.js) такие читать не умеет, поэтому здесь используется xlsx
 * (SheetJS), которая одинаково читает и .xls, и .xlsx.
 *
 * @param fileBuffer Buffer содержимого загруженного .xls/.xlsx
 * @returns { order_number, order_date, lines: [{barcode, qty, item_name}] }
 */
function parseManualOrderFile(fileBuffer) {
  const XLSX = require('xlsx');

  function normHeader(s) {
    return String(s == null ? '' : s).trim().toLowerCase();
  }

  let wb;
  try {
    wb = XLSX.read(fileBuffer, { type: 'buffer' });
  } catch (e) {
    throw new ValidationError('Не удалось прочитать файл — убедитесь, что это корректный .xls/.xlsx');
  }
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new ValidationError('В файле нет ни одного листа');
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });

  // Номер/дата заказа — ищем в первых 15 строках ячейку вида "Заказ покупателя № X от Y"
  let orderNumber = null;
  let orderDate = null;
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    for (const cell of rows[r]) {
      const t = String(cell == null ? '' : cell).trim();
      const m = /заказ покупателя\s*№\s*(\S+)\s*от\s*(.+)/i.exec(t);
      if (m) {
        orderNumber = m[1].replace(/[.,]+$/, '');
        orderDate = m[2].trim();
        break;
      }
    }
    if (orderNumber) break;
  }

  // Заголовок таблицы товаров — строка, где есть и "код", и "кол-во"
  let colBarcode = null;
  let colQty = null;
  let colName = null;
  let headerRowIdx = null;
  for (let r = 0; r < Math.min(rows.length, 40); r++) {
    let foundBarcode = null;
    let foundQty = null;
    let foundName = null;
    rows[r].forEach((cell, c) => {
      const t = normHeader(cell);
      if (!t) return;
      if (t === 'код' || t === 'код товара' || t.includes('штрихкод')) foundBarcode = c;
      else if (t.includes('кол-во') || t.includes('количество')) foundQty = c;
      else if (t.includes('товар') || t.includes('наимен')) foundName = c;
    });
    if (foundBarcode != null && foundQty != null) {
      colBarcode = foundBarcode;
      colQty = foundQty;
      colName = foundName;
      headerRowIdx = r;
      break;
    }
  }
  if (headerRowIdx == null) {
    throw new ValidationError('Не нашёл в файле таблицу товаров (нет колонок "Код" и "Кол-во")');
  }

  const lines = [];
  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const joined = row.join(' ');
    if (/всего наименований/i.test(joined)) break;
    const barcode = String(row[colBarcode] == null ? '' : row[colBarcode]).trim();
    const qty = Number(row[colQty]);
    if (barcode && Number.isFinite(qty) && qty > 0) {
      const itemName = colName != null ? String(row[colName] == null ? '' : row[colName]).trim() : '';
      lines.push({ barcode, qty, item_name: itemName || null });
    }
  }

  if (!lines.length) {
    throw new ValidationError('В файле не нашлось ни одной позиции со штрихкодом и количеством');
  }

  return { order_number: orderNumber, order_date: orderDate, lines };
}

module.exports = {
  listWaves, getWaveByShipmentCode, getWaveDetail, takeWave, resetWave,
  getNextTask, scanLocation, scanItem, scanItemQty, skipTask,
  listSkippedTasks, exportSkippedStickers, exportSkippedXlsx, requeueSkippedTask, cancelSkippedTask, listCancelledTasks,
  closeWave, getWaveStatus,
  createManualWave, parseManualOrderFile,
  setShipmentPriority, assignWavePicker, listPickers,
};
