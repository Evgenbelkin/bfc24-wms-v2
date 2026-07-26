'use strict';

const { query, transaction } = require('../../config/database');
const { NotFoundError, ValidationError } = require('../../utils/errors');
const logger = require('../../utils/logger');
const wbClient = require('../wb/wb.client');
const { resolvePrinter } = require('../printing/printerResolver');

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

/** Детали отгрузки */
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
  const linesRes = await query(
    `SELECT
       pt.id AS task_id, pt.barcode, pt.qty, pt.status AS picking_status,
       pt.qty_picked, pt.location_code,
       i.item_name, i.vendor_code, i.preview_url,
       wo.wb_sticker, wo.wb_sticker_code,
       COALESCE(pm.packed_qty, 0)::int AS qty_packed
     FROM wms.picking_tasks pt
     LEFT JOIN wms.items i ON i.id=pt.item_id
     LEFT JOIN wms.wb_orders wo ON wo.tenant_id=$1 AND wo.wb_supply_id=$2 AND wo.barcode=pt.barcode AND wo.wb_sticker IS NOT NULL
     LEFT JOIN LATERAL (
       SELECT SUM(m.qty)::int AS packed_qty FROM wms.stock_movements m
       WHERE m.tenant_id=$1 AND m.movement_type='packing' AND m.ref_type='shipment' AND m.ref_id=$3 AND m.barcode=pt.barcode
     ) pm ON TRUE
     WHERE pt.tenant_id=$1 AND pt.shipment_code=$2
     ORDER BY i.item_name, pt.barcode`,
    [tenantId, shipmentCode, shipment.id]
  );

  return { shipment, lines: linesRes.rows };
}

/** Подтверждение отгрузки (скан QR поставки) */
async function confirmShipment({ tenantId, shipmentCode, scannedCode, userId }) {
  const scanned = String(scannedCode || '').trim();
  if (!scanned) throw new ValidationError('scanned_code is required');

  let shipmentId = null;

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
      `SELECT pt.item_id, pt.barcode, COALESCE(SUM(pt.qty_picked), 0)::int AS shipped_qty
       FROM wms.picking_tasks pt
       WHERE pt.tenant_id=$1 AND pt.shipment_code=$2 AND pt.status='done'
       GROUP BY pt.item_id, pt.barcode
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

    shipmentId = shipment.id;
    return {
      ok: true,
      shipmentId:   shipment.id,
      shipmentCode: shipment.external_id,
      status:       'in_transit',
      totalShipped,
      needsWbDeliver: true,
    };
  });

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

module.exports = { listShipments, getShipmentDetails, confirmShipment, markDelivered };
