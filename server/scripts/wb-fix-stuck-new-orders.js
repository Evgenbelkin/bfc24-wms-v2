'use strict';

require('dotenv').config();

const { pool, query } = require('../src/config/database');

// =============================================================================
// Разовая починка "зависших" заказов: status='new', но wb_supply_id УЖЕ
// проставлен (заказ реально в поставке, физически мог уже уехать) - видно
// в UI как "НОВЫЙ" со значком поставки WB-GI-... в колонке.
//
// Причина: старый баг - ON CONFLICT при синхронизации заказов раньше
// перезаписывал status обратно на 'new' при каждом повторном синке, даже
// если заказ уже был продвинут (confirm/shipped/...). wb_supply_id при этом
// не трогался (не участвовал в UPDATE), поэтому получалась несовместимая
// комбинация: status='new' + wb_supply_id ЕСТЬ - такого в норме быть не
// может (см. wb.router.js /generate-wave - всегда ставит их вместе). Баг в
// коде уже исправлен (commit 0cfdb74 и далее), но уже испорченные ДО
// исправления строки сами не долечиваются - ничего в коде не трогает
// status='new' с непустым wb_supply_id (реконсиляция в 'external' explicitly
// пропускает такие строки, см. wb.service.js fetchAndUpsertOrders).
//
// Починка: ставим таким заказам status='confirm' - это ЗАКОННОЕ состояние
// для "уже в поставке, ждём подтверждения от WB", в точности то, что
// generate-wave ставит в норме. Дальше существующий self-heal в
// syncDeliveryStatusForTenant (работает каждые 15 минут фоном, либо по кнопке
// "Синхронизировать") сам доведёт их до 'shipped', когда увидит, что поставка
// уже in_transit/done - никакой отдельной логики "какой статус выставить"
// здесь дублировать не нужно.
//
// Запуск (с сервера, где лежит server/.env):
//   node scripts/wb-fix-stuck-new-orders.js                 - только показать (dry-run)
//   node scripts/wb-fix-stuck-new-orders.js --apply          - показать и исправить
//   node scripts/wb-fix-stuck-new-orders.js --apply <tenant_id>  - исправить только у одного тенанта
// =============================================================================

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const tenantArg = args.find(a => /^\d+$/.test(a));
  const tenantId = tenantArg ? Number(tenantArg) : null;

  const params = [];
  let tenantCond = '';
  if (tenantId) { params.push(tenantId); tenantCond = `AND wo.tenant_id=$${params.length}`; }

  const diag = await query(
    `SELECT wo.tenant_id, wo.wb_supply_id, s.status AS shipment_status, COUNT(*) AS qty,
            MIN(wo.created_at) AS oldest, MAX(wo.created_at) AS newest
     FROM wms.wb_orders wo
     LEFT JOIN wms.shipments s ON s.tenant_id=wo.tenant_id AND s.external_id=wo.wb_supply_id
     WHERE wo.status='new' AND wo.wb_supply_id IS NOT NULL ${tenantCond}
     GROUP BY wo.tenant_id, wo.wb_supply_id, s.status
     ORDER BY wo.tenant_id, qty DESC`,
    params
  );

  if (diag.rowCount === 0) {
    console.log('Зависших заказов (status=new + wb_supply_id) не найдено.');
    await pool.end();
    return;
  }

  console.log(`Найдено ${diag.rowCount} групп(ы) поставок с зависшими заказами:`);
  let total = 0;
  for (const row of diag.rows) {
    total += Number(row.qty);
    console.log(`  tenant=${row.tenant_id}  поставка=${row.wb_supply_id}  статус_поставки=${row.shipment_status || '(нет записи о поставке)'}  заказов=${row.qty}  (${row.oldest?.toISOString().slice(0,16)} — ${row.newest?.toISOString().slice(0,16)})`);
  }
  console.log(`Итого заказов: ${total}`);

  if (!apply) {
    console.log('\nЭто предпросмотр (dry-run). Чтобы исправить, добавь флаг --apply.');
    await pool.end();
    return;
  }

  const fixRes = await query(
    `UPDATE wms.wb_orders wo SET status='confirm'
     WHERE wo.status='new' AND wo.wb_supply_id IS NOT NULL ${tenantCond}
     RETURNING wo.id`,
    params
  );
  console.log(`\nИсправлено заказов: ${fixRes.rowCount} (status new -> confirm).`);
  console.log('Дальше их доведёт до shipped обычная фоновая синхронизация (раз в 15 минут) или кнопка "Синхронизировать все магазины".');

  await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
