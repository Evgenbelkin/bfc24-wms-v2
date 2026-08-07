'use strict';

const { query, transaction } = require('../../config/database');
const { NotFoundError, ConflictError, ValidationError, ForbiddenError } = require('../../utils/errors');
const { validatePositiveInt, validateQty, validateBarcode } = require('../../utils/validators');

// =============================================================================
// Inbound Orders Service
// Селлер создаёт заявку → склад принимает строго по ней
// =============================================================================

async function listInboundOrders({ tenantId, clientId = null, status = null, warehouseId = null, limit = 100, offset = 0 }) {
  const params = [tenantId]; const conds = ['o.tenant_id=$1']; let idx = 2;
  if (clientId)    { conds.push(`o.client_id=$${idx++}`); params.push(clientId); }
  if (status)      { conds.push(`o.status=$${idx++}`); params.push(status); }
  if (warehouseId) { conds.push(`o.warehouse_id=$${idx++}`); params.push(warehouseId); }

  const total = (await query(`SELECT COUNT(*)::int AS n FROM wms.inbound_orders o WHERE ${conds.join(' AND ')}`, params)).rows[0].n;
  params.push(Math.min(limit,500), Math.max(offset,0));
  const r = await query(
    `SELECT o.*, c.client_name, w.warehouse_name
     FROM wms.inbound_orders o
     JOIN wms.clients c ON c.id=o.client_id
     JOIN wms.warehouses w ON w.id=o.warehouse_id
     WHERE ${conds.join(' AND ')} ORDER BY o.created_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params
  );
  return { orders: r.rows, total, limit, offset };
}

async function getInboundOrderById({ tenantId, orderId }) {
  const r = await query(
    `SELECT o.*, c.client_name, w.warehouse_name
     FROM wms.inbound_orders o
     JOIN wms.clients c ON c.id=o.client_id
     JOIN wms.warehouses w ON w.id=o.warehouse_id
     WHERE o.id=$1 AND o.tenant_id=$2`,
    [orderId, tenantId]
  );
  if (r.rowCount === 0) throw new NotFoundError('InboundOrder', orderId);
  return r.rows[0];
}

async function getInboundOrderByBarcode({ tenantId, barcode }) {
  const r = await query(
    `SELECT o.*, c.client_name, w.warehouse_name
     FROM wms.inbound_orders o
     JOIN wms.clients c ON c.id=o.client_id
     JOIN wms.warehouses w ON w.id=o.warehouse_id
     WHERE o.tenant_id=$1 AND o.barcode=$2 LIMIT 1`,
    [tenantId, barcode]
  );
  if (r.rowCount === 0) throw new NotFoundError(`InboundOrder with barcode '${barcode}'`);
  return r.rows[0];
}

async function getInboundOrderLines({ orderId }) {
  const r = await query(
    `SELECT l.*, i.item_name AS item_name_master, i.preview_url
     FROM wms.inbound_order_lines l
     LEFT JOIN wms.items i ON i.id=l.item_id
     WHERE l.inbound_order_id=$1 ORDER BY l.id`,
    [orderId]
  );
  return r.rows;
}

async function createInboundOrder({ tenantId, clientId, warehouseId, createdByUserId, data }) {
  const { expected_date, notes, lines = [] } = data;
  if (!lines.length) throw new ValidationError('Order must have at least one line');

  return transaction(async (client) => {
    const orderNumber = (await client.query(
      `SELECT wms.generate_inbound_order_number($1) AS n`, [tenantId]
    )).rows[0].n;

    const barcode = (await client.query(`SELECT wms.generate_inbound_barcode() AS b`)).rows[0].b;

    const orderRes = await client.query(
      `INSERT INTO wms.inbound_orders
         (tenant_id,warehouse_id,client_id,order_number,barcode,status,expected_date,notes,
          total_expected_qty,created_by_user_id)
       VALUES($1,$2,$3,$4,$5,'draft',$6,$7,0,$8)
       RETURNING *`,
      [tenantId, warehouseId, clientId, orderNumber, barcode, expected_date||null, notes||null, createdByUserId]
    );
    const order = orderRes.rows[0];

    let totalExpected = 0;
    for (const line of lines) {
      const b = validateBarcode(line.barcode);
      const qty = validateQty(line.qty_expected || line.qty, 'qty_expected');

      // Ищем item_id если барcode уже в справочнике
      const itemRes = await client.query(
        `SELECT id FROM wms.items WHERE tenant_id=$1 AND client_id=$2 AND barcode=$3 LIMIT 1`,
        [tenantId, clientId, b]
      );
      const itemId = itemRes.rowCount > 0 ? itemRes.rows[0].id : null;

      await client.query(
        `INSERT INTO wms.inbound_order_lines
           (tenant_id,inbound_order_id,client_id,item_id,barcode,item_name,vendor_code,qty_expected)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenantId, order.id, clientId, itemId, b, line.item_name||null, line.vendor_code||null, qty]
      );
      totalExpected += qty;
    }

    await client.query(
      `UPDATE wms.inbound_orders SET total_expected_qty=$1 WHERE id=$2`,
      [totalExpected, order.id]
    );

    return { ...order, total_expected_qty: totalExpected };
  });
}

async function confirmInboundOrder({ tenantId, orderId, userId }) {
  return transaction(async (client) => {
    // FOR UPDATE предотвращает race condition при двойном нажатии
    const r = await client.query(
      `SELECT id, status, order_number
       FROM wms.inbound_orders
       WHERE id=$1 AND tenant_id=$2
       FOR UPDATE`,
      [orderId, tenantId]
    );
    if (r.rowCount === 0) throw new NotFoundError('InboundOrder', orderId);

    const order = r.rows[0];
    if (order.status !== 'draft') {
      throw new ValidationError(`Cannot confirm order in status '${order.status}'. Must be 'draft'.`);
    }

    const updated = await client.query(
      `UPDATE wms.inbound_orders
       SET status='confirmed', confirmed_at=NOW(), updated_at=NOW()
       WHERE id=$1
       RETURNING *`,
      [orderId]
    );
    return updated.rows[0];
  });
}

async function cancelInboundOrder({ tenantId, orderId, userId }) {
  return transaction(async (client) => {
    // FOR UPDATE предотвращает race condition
    const r = await client.query(
      `SELECT id, status, order_number
       FROM wms.inbound_orders
       WHERE id=$1 AND tenant_id=$2
       FOR UPDATE`,
      [orderId, tenantId]
    );
    if (r.rowCount === 0) throw new NotFoundError('InboundOrder', orderId);

    const order = r.rows[0];
    if (['completed', 'cancelled'].includes(order.status)) {
      throw new ValidationError(`Cannot cancel order in status '${order.status}'`);
    }

    const updated = await client.query(
      `UPDATE wms.inbound_orders
       SET status='cancelled', cancelled_at=NOW(), updated_at=NOW()
       WHERE id=$1
       RETURNING id, order_number, status`,
      [orderId]
    );
    return updated.rows[0];
  });
}

/**
 * Закрыть заявку "как есть" — поставщик привёз меньше, чем заявлено, и
 * больше уже не довезёт. В отличие от cancel(), НЕ откатывает и никак не
 * трогает уже принятый товар (он давно на складе через ledger.receiveStock) —
 * только переводит саму заявку-документ в статус 'partial' (терминальный,
 * как completed/cancelled), чтобы она не висела вечно в 'in_progress' и не
 * маячила в списке ожидающих действий.
 */
async function closeInboundOrderShort({ tenantId, orderId, userId, reason = null }) {
  return transaction(async (client) => {
    const r = await client.query(
      `SELECT id, status, order_number FROM wms.inbound_orders WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
      [orderId, tenantId]
    );
    if (r.rowCount === 0) throw new NotFoundError('InboundOrder', orderId);

    const order = r.rows[0];
    if (['completed', 'cancelled', 'partial'].includes(order.status)) {
      throw new ValidationError(`Cannot close order in status '${order.status}' — it's already final`);
    }

    const updated = await client.query(
      `UPDATE wms.inbound_orders
       SET status='partial', closed_at=NOW(), closed_reason=$1, closed_by=$2, updated_at=NOW()
       WHERE id=$3
       RETURNING *`,
      [reason || null, userId, orderId]
    );
    return updated.rows[0];
  });
}

module.exports = {
  listInboundOrders, getInboundOrderById, getInboundOrderByBarcode,
  getInboundOrderLines, createInboundOrder, confirmInboundOrder, cancelInboundOrder,
  closeInboundOrderShort,
};
