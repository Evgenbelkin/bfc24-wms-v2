'use strict';

const { query, transaction } = require('../../config/database');
const { NotFoundError, ValidationError } = require('../../utils/errors');
const logger = require('../../utils/logger');
const wbClient = require('../wb/wb.client');
const { resolvePrinter } = require('../printing/printerResolver');
const { chargeForOperation } = require('../billing/billing.service');
const { triggerRedistributionForClient } = require('../wb/wb.service');
const ledger = require('../stock/stock.ledger');

// =============================================================================
// Shipping Service
// =============================================================================

/** Табло отгрузок */
async function listShipments({
  tenantId, clientId = null, status = null, marketplace = null,
  dateFrom = null, dateTo = null, shippedFrom = null, shippedTo = null,
  limit = 100,
}) {
  const params = [tenantId]; const conds = ['s.tenant_id=$1']; let idx = 2;
  if (clientId)   { conds.push(`s.client_id=$${idx++}`); params.push(clientId); }
  if (status)     { conds.push(`s.status=$${idx++}`); params.push(status); }
  if (marketplace){ conds.push(`s.marketplace=$${idx++}`); params.push(marketplace); }
  if (dateFrom)   { conds.push(`s.created_at>=$${idx++}::date`); params.push(dateFrom); }
  if (dateTo)     { conds.push(`s.created_at<($${idx++}::date+INTERVAL '1 day')`); params.push(dateTo); }
  // Фильтр отдельно по факту отгрузки (shipped_at), а не по дате создания —
  // "когда реально уехало", а не "когда завели заказ". Нужен, чтобы можно
  // было спросить "что отгрузили за такое-то число" независимо от того,
  // когда отгрузка была создана/собрана.
  if (shippedFrom){ conds.push(`s.shipped_at>=$${idx++}::date`); params.push(shippedFrom); }
  if (shippedTo)  { conds.push(`s.shipped_at<($${idx++}::date+INTERVAL '1 day')`); params.push(shippedTo); }
  params.push(Math.min(limit, 500));
  const r = await query(
    `SELECT s.*, c.client_name, w.warehouse_name,
       su.username AS shipper_name,
       (SELECT COUNT(*)::int FROM wms.picking_tasks t WHERE t.shipment_code=s.external_id AND t.status='done') AS tasks_done,
       (SELECT COUNT(*)::int FROM wms.picking_tasks t WHERE t.shipment_code=s.external_id) AS tasks_total,
       (SELECT COALESCE(SUM(t.qty),0)::int FROM wms.picking_tasks t WHERE t.shipment_code=s.external_id) AS qty_plan,
       (SELECT pt.status FROM wms.packing_tasks pt
        WHERE pt.tenant_id=s.tenant_id AND pt.shipment_code=s.external_id
        ORDER BY pt.id DESC LIMIT 1) AS packing_status,
       (SELECT u.username FROM wms.packing_tasks pt
        LEFT JOIN wms.users u ON u.id=pt.packer_id
        WHERE pt.tenant_id=s.tenant_id AND pt.shipment_code=s.external_id
        ORDER BY pt.id DESC LIMIT 1) AS packer_name
     FROM wms.shipments s
     JOIN wms.clients c ON c.id=s.client_id
     JOIN wms.warehouses w ON w.id=s.warehouse_id
     LEFT JOIN wms.users su ON su.id=s.shipper_id
     WHERE ${conds.join(' AND ')} ORDER BY COALESCE(s.shipped_at, s.created_at) DESC LIMIT $${idx}`,
    params
  );
  return r.rows;
}

/**
 * Лёгкая "шапка" отгрузки — без полного состава (без join на items/wb_orders
 * и без LATERAL по stock_movements на каждую строку picking_tasks). Только
 * сам shipment + план/собрано агрегатом.
 *
 * Нужна отдельно от getShipmentDetails() потому что на карточке отгрузки
 * самое важное и срочное — как можно быстрее показать поле сканирования
 * (отгрузчику часто нужно просто отсканировать код поставки, состав его не
 * интересует), а полный список позиций на отгрузках с полсотней строк
 * (полсотни JOIN'ов на items + wb_orders + LATERAL-подзапрос по движениям на
 * КАЖДУЮ строку) заметно тормозит открытие карточки. См. shipping.html —
 * шапка запрашивается и рисуется сразу, состав подтягивается следом отдельным
 * запросом, не блокируя возможность сканировать.
 */
async function getShipmentHeader({ tenantId, shipmentCode }) {
  const shipRes = await query(
    `SELECT s.*, c.client_name, w.warehouse_name, su.username AS shipper_name
     FROM wms.shipments s
     JOIN wms.clients c ON c.id=s.client_id
     JOIN wms.warehouses w ON w.id=s.warehouse_id
     LEFT JOIN wms.users su ON su.id=s.shipper_id
     WHERE s.tenant_id=$1 AND s.external_id=$2 ORDER BY s.id DESC LIMIT 1`,
    [tenantId, shipmentCode]
  );
  if (shipRes.rowCount === 0) throw new NotFoundError(`Shipment '${shipmentCode}'`);
  const shipment = shipRes.rows[0];

  const totalsRes = await query(
    `SELECT COALESCE(SUM(qty),0)::int AS plan, COALESCE(SUM(qty_picked),0)::int AS picked
     FROM wms.picking_tasks WHERE tenant_id=$1 AND shipment_code=$2`,
    [tenantId, shipmentCode]
  );

  return { shipment, totals: totalsRes.rows[0] };
}

/** Детали отгрузки (полный состав — тяжелее, см. getShipmentHeader выше) */
async function getShipmentDetails({ tenantId, shipmentCode }) {
  const shipRes = await query(
    `SELECT s.*, c.client_name, w.warehouse_name, su.username AS shipper_name
     FROM wms.shipments s
     JOIN wms.clients c ON c.id=s.client_id
     JOIN wms.warehouses w ON w.id=s.warehouse_id
     LEFT JOIN wms.users su ON su.id=s.shipper_id
     WHERE s.tenant_id=$1 AND s.external_id=$2 ORDER BY s.id DESC LIMIT 1`,
    [tenantId, shipmentCode]
  );
  if (shipRes.rowCount === 0) throw new NotFoundError(`Shipment '${shipmentCode}'`);
  const shipment = shipRes.rows[0];

  // Строки
  // ВАЖНО: джойн на wms.wb_orders раньше матчился по (wb_supply_id, barcode) —
  // если в ОДНОЙ поставке два разных заказа брали один и тот же штрихкод
  // (обычное дело, ничего страшного), такой join фанаутил одну строку
  // picking_tasks в несколько результатов (по числу совпавших заказов),
  // и "Собрано X/Y" на карточке отгрузки завышалось. У picking_tasks уже
  // есть точный wb_order_id конкретного заказа, под который создана
  // задача — джойним по нему, а не по штрихкоду, чтобы строго 1:1.
  const linesRes = await query(
    `SELECT
       pt.id AS task_id, pt.barcode, pt.qty, pt.status AS picking_status,
       pt.qty_picked, pt.location_code,
       i.item_name, i.vendor_code, i.wb_nm_id, i.size, i.preview_url,
       wo.wb_sticker, wo.wb_sticker_code,
       COALESCE(pm.packed_qty, 0)::int AS qty_packed
     FROM wms.picking_tasks pt
     LEFT JOIN wms.items i ON i.id=pt.item_id
     LEFT JOIN wms.wb_orders wo ON wo.tenant_id=$1 AND wo.wb_order_id=pt.wb_order_id AND wo.wb_sticker IS NOT NULL
     LEFT JOIN LATERAL (
       SELECT SUM(m.qty)::int AS packed_qty FROM wms.stock_movements m
       WHERE m.tenant_id=$1 AND m.movement_type='packing' AND m.ref_type='shipment' AND m.ref_id=$3 AND m.barcode=pt.barcode
     ) pm ON TRUE
     WHERE pt.tenant_id=$1 AND pt.shipment_code=$2
     ORDER BY i.item_name, pt.barcode`,
    [tenantId, shipmentCode, shipment.id]
  );

  // Для отменённых отгрузок отдельно считаем "висящий" остаток: что было
  // реально собрано (picking_tasks.status='done'), за вычетом того, что уже
  // вернули на склад через "Вернуть на склад" (см. returnPickedStock —
  // движения с movement_type='return', ref_type='shipment_cancel', привязка
  // по этой же отгрузке). Пересчитываем каждый раз, а не сохраняем один раз
  // при отмене — иначе список потеряется при повторном открытии страницы
  // и не уменьшится по мере частичного возврата.
  let alreadyPicked = [];
  if (shipment.status === 'cancelled') {
    const r = await query(
      `SELECT picked.barcode, picked.item_name, picked.size, (picked.qty - COALESCE(returned.qty, 0))::int AS qty
       FROM (
         SELECT pt.barcode, i.item_name, i.size, SUM(pt.qty)::int AS qty
         FROM wms.picking_tasks pt
         LEFT JOIN wms.items i ON i.id = pt.item_id
         WHERE pt.tenant_id=$1 AND pt.shipment_code=$2 AND pt.status='done'
         GROUP BY pt.barcode, i.item_name, i.size
       ) picked
       LEFT JOIN (
         SELECT barcode, SUM(qty)::int AS qty
         FROM wms.stock_movements
         WHERE tenant_id=$1 AND ref_type='shipment_cancel' AND ref_id=$3 AND movement_type='return'
         GROUP BY barcode
       ) returned ON returned.barcode = picked.barcode
       WHERE (picked.qty - COALESCE(returned.qty, 0)) > 0
       ORDER BY picked.item_name`,
      [tenantId, shipmentCode, shipment.id]
    );
    alreadyPicked = r.rows;
  }

  return { shipment, lines: linesRes.rows, already_picked: alreadyPicked };
}

/** Подтверждение отгрузки (скан QR поставки) */
async function confirmShipment({ tenantId, shipmentCode, scannedCode, userId }) {
  const scanned = String(scannedCode || '').trim();
  if (!scanned) throw new ValidationError('scanned_code is required');

  let shipmentId = null;
  let chargeClientId = null, chargeQty = 0;
  let chargeItemRows = []; // для прогрессивной тарификации 'processing' по объёму — см. ниже после commit

  const txResult = await transaction(async (client) => {
    // Находим shipment
    const shipRes = await client.query(
      `SELECT * FROM wms.shipments WHERE tenant_id=$1 AND external_id=$2 ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [tenantId, shipmentCode]
    );
    if (shipRes.rowCount === 0) throw new NotFoundError(`Shipment '${shipmentCode}'`);
    const shipment = shipRes.rows[0];

    // Идемпотентность: если уже in_transit — возвращаем успех. Но если ВБ
    // так и не был уведомлён об этом раньше (wb_delivered_at ещё NULL — баг
    // до этого фикса, когда deliverSupply вообще не вызывался) — даём
    // возможность повторной попытки прямо через повторный скан.
    if (shipment.status === 'in_transit') {
      shipmentId = shipment.id;
      return {
        ok: true, shipmentId: shipment.id,
        shipmentCode: shipment.external_id,
        status: 'in_transit', alreadyShipped: true,
        qr_base64: shipment.wb_supply_qr_base64 || null,
        needsWbDeliver: !shipment.wb_delivered_at,
      };
    }

    // Проверяем статус
    if (!['ready_to_ship', 'shipping'].includes(shipment.status)) {
      throw new ValidationError(`Cannot confirm shipment in status '${shipment.status}'`);
    }

    // Проверяем что picking завершён (нет задач в статусе new/in_progress)
    const pickingCheck = await client.query(
      `SELECT COUNT(*)::int AS n FROM wms.picking_tasks
       WHERE tenant_id=$1 AND shipment_code=$2 AND status IN ('new','in_progress')`,
      [tenantId, shipmentCode]
    );
    if (pickingCheck.rows[0].n > 0) {
      throw new ValidationError(
        `Cannot ship: ${pickingCheck.rows[0].n} picking tasks are still active for this shipment`
      );
    }

    // Проверяем что сканированный код соответствует кодам поставки
    const normalizedScanned  = scanned.toUpperCase().trim();
    const normalizedExternal = shipment.external_id.toUpperCase().trim();
    const wbSupplyShort = normalizedExternal.replace(/^WB-GI-/i, '');

    if (normalizedScanned !== normalizedExternal && normalizedScanned !== wbSupplyShort) {
      throw new ValidationError(
        `Scanned code '${scanned}' does not match shipment '${shipment.external_id}'`
      );
    }

    // Фактически отгружено, по каждому товару — сумма done picking tasks,
    // сгруппированная по item_id/barcode. stock_movements.item_id и .barcode
    // NOT NULL, поэтому одна агрегированная строка на всю поставку (как было
    // раньше) невозможна — пишем одну документальную запись 'shipping' на
    // каждый товар.
    const shippedByItemRes = await client.query(
      `SELECT pt.item_id, pt.barcode, i.volume_liters,
              COALESCE(SUM(pt.qty_picked), 0)::int AS shipped_qty
       FROM wms.picking_tasks pt
       LEFT JOIN wms.items i ON i.id = pt.item_id
       WHERE pt.tenant_id=$1 AND pt.shipment_code=$2 AND pt.status='done'
       GROUP BY pt.item_id, pt.barcode, i.volume_liters
       HAVING COALESCE(SUM(pt.qty_picked), 0) > 0`,
      [tenantId, shipmentCode]
    );
    const totalShipped = shippedByItemRes.rows.reduce((s, r) => s + Number(r.shipped_qty), 0);

    // Записываем документальное движение shipping (без ячейки — это факт отгрузки)
    // Реальное списание со склада уже произошло в picking через consumeStock.
    // FROM берём КОНКРЕТНУЮ ячейку зоны отгрузки, куда упаковщик реально поставил
    // короб (shipment.packing_location_id) — если она есть; для старых отгрузок
    // (до этого исправления, где ячейка после упаковки не была обязательной)
    // откатываемся на первую активную ячейку типа shipping, как и раньше.
    for (const row of shippedByItemRes.rows) {
      await client.query(
        `INSERT INTO wms.stock_movements
           (tenant_id, warehouse_id, client_id, item_id, barcode,
            movement_type, qty, from_location_id, to_location_id,
            ref_type, ref_id, user_id, comment)
         SELECT
           $1, $2, $3, $4, $5,
           'shipping', $6,
           COALESCE(
             (SELECT l.id FROM wms.locations l WHERE l.id=$9 AND l.tenant_id=$1 AND l.is_active=TRUE),
             (SELECT l.id FROM wms.locations l WHERE l.tenant_id=$1 AND l.location_type='shipping' AND l.is_active=TRUE LIMIT 1)
           ),
           NULL,
           'shipment', $7, $8, 'Документальная отгрузка перевозчику'
         WHERE EXISTS (
           SELECT 1 FROM wms.locations l
           WHERE l.tenant_id=$1 AND l.is_active=TRUE
             AND (l.id=$9 OR l.location_type='shipping')
         )
         ON CONFLICT DO NOTHING`,
        [tenantId, shipment.warehouse_id, shipment.client_id, row.item_id, row.barcode,
         row.shipped_qty, shipment.id, userId, shipment.packing_location_id]
      );
    }

    // Обновляем статус
    await client.query(
      `UPDATE wms.shipments
       SET status='in_transit', shipped_at=NOW(), shipper_id=$1,
           total_shipped_qty=$2, updated_at=NOW()
       WHERE id=$3`,
      [userId, totalShipped, shipment.id]
    );

    // Закрываем 'confirm'-заказы WB этой поставки в 'shipped' ПРЯМО ЗДЕСЬ, а
    // не дожидаясь отдельного опроса WB (syncDeliveryStatusForTenant ловит
    // только переход 'in_transit'->'done', раз в 15 минут). Правка 28.08.2026
    // (инцидент с массовым "не ушло в WB"): реальное списание остатка со
    // склада уже произошло раньше, в picking (см. consumeStock) - к этому
    // моменту ВСЕ picking_tasks поставки гарантированно 'done' (проверка выше
    // по коду, "Cannot ship: N picking tasks are still active"). Значит
    // физически эти единицы уже не часть остатка ни в каком виде - продолжать
    // вычитать их ещё раз по статусу заказа (distributeStockForAccount,
    // newOrdersByBarcode) при расчёте остатка для WB - двойной счёт, который
    // и стал причиной массового расхождения WMS/WB. Раньше это закрывалось
    // только на 'done' (когда WB сам подтвердит приёмку) - оставляя окно в
    // среднем в несколько часов/дней, где 'confirm' занижал остаток уже после
    // реальной физической отгрузки.
    await client.query(
      `UPDATE wms.wb_orders SET status='shipped'
       WHERE tenant_id=$1 AND wb_supply_id=$2 AND status='confirm'`,
      [tenantId, shipment.external_id]
    );

    shipmentId = shipment.id;
    chargeClientId = shipment.client_id;
    chargeQty = totalShipped;
    chargeItemRows = shippedByItemRes.rows;

    return {
      ok: true,
      shipmentId:   shipment.id,
      shipmentCode: shipment.external_id,
      status:       'in_transit',
      totalShipped,
      needsWbDeliver: true,
    };
  });

  // chargeClientId остаётся null для идемпотентной ветки (уже in_transit) —
  // повторный скан не начисляет клиенту дважды.
  if (chargeClientId && chargeQty > 0) {
    chargeForOperation({ tenantId, clientId: chargeClientId, serviceType: 'shipping', quantity: chargeQty, refType: 'shipment', refId: shipmentId });

    // Прогрессивная тарификация "Обработка" по объёму товара (30₽ первый литр +
    // 2₽ каждый следующий, например) — альтернатива фиксированным сборке/отгрузке.
    // Начисляется ПОШТУЧНО по каждой позиции (у каждого товара свой объём),
    // поэтому не через общий chargeQty, а по строкам shippedByItemRes. Если для
    // клиента прайс на service_type='processing' не настроен — silent no-op
    // (см. chargeForOperation), как и для остальных услуг. Если настроен ещё и
    // старый прайс на picking/shipping — начислится и то, и другое, поэтому
    // для клиентов на новой схеме нужно убрать/не заводить прайс на picking/shipping.
    for (const row of chargeItemRows) {
      chargeForOperation({
        tenantId, clientId: chargeClientId, serviceType: 'processing',
        quantity: row.shipped_qty, volumeLiters: row.volume_liters,
        refType: 'shipment_item', refId: shipmentId, itemBarcode: row.barcode,
      });
    }

    // ПРАВКА 28.08.2026 (обсуждение архитектуры): раньше здесь стоял
    // немедленный пересчёт/пуш остатка в WB, обоснованный тем, что заказы
    // поставки только что закрылись 'confirm'->'shipped' и "освободили"
    // немного остатка. Убрано намеренно - физически товар был списан раньше,
    // на сборке (см. комментарий выше "Реальное списание со склада уже
    // произошло в picking"), а WB узнал об этой продаже ещё в момент СОЗДАНИЯ
    // заказа, задолго до отгрузки - сама отгрузка ничего не меняет для WB.
    // Закрытие 'confirm'->'shipped' влияет только на точность СЛЕДУЮЩЕГО
    // пуша (приёмка/инвентаризация/8-часовой пересчёт), которому и так не
    // требуется ждать - перед ним система заново подтягивает актуальные
    // статусы заказов. Толкать пуш прямо здесь - лишняя нагрузка на WB API
    // при высоком темпе отгрузок без выигрыша в корректности.
  }

  // ВАЖНО: порядок здесь принципиален. WB отдаёт РЕАЛЬНЫЙ QR/штрихкод поставки
  // только когда поставка уже помечена "в доставке" (PATCH .../deliver) — если
  // запросить штрихкод РАНЬШЕ этого вызова, WB возвращает пусто, и печать
  // поставки просто никогда не срабатывает (баг, из-за которого QR не печатался
  // вообще). Поэтому сначала уведомляем WB о передаче перевозчику, и только
  // потом идём за штрихкодом. Оба шага — после commit транзакции, чтобы не
  // держать DB-соединение открытым во время похода в сеть; soft-fail — сбой
  // здесь не должен откатывать уже свершившуюся физическую отгрузку.
  if (shipmentId && txResult.needsWbDeliver) {
    const deliverResult = await notifyWbSupplyDelivered({ tenantId, shipmentId, shipmentCode });
    txResult.wbDelivered      = deliverResult.ok;
    txResult.wbDeliverSkipped = deliverResult.reason === 'no_wb_account';
    if (!deliverResult.ok && deliverResult.reason !== 'no_wb_account') {
      txResult.wbDeliverError = deliverResult.message || 'Не удалось передать статус в WB';
    }
  }

  // Забираем QR, только если ещё не забирали успешно раньше — так повторный
  // скан (например, если в прошлый раз deliverSupply выше ещё не был вызван
  // или упал) сам дотянет QR, не создавая дублей задания на печать.
  if (shipmentId && !txResult.qr_base64) {
    let qrBase64 = null;
    try {
      qrBase64 = await fetchWbSupplyQrAfterCommit({ tenantId, shipmentCode });
    } catch (e) {
      logger.warn({ err: e, shipmentCode }, 'WB QR fetch failed (soft-fail)');
    }

    if (qrBase64) {
      try {
        await query(
          `UPDATE wms.shipments SET wb_supply_qr_base64=$1 WHERE id=$2`,
          [qrBase64, shipmentId]
        );
        // print_job для QR
        await createQrPrintJobDirect({ tenantId, shipmentId, qrBase64, userId });
      } catch (e) {
        logger.warn({ err: e }, 'QR save/print failed (soft-fail)');
      }
    }

    txResult.qr_base64 = qrBase64;
  }

  return txResult;
}

/** Сообщить ВБ, что поставка передана перевозчику. Soft-fail: ошибка
 *  здесь не должна ломать уже подтверждённую локально отгрузку — просто
 *  сообщаем о результате наверх, чтобы отгрузчик мог решить, что делать
 *  (например, продублировать вручную в кабинете ВБ). */
async function notifyWbSupplyDelivered({ tenantId, shipmentId, shipmentCode }) {
  const accRes = await query(
    `SELECT ma.api_token FROM wms.mp_accounts ma
     JOIN wms.wb_supplies ws ON ws.mp_account_id=ma.id
     WHERE ws.tenant_id=$1 AND ws.supply_code=$2 AND ma.is_active=TRUE
     LIMIT 1`,
    [tenantId, shipmentCode]
  );
  if (accRes.rowCount === 0 || !accRes.rows[0].api_token) {
    return { ok: false, reason: 'no_wb_account' };
  }
  const token = accRes.rows[0].api_token;

  try {
    await wbClient.deliverSupply(token, shipmentCode);
  } catch (e) {
    logger.warn({ err: e, shipmentCode }, 'WB deliverSupply failed (soft-fail)');
    return { ok: false, reason: 'wb_api_error', message: e.message };
  }

  try {
    await query(`UPDATE wms.shipments SET wb_delivered_at=NOW() WHERE id=$1`, [shipmentId]);
  } catch (e) {
    logger.warn({ err: e, shipmentId }, 'Failed to persist wb_delivered_at (soft-fail)');
  }

  return { ok: true };
}

// NB: эти две функции намеренно используют пуловый `query()`, а не `client.query()` —
// они вызываются ПОСЛЕ commit транзакции confirmShipment(), чтобы не держать
// DB-соединение открытым во время похода в WB API по сети.
async function fetchWbSupplyQrAfterCommit({ tenantId, shipmentCode }) {
  // Ищем WB-аккаунт для этого tenant/supply
  const accRes = await query(
    `SELECT ma.api_token FROM wms.mp_accounts ma
     JOIN wms.wb_supplies ws ON ws.mp_account_id=ma.id
     WHERE ws.tenant_id=$1 AND ws.supply_code=$2 AND ma.is_active=TRUE
     LIMIT 1`,
    [tenantId, shipmentCode]
  );
  if (accRes.rowCount === 0) return null;
  const token = accRes.rows[0].api_token;
  if (!token) return null;

  // WB ждёт полный id поставки вида WB-GI-XXXXXXX в path — срезать префикс не нужно
  // (см. правку в wb.client.js: пример path-параметра в доке WB всегда с префиксом).
  const supplyId = /^WB-GI-/i.test(shipmentCode) ? shipmentCode : `WB-GI-${shipmentCode}`;

  const resp = await fetch(
    `https://marketplace-api.wildberries.ru/api/v3/supplies/${encodeURIComponent(supplyId)}/barcode?type=svg`,
    { headers: { Authorization: token } }
  );
  if (!resp.ok) return null;
  const data = await resp.json().catch(() => null);
  return data?.file || null;
}

async function createQrPrintJobDirect({ tenantId, shipmentId, qrBase64, userId }) {
  // Рабочее место сотрудника отгрузки (своя зона отгрузки со своим принтером),
  // иначе — общий маршрут shipping_qr как раньше.
  const resolved = await resolvePrinter(query, {
    tenantId, docType: 'shipping_qr', employeeId: userId,
  });
  if (!resolved) return;
  const jobCode = `SHIPQR-${shipmentId}-${Date.now()}`;
  await query(
    `INSERT INTO wms.print_jobs
       (tenant_id,job_code,printer_id,doc_type,entity_type,entity_id,copies,payload_json,status,created_by)
     VALUES($1,$2,$3,'shipping_qr','shipment',$4,1,$5::jsonb,'new',$6)`,
    [tenantId, jobCode, resolved.printerId, shipmentId,
     JSON.stringify({ qr_base64: qrBase64 }), userId]
  );
}

/** Ручное подтверждение доставки — для отгрузок, у которых нет автоматического
 *  источника подтверждения (marketplace='manual' — фоновая проверка WB API их
 *  не видит, а других маркетплейсов, которые бы подтверждали приёмку, у нас
 *  пока нет). Разрешаем и для 'wb' тоже — как ручной override на случай, если
 *  авто-проверка почему-то не сработала (нет токена, аккаунт отключён и т.п.) —
 *  супервайзер/админ сам знает, что груз реально доставлен. */
async function markDelivered({ tenantId, shipmentCode, userId }) {
  const r = await query(
    `UPDATE wms.shipments
     SET status='done', delivered_at=NOW(), delivered_by=$1, updated_at=NOW()
     WHERE tenant_id=$2 AND external_id=$3 AND status='in_transit'
     RETURNING id, external_id, status, delivered_at`,
    [userId, tenantId, shipmentCode]
  );
  if (r.rowCount === 0) {
    // Отдельно проверяем, есть ли вообще такая отгрузка — чтобы не путать
    // "не найдена" с "уже не в статусе in_transit" (например, кто-то другой
    // уже отметил её, или WB-автопроверка успела сработать первой).
    const exists = await query(`SELECT status FROM wms.shipments WHERE tenant_id=$1 AND external_id=$2`, [tenantId, shipmentCode]);
    if (exists.rowCount === 0) throw new NotFoundError('Shipment', shipmentCode);
    throw new ValidationError(`Отгрузка сейчас в статусе '${exists.rows[0].status}', подтвердить доставку можно только из статуса 'в пути'`);
  }
  return r.rows[0];
}

/**
 * Отменить/снять с учёта зависшую отгрузку — для случая, когда упаковка
 * заблокировалась (например, код "Честный знак" не нашёлся в пуле) и
 * продавец в итоге отгрузил заказ прямо в кабинете WB в обход ВМС. Такая
 * отгрузка в wms.shipments навсегда остаётся в незавершённом статусе —
 * реконсиляция wb_orders её не видит (см. комментарий в wb.service.js:
 * она сверяет только заказы БЕЗ wb_supply_id, а у отгрузки он уже есть).
 * Снимает резервы по ещё активным задачам сборки, отменяет сами задачи
 * сборки/упаковки, переводит отгрузку в status='cancelled' (это значение
 * есть в enum с самого начала, но раньше его никто не проставлял).
 *
 * Разрешено из ЛЮБОГО статуса, кроме 'done' (уже реально доставлено —
 * отменять нечего) и 'cancelled' (уже отменена).
 */
async function cancelShipment({ tenantId, shipmentCode, userId, reason }) {
  return transaction(async (client) => {
    const shipRes = await client.query(
      `SELECT * FROM wms.shipments WHERE tenant_id=$1 AND external_id=$2 FOR UPDATE`,
      [tenantId, shipmentCode]
    );
    if (shipRes.rowCount === 0) throw new NotFoundError('Shipment', shipmentCode);
    const shipment = shipRes.rows[0];
    if (shipment.status === 'done') {
      throw new ValidationError('Отгрузка уже отмечена как доставленная — отменять нечего.');
    }
    if (shipment.status === 'cancelled') {
      throw new ValidationError('Отгрузка уже отменена.');
    }

    // Снимаем резервы и отменяем ещё активные задачи сборки этой отгрузки —
    // иначе ячейки/остаток так и останутся зарезервированы под задачу,
    // которую больше никто никогда не выполнит.
    const activeTasks = await client.query(
      `SELECT id FROM wms.picking_tasks WHERE tenant_id=$1 AND shipment_code=$2 AND status IN ('new','in_progress')`,
      [tenantId, shipmentCode]
    );
    for (const t of activeTasks.rows) {
      await ledger.releaseReservationByRef({ refType: 'picking_task', refId: t.id, status: 'cancelled', dbClient: client });
    }
    await client.query(
      `UPDATE wms.picking_tasks SET status='cancelled', finished_at=NOW(), updated_at=NOW()
       WHERE tenant_id=$1 AND shipment_code=$2 AND status IN ('new','in_progress')`,
      [tenantId, shipmentCode]
    );
    await client.query(
      `UPDATE wms.packing_tasks SET status='cancelled', updated_at=NOW()
       WHERE tenant_id=$1 AND shipment_code=$2 AND status IN ('new','in_progress')`,
      [tenantId, shipmentCode]
    );

    // ВАЖНО: задачи сборки со status='done' здесь НЕ трогаем — по ним товар
    // уже физически снят с полки (consumeStock сработал ещё в момент сборки,
    // см. picking.service.js:387) и стоит сейчас где-то у упаковщика/на столе
    // упаковки, а не в исходной ячейке. Система не знает, где эти единицы
    // физически лежат ПРЯМО СЕЙЧАС — молча "вернуть" их куда-то было бы
    // враньём в остатках. Вместо этого просто честно перечисляем их вызывающей
    // стороне (по товару и количеству), чтобы кладовщик нашёл эти единицы
    // руками и провёл через "Вернуть на склад" ниже — там ОН укажет
    // актуальную ячейку, а не система угадает.
    const alreadyPickedRes = await client.query(
      `SELECT pt.barcode, i.item_name, i.size, SUM(pt.qty)::int AS qty
       FROM wms.picking_tasks pt
       LEFT JOIN wms.items i ON i.id = pt.item_id
       WHERE pt.tenant_id=$1 AND pt.shipment_code=$2 AND pt.status='done'
       GROUP BY pt.barcode, i.item_name, i.size
       ORDER BY i.item_name`,
      [tenantId, shipmentCode]
    );

    const r = await client.query(
      `UPDATE wms.shipments
       SET status='cancelled', cancelled_at=NOW(), cancelled_by=$1, cancel_reason=$2, updated_at=NOW()
       WHERE id=$3
       RETURNING id, external_id, status, cancelled_at`,
      [userId, reason || null, shipment.id]
    );
    return {
      ...r.rows[0],
      picking_tasks_cancelled: activeTasks.rowCount,
      already_picked: alreadyPickedRes.rows,
    };
  });
}

/**
 * Вернуть в остатки единицы, которые уже были собраны (сняты с полки) для
 * отменённой отгрузки, но так и не уехали — кладовщик физически нашёл их
 * (обычно на столе упаковки/в таре сборщика) и указывает, в какую ячейку
 * кладёт их СЕЙЧАС. См. cancelShipment.already_picked — ровно тот список,
 * который нужно провести через этот метод по одной строке за раз.
 * Тот же принцип, что и в returns.service.js (оператор с товаром в руках
 * сам называет ячейку — система не угадывает физическое место).
 */
async function returnPickedStock({ tenantId, shipmentCode, barcode, qty, locationCode, userId }) {
  const shipRes = await query(
    `SELECT id, warehouse_id, client_id, status FROM wms.shipments WHERE tenant_id=$1 AND external_id=$2`,
    [tenantId, shipmentCode]
  );
  if (shipRes.rowCount === 0) throw new NotFoundError('Shipment', shipmentCode);
  const shipment = shipRes.rows[0];
  if (shipment.status !== 'cancelled') {
    throw new ValidationError('Возврат на склад доступен только для отменённой отгрузки.');
  }

  const result = await ledger.receiveStock({
    tenantId, warehouseId: shipment.warehouse_id, clientId: shipment.client_id,
    barcode, locationCode, qty,
    refType: 'shipment_cancel', refId: shipment.id, movementType: 'return',
    userId, comment: `Возврат на склад после отмены отгрузки ${shipmentCode} (собрано, но не упаковано/не отгружено)`,
  });

  // Возврат кладёт товар обратно в ячейку (часто ту же ячейку отбора, откуда
  // его собирали) - тот же класс проблемы, что и в placement/movement/returns:
  // без явного пересчёта WB не узнает о выросшем остатке сам.
  logger.info({ tenantId, clientId: shipment.client_id, barcode }, 'Return-picked-stock triggered WB redistribution');
  triggerRedistributionForClient({ tenantId, clientId: shipment.client_id, barcodes: [barcode] });

  return result;
}

module.exports = { listShipments, getShipmentHeader, getShipmentDetails, confirmShipment, markDelivered, cancelShipment, returnPickedStock };
