#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { Pool } = require('pg');

// =============================================================================
// Автотест фичи "Пул остатков" (миграция 061, таск #122).
//
// Полностью САМОДОСТАТОЧНЫЙ: создаёт свой временный тенант с двумя тестовыми
// клиентами + пул-клиентом, гоняет через них полный цикл (приёмка на пул ->
// проверка остатка при формировании волны -> подбор ячейки на сборке ->
// списание остатка) и в конце удаляет за собой ВСЕ созданные строки (по
// tenant_id, ничего чужого не трогает). Не требует реальных клиентов вроде
// "Самушия"/"Космопроф" - именно то, о чём просил пользователь ("тестить
// будем на проде, если ты только сам сможешь всё протестить").
//
// Использование:
//   cd server && node scripts/test-item-pool.js
//
// Код выхода 0 = всё ОК, 1 = что-то не сошлось (см. вывод).
// =============================================================================

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME     || 'bfc24_v2',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

const ledger = require('../src/modules/stock/stock.ledger');
const { resolveStockKey } = require('../src/modules/masterdata/items/items.service');
const { findBestPickLocation } = require('../src/modules/masterdata/locations/locations.service');
const { suggestTargetLocation } = require('../src/modules/placement/placement.service');

const RUN_TAG = `pooltest_${Date.now()}`;
const BARCODE = '9999900001';
let failed = false;

function ok(label, cond, extra) {
  if (cond) {
    console.log(`  [OK]   ${label}`);
  } else {
    failed = true;
    console.log(`  [FAIL] ${label}${extra ? ' — ' + extra : ''}`);
  }
}

async function main() {
  const client = await pool.connect();
  const ids = { tenantId: null, warehouseId: null, clientAId: null, clientBId: null, poolClientId: null,
    locationId: null, itemAId: null, itemBId: null, poolItemId: null };

  try {
    console.log(`=== Тест пула остатков (${RUN_TAG}) ===\n`);

    // --- 1. Временный тенант + склад ------------------------------------
    const tRes = await client.query(
      `INSERT INTO platform.tenants (tenant_code, company_name, contact_email, item_pooling_enabled)
       VALUES ($1,$2,$3,TRUE) RETURNING id`,
      [RUN_TAG.replace(/_/g, '-'), 'TEST Pool Tenant', 'test@example.com']
    );
    ids.tenantId = tRes.rows[0].id;
    console.log(`Тенант создан: id=${ids.tenantId}, item_pooling_enabled=TRUE`);

    const whRes = await client.query(
      `INSERT INTO wms.warehouses (tenant_id, warehouse_code, warehouse_name, is_default)
       VALUES ($1,'MAIN','Тестовый склад',TRUE) RETURNING id`,
      [ids.tenantId]
    );
    ids.warehouseId = whRes.rows[0].id;

    const locRes = await client.query(
      `INSERT INTO wms.locations (tenant_id, warehouse_id, location_code, location_type, zone_code, is_active, is_pick_location)
       VALUES ($1,$2,'A-01-01','rack','A',TRUE,TRUE) RETURNING id`,
      [ids.tenantId, ids.warehouseId]
    );
    ids.locationId = locRes.rows[0].id;

    // --- 2. Два "реальных" клиента + пул-клиент -------------------------
    const clientARes = await client.query(
      `INSERT INTO wms.clients (tenant_id, client_code, client_name, is_active)
       VALUES ($1,'client-a','Клиент А (ИП Тест1)',TRUE) RETURNING id`,
      [ids.tenantId]
    );
    ids.clientAId = clientARes.rows[0].id;

    const clientBRes = await client.query(
      `INSERT INTO wms.clients (tenant_id, client_code, client_name, is_active)
       VALUES ($1,'client-b','Клиент Б (ИП Тест2)',TRUE) RETURNING id`,
      [ids.tenantId]
    );
    ids.clientBId = clientBRes.rows[0].id;

    const poolClientRes = await client.query(
      `INSERT INTO wms.clients (tenant_id, client_code, client_name, is_active, is_pool)
       VALUES ($1,'pool','Пул (тест)',TRUE,TRUE) RETURNING id`,
      [ids.tenantId]
    );
    ids.poolClientId = poolClientRes.rows[0].id;
    console.log(`Клиенты: A=${ids.clientAId}, Б=${ids.clientBId}, пул=${ids.poolClientId}`);

    // --- 3. Товар с одним и тем же штрихкодом у обоих клиентов + пула ---
    const itemARes = await client.query(
      `INSERT INTO wms.items (tenant_id, client_id, barcode, item_name, unit)
       VALUES ($1,$2,$3,'Тестовый товар А','шт') RETURNING id`,
      [ids.tenantId, ids.clientAId, BARCODE]
    );
    ids.itemAId = itemARes.rows[0].id;

    const itemBRes = await client.query(
      `INSERT INTO wms.items (tenant_id, client_id, barcode, item_name, unit)
       VALUES ($1,$2,$3,'Тестовый товар Б','шт') RETURNING id`,
      [ids.tenantId, ids.clientBId, BARCODE]
    );
    ids.itemBId = itemBRes.rows[0].id;

    const poolItemRes = await client.query(
      `INSERT INTO wms.items (tenant_id, client_id, barcode, item_name, unit)
       VALUES ($1,$2,$3,'Тестовый товар (пул)','шт') RETURNING id`,
      [ids.tenantId, ids.poolClientId, BARCODE]
    );
    ids.poolItemId = poolItemRes.rows[0].id;

    await client.query(
      `INSERT INTO wms.item_pool_links (tenant_id, item_id, pool_item_id) VALUES ($1,$2,$3),($1,$4,$3)`,
      [ids.tenantId, ids.itemAId, ids.poolItemId, ids.itemBId]
    );
    console.log(`Товары связаны в пул: item_A=${ids.itemAId}, item_Б=${ids.itemBId} -> pool_item=${ids.poolItemId}\n`);

    // --- 4. resolveStockKey должен вернуть пуловые id для обоих клиентов
    console.log('--- Шаг 1: resolveStockKey ---');
    const keyA = await resolveStockKey({ tenantId: ids.tenantId, itemId: ids.itemAId, clientId: ids.clientAId });
    const keyB = await resolveStockKey({ tenantId: ids.tenantId, itemId: ids.itemBId, clientId: ids.clientBId });
    ok('Клиент А резолвится в пуловый item/client', keyA.pooled && keyA.stockItemId === ids.poolItemId && keyA.stockClientId === ids.poolClientId);
    ok('Клиент Б резолвится в пуловый item/client', keyB.pooled && keyB.stockItemId === ids.poolItemId && keyB.stockClientId === ids.poolClientId);

    // Непуловый item (для контроля - фича не должна ничего ломать вне пула)
    const controlItemRes = await client.query(
      `INSERT INTO wms.items (tenant_id, client_id, barcode, item_name, unit)
       VALUES ($1,$2,'9999900002','Контрольный товар (не пул)','шт') RETURNING id`,
      [ids.tenantId, ids.clientAId]
    );
    const controlItemId = controlItemRes.rows[0].id;
    const keyControl = await resolveStockKey({ tenantId: ids.tenantId, itemId: controlItemId, clientId: ids.clientAId });
    ok('Непуловый товар резолвится без изменений (pooled=false)', !keyControl.pooled && keyControl.stockItemId === controlItemId && keyControl.stockClientId === ids.clientAId);
    console.log('');

    // --- 5. Приёмка на пул-клиента напрямую (как в реальном флоу) -------
    console.log('--- Шаг 2: приёмка (ledger.receiveStock на пул-клиента) ---');
    await ledger.receiveStock({
      tenantId: ids.tenantId, warehouseId: ids.warehouseId, clientId: ids.poolClientId,
      barcode: BARCODE, locationId: ids.locationId, qty: 10, refType: 'test',
    });
    const balAfterReceive = await client.query(
      `SELECT client_id, item_id, qty_on_hand, qty_available FROM wms.stock_balances
       WHERE tenant_id=$1 AND barcode=$2`,
      [ids.tenantId, BARCODE]
    );
    ok('После приёмки есть ровно 1 строка остатка (у пул-клиента)', balAfterReceive.rowCount === 1);
    if (balAfterReceive.rowCount === 1) {
      const b = balAfterReceive.rows[0];
      ok('Остаток лежит под pool_client_id/pool_item_id', b.client_id === ids.poolClientId && b.item_id === ids.poolItemId);
      ok('Количество = 10', Number(b.qty_on_hand) === 10);
    }
    console.log('');

    // --- 6. Проверка остатка "как при формировании волны" для ОБОИХ клиентов
    console.log('--- Шаг 3: проверка остатка для заказа клиента А и клиента Б (логика generate-wave) ---');
    for (const [label, itemId, clientId] of [['А', ids.itemAId, ids.clientAId], ['Б', ids.itemBId, ids.clientBId]]) {
      const key = await resolveStockKey({ tenantId: ids.tenantId, itemId, clientId });
      const availRes = await client.query(
        `SELECT COALESCE(SUM(qty_available),0)::int AS qty FROM wms.stock_balances
         WHERE tenant_id=$1 AND warehouse_id=$2 AND client_id=$3 AND item_id=$4`,
        [ids.tenantId, ids.warehouseId, key.stockClientId, key.stockItemId]
      );
      const qty = availRes.rows[0].qty;
      ok(`Заказ клиента ${label}: видит доступный остаток > 0 (видит ${qty})`, qty > 0);
    }
    console.log('');

    // --- 7. Подбор ячейки для сборки заказа клиента А --------------------
    console.log('--- Шаг 4: findBestPickLocation для заказа клиента А ---');
    const pickLoc = await findBestPickLocation({ tenantId: ids.tenantId, warehouseId: ids.warehouseId, itemId: ids.itemAId, clientId: ids.clientAId });
    ok('Ячейка найдена (несмотря на то что у клиента А своего остатка нет)', !!pickLoc, JSON.stringify(pickLoc));
    if (pickLoc) ok('Это та самая ячейка, куда приняли товар', pickLoc.location_code === 'A-01-01');
    console.log('');

    // --- 8. Списание (сборка) заказа клиента А через ledger.consumeStock -
    console.log('--- Шаг 5: ledger.consumeStock для заказа клиента А (списание 3 шт.) ---');
    await ledger.consumeStock({
      tenantId: ids.tenantId, warehouseId: ids.warehouseId, clientId: ids.clientAId,
      barcode: BARCODE, itemId: ids.itemAId, locationId: ids.locationId,
      qty: 3, movementType: 'picking', refType: 'test',
    });
    const balAfterPick = await client.query(
      `SELECT client_id, item_id, qty_on_hand FROM wms.stock_balances WHERE tenant_id=$1 AND barcode=$2`,
      [ids.tenantId, BARCODE]
    );
    ok('После сборки клиента А остаток пула = 7 (10-3), и по-прежнему только 1 строка',
      balAfterPick.rowCount === 1 && Number(balAfterPick.rows[0].qty_on_hand) === 7);
    ok('Остаток по-прежнему принадлежит пул-клиенту (не создалась левая строка у клиента А)',
      balAfterPick.rowCount === 1 && balAfterPick.rows[0].client_id === ids.poolClientId);
    console.log('');

    // --- 9. Списание заказа клиента Б из того же пула --------------------
    console.log('--- Шаг 6: ledger.consumeStock для заказа клиента Б (списание 4 шт. из ОБЩЕГО пула) ---');
    await ledger.consumeStock({
      tenantId: ids.tenantId, warehouseId: ids.warehouseId, clientId: ids.clientBId,
      barcode: BARCODE, itemId: ids.itemBId, locationId: ids.locationId,
      qty: 4, movementType: 'picking', refType: 'test',
    });
    const balFinal = await client.query(
      `SELECT qty_on_hand FROM wms.stock_balances WHERE tenant_id=$1 AND barcode=$2 AND client_id=$3`,
      [ids.tenantId, BARCODE, ids.poolClientId]
    );
    ok('Итоговый остаток пула = 3 (10-3-4, оба клиента списывали из ОДНОГО общего остатка)',
      balFinal.rowCount === 1 && Number(balFinal.rows[0].qty_on_hand) === 3);
    console.log('');

    // --- 10. Контроль: непуловый товар как раньше -------------------------
    console.log('--- Шаг 7: контроль — непуловый товар ведёт себя как раньше ---');
    await ledger.receiveStock({
      tenantId: ids.tenantId, warehouseId: ids.warehouseId, clientId: ids.clientAId,
      barcode: '9999900002', locationId: ids.locationId, qty: 5, refType: 'test',
    });
    const controlBal = await client.query(
      `SELECT client_id, item_id, qty_on_hand FROM wms.stock_balances WHERE tenant_id=$1 AND barcode='9999900002'`,
      [ids.tenantId]
    );
    ok('Непуловый товар лёг под настоящего клиента А (не под пул)',
      controlBal.rowCount === 1 && controlBal.rows[0].client_id === ids.clientAId && Number(controlBal.rows[0].qty_on_hand) === 5);

    console.log(`\n=== ИТОГ: ${failed ? 'ЕСТЬ ПРОВАЛЕННЫЕ ПРОВЕРКИ' : 'ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ'} ===`);
  } catch (e) {
    failed = true;
    console.error('\nОШИБКА ВО ВРЕМЯ ТЕСТА:', e.message);
    console.error(e.stack);
  } finally {
    // --- Уборка за собой: удаляем всё, что создали, в порядке зависимостей
    console.log('\nУборка тестовых данных...');
    try {
      if (ids.tenantId) {
        await client.query(`DELETE FROM wms.stock_movements WHERE tenant_id=$1`, [ids.tenantId]);
        await client.query(`DELETE FROM wms.stock_balances WHERE tenant_id=$1`, [ids.tenantId]);
        await client.query(`DELETE FROM wms.item_pool_links WHERE tenant_id=$1`, [ids.tenantId]);
        await client.query(`DELETE FROM wms.items WHERE tenant_id=$1`, [ids.tenantId]);
        await client.query(`DELETE FROM wms.locations WHERE tenant_id=$1`, [ids.tenantId]);
        await client.query(`DELETE FROM wms.clients WHERE tenant_id=$1`, [ids.tenantId]);
        await client.query(`DELETE FROM wms.warehouses WHERE tenant_id=$1`, [ids.tenantId]);
        await client.query(`DELETE FROM platform.tenants WHERE id=$1`, [ids.tenantId]);
        console.log(`Тестовый тенант id=${ids.tenantId} и все его данные удалены.`);
      }
    } catch (cleanupErr) {
      console.error('ВНИМАНИЕ: уборка не удалась, потребуется ручная проверка:', cleanupErr.message);
      console.error(`Тестовый tenant_id для ручной проверки/удаления: ${ids.tenantId}`);
      failed = true;
    }
    client.release();
    await pool.end();
  }

  process.exit(failed ? 1 : 0);
}

main();
