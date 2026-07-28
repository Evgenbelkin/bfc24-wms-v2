'use strict';

const { query, transaction } = require('../../config/database');
const { NotFoundError, ValidationError, ForbiddenError } = require('../../utils/errors');
const { validatePositiveInt } = require('../../utils/validators');
const { resolvePrinter } = require('../printing/printerResolver');
const { chargeForOperation } = require('../billing/billing.service');
const logger = require('../../utils/logger');

// =============================================================================
// Packing Service
// packing/next → scan-item × N → confirm
// Печать стикеров — soft-fail: ошибка печати не ломает упаковку
// =============================================================================

/** Получить или взять задачу на упаковку */
async function getOrTakePackingTask({ tenantId, packerId }) {
  return transaction(async (client) => {
    // Сначала — уже активная у этого пакера
    const active = await client.query(
      `SELECT pt.*, s.external_id AS shipment_code_from_shipment
       FROM wms.packing_tasks pt
       LEFT JOIN wms.shipments s ON s.tenant_id=pt.tenant_id AND s.external_id=pt.shipment_code
       WHERE pt.tenant_id=$1 AND pt.packer_id=$2 AND pt.status IN ('new','in_progress')
       ORDER BY CASE WHEN pt.status='in_progress' THEN 0 ELSE 1 END, pt.id
       LIMIT 1`,
      [tenantId, packerId]
    );
    if (active.rowCount > 0) {
      const task = active.rows[0];
      if (task.status === 'new') {
        await client.query(
          `UPDATE wms.packing_tasks SET status='in_progress', updated_at=NOW() WHERE id=$1`,
          [task.id]
        );
        task.status = 'in_progress';
      }
      return task;
    }

    // Берём свободную
    const free = await client.query(
      `UPDATE wms.packing_tasks SET packer_id=$1, status='in_progress', updated_at=NOW()
       WHERE id=(
         SELECT id FROM wms.packing_tasks
         WHERE tenant_id=$2 AND status='new' AND packer_id IS NULL
         ORDER BY priority ASC, id ASC
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       RETURNING *`,
      [packerId, tenantId]
    );
    return free.rowCount > 0 ? free.rows[0] : null;
  });
}

/** Детали задачи на упаковку (состав отгрузки) */
async function getPackingTaskDetails({ tenantId, shipmentCode, shipmentId = null }) {
  // Получаем отгрузку
  let shipment;
  if (shipmentId) {
    const r = await query(
      `SELECT * FROM wms.shipments WHERE id=$1 AND tenant_id=$2`, [shipmentId, tenantId]
    );
    if (r.rowCount === 0) throw new NotFoundError('Shipment', shipmentId);
    shipment = r.rows[0];
  } else {
    const r = await query(
      `SELECT * FROM wms.shipments WHERE tenant_id=$1 AND external_id=$2 ORDER BY id DESC LIMIT 1`,
      [tenantId, shipmentCode]
    );
    if (r.rowCount === 0) throw new NotFoundError(`Shipment '${shipmentCode}'`);
    shipment = r.rows[0];
  }

  // Строки: план из picking_tasks
  const planRes = await query(
    `SELECT
       pt.barcode,
       MAX(pt.location_code) AS location_code,
       SUM(pt.qty)::int AS qty_plan,
       i.item_name, i.vendor_code, i.unit, i.preview_url
     FROM wms.picking_tasks pt
     LEFT JOIN wms.items i ON i.id=pt.item_id
     WHERE pt.tenant_id=$1 AND pt.shipment_code=$2 AND pt.status IN ('new','in_progress','done')
     GROUP BY pt.barcode, i.item_name, i.vendor_code, i.unit, i.preview_url
     ORDER BY i.item_name, pt.barcode`,
    [tenantId, shipment.external_id]
  );

  // Уже упаковано из movements
  const packedRes = await query(
    `SELECT m.barcode, SUM(m.qty)::int AS qty_packed
     FROM wms.stock_movements m
     WHERE m.tenant_id=$1 AND m.movement_type='packing' AND m.ref_type='shipment' AND m.ref_id=$2
     GROUP BY m.barcode`,
    [tenantId, shipment.id]
  );
  const packedMap = Object.fromEntries(packedRes.rows.map(r => [r.barcode, Number(r.qty_packed)]));

  // WB стикеры — по одному штрихкоду в поставке может быть НЕСКОЛЬКО заказов
  // (несколько физических единиц одного и того же товара), и у каждой единицы
  // свой уникальный стикер ВБ. Раньше брали DISTINCT ON — только один "образец"
  // стикера на весь штрихкод, из-за чего упаковщик не мог заранее увидеть ВСЕ
  // стикеры, которые должны напечататься по этому товару. Теперь берём их все,
  // в том же порядке (ORDER BY id), в котором scanItem их потом раздаёт по
  // OFFSET — так позиция в списке 1:1 соответствует тому, какой скан по счёту
  // какой стикер печатает.
  const stickersRes = await query(
    `SELECT wo.barcode, wo.wb_sticker, wo.wb_sticker_code
     FROM wms.wb_orders wo
     WHERE wo.tenant_id=$1 AND wo.wb_supply_id=$2 AND wo.wb_sticker_code IS NOT NULL
     ORDER BY wo.barcode, wo.id`,
    [tenantId, shipment.external_id]
  );
  const stickersByBarcode = {};
  for (const r of stickersRes.rows) {
    (stickersByBarcode[r.barcode] ||= []).push({ code: r.wb_sticker_code, image: r.wb_sticker });
  }

  const lines = planRes.rows.map(row => {
    const stickers = stickersByBarcode[row.barcode] || [];
    return {
      ...row,
      qty_packed: packedMap[row.barcode] || 0,
      stickers,                                   // [{code, image}, ...] — по одному на каждую единицу товара
      wb_sticker:      stickers[0]?.image || null, // для обратной совместимости
      wb_sticker_code: stickers[0]?.code  || null,
    };
  });

  // Откуда забрать сборочный лист — МХ, на который сборщик поставил короб при
  // закрытии волны (picking.closeWave). Без этого упаковщик не понимает,
  // куда физически идти за коробкой.
  const waveRes = await query(
    `SELECT buffer_location_code FROM wms.pick_waves WHERE tenant_id=$1 AND shipment_code=$2 LIMIT 1`,
    [tenantId, shipment.external_id]
  );
  shipment.buffer_location_code = waveRes.rows[0]?.buffer_location_code || null;

  return { shipment, lines };
}

/** Скан товара на упаковке */
async function scanItem({ tenantId, packerId, shipmentCode, barcode }) {
  return transaction(async (client) => {
    // Находим shipment
    const shipRes = await client.query(
      `SELECT * FROM wms.shipments WHERE tenant_id=$1 AND external_id=$2 ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [tenantId, shipmentCode]
    );
    if (shipRes.rowCount === 0) throw new NotFoundError(`Shipment '${shipmentCode}'`);
    const shipment = shipRes.rows[0];

    // Проверяем план
    const planRes = await client.query(
      `SELECT COALESCE(SUM(qty),0)::int AS qty_plan
       FROM wms.picking_tasks
       WHERE tenant_id=$1 AND shipment_code=$2 AND barcode=$3 AND status IN ('new','in_progress','done')`,
      [tenantId, shipmentCode, barcode]
    );
    const qtyPlan = planRes.rows[0].qty_plan;
    if (qtyPlan === 0) throw new ValidationError(`Barcode '${barcode}' is not in packing plan for this shipment`);

    // Уже упаковано
    const packedRes = await client.query(
      `SELECT COALESCE(SUM(qty),0)::int AS qty_packed FROM wms.stock_movements
       WHERE tenant_id=$1 AND movement_type='packing' AND ref_type='shipment' AND ref_id=$2 AND barcode=$3`,
      [tenantId, shipment.id, barcode]
    );
    const alreadyPacked = packedRes.rows[0].qty_packed;
    if (alreadyPacked >= qtyPlan) {
      throw new ValidationError(`Barcode '${barcode}' already fully packed (${alreadyPacked}/${qtyPlan})`);
    }

    // Ищем item_id явно — нужен для INSERT
    const itemRes = await client.query(
      `SELECT id FROM wms.items WHERE tenant_id=$1 AND barcode=$2 AND client_id=$3 LIMIT 1`,
      [tenantId, barcode, shipment.client_id]
    );
    if (itemRes.rowCount === 0) {
      throw new ValidationError(`Item with barcode '${barcode}' not found in masterdata for this client`);
    }
    const itemId = itemRes.rows[0].id;

    // Локация для движения: CHECK-ограничение movement_has_location требует
    // from_location_id ИЛИ to_location_id — эта запись не может быть с обеими
    // NULL. Содержательно верно взять МХ, куда сборщик поставил короб при
    // закрытии волны (wms.pick_waves.buffer_location_code) — упаковщик физически
    // расходует товар именно оттуда. Если по какой-то причине волна/ячейка не
    // резолвится — берём любую активную buffer-ячейку склада как запасной вариант,
    // чтобы не блокировать упаковку.
    const fromLocRes = await client.query(
      `SELECT l.id, l.location_code
       FROM wms.locations l
       WHERE l.id = COALESCE(
         (SELECT l2.id FROM wms.pick_waves pw
            JOIN wms.locations l2 ON l2.tenant_id=pw.tenant_id AND l2.warehouse_id=$2
              AND UPPER(l2.location_code)=UPPER(pw.buffer_location_code) AND l2.is_active=TRUE
          WHERE pw.tenant_id=$1 AND pw.shipment_code=$3 LIMIT 1),
         (SELECT l3.id FROM wms.locations l3
          WHERE l3.tenant_id=$1 AND l3.warehouse_id=$2 AND l3.location_type='buffer' AND l3.is_active=TRUE
          LIMIT 1)
       )`,
      [tenantId, shipment.warehouse_id, shipmentCode]
    );
    const fromLocationId   = fromLocRes.rows[0]?.id || null;
    const fromLocationCode = fromLocRes.rows[0]?.location_code || null;

    // Пишем движение packing
    await client.query(
      `INSERT INTO wms.stock_movements
         (tenant_id,warehouse_id,client_id,item_id,barcode,movement_type,qty,
          from_location_id,from_location_code,to_location_id,to_location_code,ref_type,ref_id,user_id)
       VALUES($1,$2,$3,$4,$5,'packing',1,$6,$7,NULL,NULL,'shipment',$8,$9)`,
      [tenantId, shipment.warehouse_id, shipment.client_id, itemId, barcode,
       fromLocationId, fromLocationCode, shipment.id, packerId]
    );

    // Обновляем total_packed_qty
    const newPacked = alreadyPacked + 1;
    await client.query(
      `UPDATE wms.shipments SET total_packed_qty=$1, updated_at=NOW() WHERE id=$2`,
      [
        (await client.query(
          `SELECT COALESCE(SUM(qty),0)::int AS n FROM wms.stock_movements
           WHERE tenant_id=$1 AND movement_type='packing' AND ref_type='shipment' AND ref_id=$2`,
          [tenantId, shipment.id]
        )).rows[0].n,
        shipment.id,
      ]
    );

    // WB стикер для этого товара. Если в отгрузке несколько единиц одного и
    // того же штрихкода (два разных заказа WB на один и тот же товар), у
    // каждой физической единицы свой уникальный стикер — печатать один и тот
    // же на все единицы нельзя. Берём стикер по порядку (ORDER BY id), сдвигаясь
    // на alreadyPacked — т.е. 1-й скан этого штрихкода берёт 1-й ещё не
    // выданный заказ, 2-й скан — 2-й, и так далее.
    const stickerRes = await client.query(
      `SELECT wb_sticker, wb_sticker_code FROM wms.wb_orders
       WHERE tenant_id=$1 AND wb_supply_id=$2 AND barcode=$3 AND wb_sticker IS NOT NULL
       ORDER BY id
       OFFSET $4 LIMIT 1`,
      [tenantId, shipmentCode, barcode, alreadyPacked]
    );

    // Создаём print_job (soft-fail)
    let printJob = null;
    try {
      if (stickerRes.rowCount > 0) {
        const sticker = stickerRes.rows[0];
        // Сначала пробуем рабочее место упаковщика (если он сканировал стол —
        // печать уходит на его конкретный принтер), иначе — общий маршрут
        // printer_routes по клиенту/умолчанию, как и раньше.
        const resolved = await resolvePrinter(client.query.bind(client), {
          tenantId, docType: 'wb_sticker', employeeId: packerId, clientId: shipment.client_id,
        });
        if (resolved) {
          const jobCode = `PKG-${shipment.id}-${barcode}-${Date.now()}`;
          const pjRes = await client.query(
            `INSERT INTO wms.print_jobs
               (tenant_id,job_code,printer_id,route_id,doc_type,entity_type,entity_id,
                copies,payload_json,status,created_by)
             VALUES($1,$2,$3,$4,'wb_sticker','shipment',$5,1,$6::jsonb,'new',$7)
             RETURNING id, job_code, status`,
            [
              tenantId, jobCode, resolved.printerId, resolved.routeId, shipment.id,
              JSON.stringify({
                wb_sticker:      sticker.wb_sticker,
                wb_sticker_code: sticker.wb_sticker_code,
                barcode,
                shipment_code:   shipmentCode,
              }),
              packerId,
            ]
          );
          printJob = pjRes.rows[0];
        }
      }
    } catch (printErr) {
      // SOFT-FAIL: ошибка печати не ломает упаковку
      logger.warn({ err: printErr, tenantId, barcode }, 'Print job creation failed (soft-fail)');
    }

    // Отдаём фронту именно тот стикер, который реально ушёл на печать для этой
    // конкретной единицы (не просто "какой-то стикер по этому штрихкоду" —
    // при нескольких заказах на один и тот же товар у каждой физической
    // единицы свой уникальный стикер, см. комментарий выше про OFFSET).
    // Так упаковщик может визуально сверить с тем, что реально печатает принтер.
    const scannedSticker = stickerRes.rows[0] || null;

    return {
      barcode,
      qty_plan:    qtyPlan,
      qty_packed:  newPacked,
      shipment_id: shipment.id,
      print_job:   printJob,
      wb_sticker:      scannedSticker?.wb_sticker || null,
      wb_sticker_code: scannedSticker?.wb_sticker_code || null,
    };
  });
}

/** Подтвердить упаковку (завершить задачу) */
async function confirmPacking({ tenantId, packerId, shipmentId, boxesCount, locationCode, comment }) {
  let chargeClientId = null, chargeQty = 0;

  const result = await transaction(async (client) => {
    const shipRes = await client.query(
      `SELECT * FROM wms.shipments WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
      [shipmentId, tenantId]
    );
    if (shipRes.rowCount === 0) throw new NotFoundError('Shipment', shipmentId);
    const shipment = shipRes.rows[0];

    // Идемпотентность: если уже ready_to_ship — возвращаем успех без повторных операций
    if (shipment.status === 'ready_to_ship') {
      return { ok: true, shipmentId, status: 'ready_to_ship', idempotent: true };
    }

    // Нельзя подтвердить упаковку для уже отгруженной поставки
    if (['in_transit', 'done', 'cancelled'].includes(shipment.status)) {
      throw new ValidationError(`Cannot confirm packing for shipment in status '${shipment.status}'`);
    }

    // Проверяем что всё упаковано
    const planRes = await client.query(
      `SELECT COALESCE(SUM(qty),0)::int AS total_plan
       FROM wms.picking_tasks
       WHERE tenant_id=$1 AND shipment_code=$2 AND status IN ('new','in_progress','done')`,
      [tenantId, shipment.external_id]
    );
    const totalPlan = planRes.rows[0].total_plan;

    const packedRes = await client.query(
      `SELECT COALESCE(SUM(qty),0)::int AS total_packed FROM wms.stock_movements
       WHERE tenant_id=$1 AND movement_type='packing' AND ref_type='shipment' AND ref_id=$2`,
      [tenantId, shipmentId]
    );
    const totalPacked = packedRes.rows[0].total_packed;

    if (totalPacked < totalPlan) {
      throw new ValidationError(
        `Not all items packed: plan=${totalPlan}, packed=${totalPacked}`
      );
    }

    // Короб после упаковки нужно поставить в конкретную зону ожидания отгрузки —
    // проверяем это так же строго, как ячейку МХ при закрытии волны сборки,
    // иначе отгрузчик потом не найдёт короб (или упаковщик "разместит" его
    // где попало, просто вписав любой текст в поле).
    const code = String(locationCode || '').trim().toUpperCase();
    if (!code) throw new ValidationError('location_code is required — укажите ячейку зоны отгрузки');

    const locRes = await client.query(
      `SELECT id, location_type FROM wms.locations
       WHERE tenant_id=$1 AND warehouse_id=$2 AND UPPER(location_code)=$3 AND is_active=TRUE LIMIT 1`,
      [tenantId, shipment.warehouse_id, code]
    );
    if (locRes.rowCount === 0) {
      throw new ValidationError(`Ячейка '${code}' не найдена на этом складе`);
    }
    if (locRes.rows[0].location_type !== 'shipping') {
      throw new ValidationError(
        `Ячейка '${code}' не является зоной отгрузки. Поставьте короб в ячейку с типом "Отгрузка" (в справочнике мест хранения) и отсканируйте её.`
      );
    }
    const packingLocationId = locRes.rows[0].id;

    // Закрываем packing_tasks
    await client.query(
      `UPDATE wms.packing_tasks
       SET status='done', boxes_count=$1, comment=COALESCE($2,comment), updated_at=NOW()
       WHERE tenant_id=$3 AND shipment_code=$4 AND status IN ('new','in_progress')`,
      [boxesCount||1, comment||null, tenantId, shipment.external_id]
    );

    // Обновляем shipment
    await client.query(
      `UPDATE wms.shipments
       SET status='ready_to_ship', total_packed_qty=$1,
           packing_location_id=$2, packing_location_code=$3,
           packing_finished_at=NOW(), packer_id=$4, updated_at=NOW()
       WHERE id=$5`,
      [totalPacked, packingLocationId, code, packerId, shipmentId]
    );

    chargeClientId = shipment.client_id;
    chargeQty = totalPacked;

    return { ok: true, shipmentId, status: 'ready_to_ship', totalPlan, totalPacked, packingLocationCode: code };
  });

  // chargeClientId остаётся null, если ветка была идемпотентной (уже ready_to_ship) —
  // так повторный вызов confirmPacking не начисляет клиенту дважды.
  if (chargeClientId) {
    chargeForOperation({ tenantId, clientId: chargeClientId, serviceType: 'packing', quantity: chargeQty, refType: 'shipment', refId: shipmentId });
  }

  return result;
}

module.exports = { getOrTakePackingTask, getPackingTaskDetails, scanItem, confirmPacking };
