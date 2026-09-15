'use strict';

const { query } = require('../../config/database');

// =============================================================================
// Отчёт по дефицитам — сравнивает открытые (ещё не взятые в поставку) FBS-
// заказы WB с реально доступным остатком в ячейках отбора (is_pick_location),
// чтобы заранее видеть: по каким товарам у клиента заказов больше, чем есть
// физически на складе прямо сейчас.
//
// Формула (согласована с владельцем): Дефицит = Открытые заказы − Доступный
// остаток в ячейках отбора. Без вычета процента резерва — берём буквальные
// числа, без "подушки безопасности". "Открытые" = wms.wb_orders.status='new'
// (заказ ещё не добавлен ни в какую поставку/волну) — самый точный сигнал
// "надо иметь товар на складе прямо сейчас"; заказы, уже взятые в поставку
// (status='confirm'), сюда не попадают — по ним решение уже принято (см.
// другие отчёты FBS-аналитики).
//
// "Доступный остаток" = SUM(qty_available) по wms.stock_balances, только по
// ячейкам с is_pick_location=true (не считаем сток в буферных/карантинных/
// резервных ячейках, куда сборщик не пойдёт) — qty_available уже сам по себе
// учитывает существующие резервы (qty_on_hand - qty_reserved), так что уже
// зарезервированное под другие заказы сюда не попадает.
//
// Показываем только строки с дефицитом > 0 (излишки/баланс — не предмет
// этого отчёта).
//
// Пул остатков (миграция 061, опционально по тенанту) — если товар клиента
// связан с пул-клиентом, физический остаток нужно искать под пуловым
// (client_id, item_id), а не под client_id заказа: иначе для тенантов с
// пулингом этот отчёт ложно показывал бы дефицит у каждого клиента по
// отдельности, хотя физически остаток есть (просто в общем пуле).
// effective_scope ниже — SQL-версия items.service.js::resolveStockKey (тот
// же JOIN на wms.item_pool_links + platform.tenants.item_pooling_enabled).
// Для тенантов без пулинга effective_scope не меняет ничего (LEFT JOIN не
// находит связей — stock_client_id/stock_item_id остаются такими же, как
// client_id заказа/item_id товара).
// =============================================================================

async function computeDeficitReport({ tenantId, clientId = null }) {
  const params = [tenantId];
  const orderConds = ['wo.tenant_id=$1', "wo.status='new'"];
  let idx = 2;
  if (clientId) {
    orderConds.push(`ma.client_id=$${idx}`);
    params.push(clientId);
    idx++;
  }

  const res = await query(
    `WITH open_orders AS (
       SELECT ma.client_id, wo.barcode, COUNT(*)::int AS open_qty
       FROM wms.wb_orders wo
       JOIN wms.mp_accounts ma ON ma.id = wo.mp_account_id
       WHERE ${orderConds.join(' AND ')} AND wo.barcode IS NOT NULL
       GROUP BY ma.client_id, wo.barcode
     ),
     effective_scope AS (
       SELECT oo.client_id AS order_client_id, oo.barcode,
         COALESCE(pool_item.client_id, i.client_id) AS stock_client_id,
         COALESCE(ipl.pool_item_id, i.id) AS stock_item_id
       FROM open_orders oo
       LEFT JOIN wms.items i ON i.tenant_id=$1 AND i.client_id=oo.client_id AND i.barcode=oo.barcode
       LEFT JOIN wms.item_pool_links ipl ON ipl.item_id = i.id
         AND EXISTS (SELECT 1 FROM platform.tenants t WHERE t.id=ipl.tenant_id AND t.item_pooling_enabled=TRUE)
       LEFT JOIN wms.items pool_item ON pool_item.id = ipl.pool_item_id
     ),
     available_stock AS (
       SELECT sb.client_id, sb.item_id, COALESCE(SUM(sb.qty_available),0)::int AS available_qty
       FROM wms.stock_balances sb
       JOIN wms.locations loc ON loc.id = sb.location_id
       WHERE sb.tenant_id=$1 AND loc.is_pick_location=true
       GROUP BY sb.client_id, sb.item_id
     )
     SELECT
       oo.client_id, c.client_name, oo.barcode,
       i.item_name, i.vendor_code,
       oo.open_qty,
       COALESCE(av.available_qty, 0) AS available_qty,
       (oo.open_qty - COALESCE(av.available_qty, 0)) AS deficit_qty
     FROM open_orders oo
     LEFT JOIN effective_scope es ON es.order_client_id = oo.client_id AND es.barcode = oo.barcode
     LEFT JOIN available_stock av ON av.client_id = es.stock_client_id AND av.item_id = es.stock_item_id
     LEFT JOIN wms.items i ON i.tenant_id=$1 AND i.client_id=oo.client_id AND i.barcode=oo.barcode
     JOIN wms.clients c ON c.id = oo.client_id
     WHERE (oo.open_qty - COALESCE(av.available_qty, 0)) > 0
     ORDER BY deficit_qty DESC, c.client_name, oo.barcode`,
    params
  );

  const rows = res.rows.map(r => ({
    client_id: r.client_id,
    client_name: r.client_name,
    barcode: r.barcode,
    item_name: r.item_name,
    vendor_code: r.vendor_code,
    open_qty: r.open_qty,
    available_qty: r.available_qty,
    deficit_qty: r.deficit_qty,
  }));

  return {
    rows,
    total_deficit_lines: rows.length,
    total_deficit_qty: rows.reduce((s, r) => s + r.deficit_qty, 0),
  };
}

module.exports = { computeDeficitReport };
