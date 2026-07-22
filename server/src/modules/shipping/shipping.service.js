'use strict';

const { query, transaction } = require('../../config/database');
const { NotFoundError, ValidationError } = require('../../utils/errors');
const logger = require('../../utils/logger');

// =============================================================================
// Shipping Service
// =============================================================================

/** Табло отгрузок */
async function listShipments({ tenantId, clientId = null, status = null, marketplace = null, dateFrom = null, dateTo = null, limit = 100 }) {
  const params = [tenantId]; const conds = ['s.tenant_id=$1']; let idx = 2;
  if (clientId)   { conds.push(`s.client_id=$${idx++}`); params.push(clientId); }
  if (status)     { conds.push(`s.status=$${idx++}`); params.push(status); }
  if (marketplace){ conds.push(`s.marketplace=$${idx++}`); params.push(marketplace); }
  if (dateFrom)   { conds.push(`s.created_at>=$${idx++}::date`); params.push(dateFrom); }
  if (dateTo)     { conds.push(`s.created_at<($${idx++}::date+INTERVAL '1 day')`); params.push(dateTo); }
  params.push(Math.min(limit, 500));
  const r = await query(
    `SELECT s.*, c.client_name, w.warehouse_name,
       (SELECT COUNT(*)::int FROM wms.picking_tasks t WHERE t.shipment_code=s.external_id AND t.status='done') AS tasks_done,
       (SELECT COUNT(*)::int FROM wms.picking_tasks t WHERE t.shipment_code=s.external_id) AS tasks_total
     FROM wms.shipments s
     JOIN wms.clients c ON c.id=s.client_id
     JOIN wms.warehouses w ON w.id=s.warehouse_id
     WHERE ${conds.join(' AND ')} ORDER BY s.created_at DESC LIMIT $${idx}`,
    params
  );
  return r.rows;
}

/** Детали отгрузки */
async function getShipmentDetails({ tenantId, shipmentCode }) {
  const shipRes = await query(
    `SELECT s.*, c.client_name, w.warehouse_name FROM wms.shipments s
     JOIN wms.clients c ON c.id=s.client_id
     JOIN wms.warehouses w ON w.id=s.warehouse_id
     WHERE s.tenant_id=$1 AND s.external_id=$2 ORDER BY s.id DESC LIMIT 1`,
    [tenantId, shipmentCode]
  );
  if (shipRes.rowCount === 0) throw new NotFoundError(`Shipment '${shipmentCode}'`);
  const shipment = shipRes.rows[0];

  // Строки
  const linesRes = await query(
    `SELECT
       pt.barcode, pt.qty, pt.status AS picking_status,
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

    // Идемпотентность: если уже in_transit — возвращаем успех
    if (shipment.status === 'in_transit') {
      return {
        ok: true, shipmentId: shipment.id,
        shipmentCode: shipment.external_id,
        status: 'in_transit', alreadyShipped: true,
        qr_base64: shipment.wb_supply_qr_base64 || null,
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

    // Фактически отгружено = сумма done picking tasks
    const shippedQtyRes = await client.query(
      `SELECT COALESCE(SUM(qty_picked), 0)::int AS shipped_qty
       FROM wms.picking_tasks
       WHERE tenant_id=$1 AND shipment_code=$2 AND status='done'`,
      [tenantId, shipmentCode]
    );
    const totalShipped = shippedQtyRes.rows[0].shipped_qty;

    // Записываем документальное движение shipping (без ячейки — это факт отгрузки)
    // Используем виртуальную ячейку типа shipping если есть, иначе пропускаем movement
    // NB: constraint movement_has_location не позволяет NULL location → пишем только в аудит
    // Реальное списание со склада уже произошло в picking через consumeStock
    await client.query(
      `INSERT INTO wms.stock_movements
         (tenant_id, warehouse_id, client_id, item_id, barcode,
          movement_type, qty, from_location_id, to_location_id,
          ref_type, ref_id, user_id, comment)
       SELECT
         $1, $2, $3, NULL, NULL,
         'shipping', $4,
         l.id, NULL,
         'shipment', $5, $6, 'Документальная отгрузка перевозчику'
       FROM wms.locations l
       WHERE l.tenant_id=$1 AND l.location_type='shipping' AND l.is_active=TRUE
       LIMIT 1
       ON CONFLICT DO NOTHING`,
      [tenantId, shipment.warehouse_id, shipment.client_id, totalShipped, shipment.id, userId]
    );

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
    };
  });

  // Получаем QR ПОСЛЕ commit транзакции — чтобы не держать DB-соединение во время HTTP
  if (shipmentId && !txResult.alreadyShipped) {
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

  // Нормализуем: WB ждёт raw supply_id (без WB-GI- префикса)
  const supplyId = shipmentCode.replace(/^WB-GI-/i, '');

  const resp = await fetch(
    `https://marketplace-api.wildberries.ru/api/v3/supplies/${encodeURIComponent(supplyId)}/barcode?type=svg`,
    { headers: { Authorization: token } }
  );
  if (!resp.ok) return null;
  const data = await resp.json().catch(() => null);
  return data?.file || null;
}

async function createQrPrintJobDirect({ tenantId, shipmentId, qrBase64, userId }) {
  const routeRes = await query(
    `SELECT pr.printer_id FROM wms.printer_routes pr
     JOIN wms.printers p ON p.id=pr.printer_id
     WHERE pr.tenant_id=$1 AND pr.doc_type='shipping_qr' AND pr.is_active=TRUE AND p.is_active=TRUE
     ORDER BY pr.is_default DESC, pr.id LIMIT 1`,
    [tenantId]
  );
  if (routeRes.rowCount === 0) return;
  const jobCode = `SHIPQR-${shipmentId}-${Date.now()}`;
  await query(
    `INSERT INTO wms.print_jobs
       (tenant_id,job_code,printer_id,doc_type,entity_type,entity_id,copies,payload_json,status,created_by)
     VALUES($1,$2,$3,'shipping_qr','shipment',$4,1,$5::jsonb,'new',$6)`,
    [tenantId, jobCode, routeRes.rows[0].printer_id, shipmentId,
     JSON.stringify({ qr_base64: qrBase64 }), userId]
  );
}

module.exports = { listShipments, getShipmentDetails, confirmShipment };
