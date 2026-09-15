#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { Pool } = require('pg');

// =============================================================================
// Админ-инструмент "Пул остатков" (миграция 061, таски #113-122).
// Пока без веб-UI (это редкое разовое действие админа при подключении
// клиента типа "ООО Эсэндди" — один и тот же физический товар продаётся
// через несколько разных ИП/ООО) — управляем через CLI-скрипт, как и
// остальные разовые/редкие админ-операции в этом проекте.
//
// Подкоманды:
//   enable <tenant_code>
//     Включить фичу пулинга для тенанта (platform.tenants.item_pooling_enabled).
//
//   create-pool <tenant_code> <pool_client_code> <pool_client_name>
//     Завести пул-клиента (обычный wms.clients с is_pool=true).
//
//   link <tenant_code> <pool_client_code> <barcode>
//     Связать в пул ВСЕ items этого тенанта с данным штрихкодом (кроме
//     самого пул-клиента) - для каждого создаёт/находит item пул-клиента
//     с этим штрихкодом и прописывает wms.item_pool_links.
//
//   link-all <tenant_code> <pool_client_code>
//     То же самое, но СРАЗУ ДЛЯ ВСЕХ штрихкодов, которые вообще есть у
//     обычных клиентов тенанта (для случая "у нас все товары общие, нет
//     эксклюзивных ни у кого") - плюс сразу переносит остаток по каждому
//     (как transfer, но по кругу). Удобно, когда у клиента десятки/сотни SKU
//     и все нужно связать разом, а не по одному через link+transfer.
//
//   transfer <tenant_code> <barcode>
//     Разовый перенос уже существующего остатка (stock_balances) по всем
//     СВЯЗАННЫМ в пул items этого штрихкода - на баланс пул-клиента,
//     сохраняя те же ячейки (чтобы физически ничего не пришлось
//     перекладывать - товар как лежал, так и лежит, просто теперь числится
//     на пул-клиенте). Пишет обычные stock_movements (movement_type='pool_merge').
//
//   status <tenant_code> [barcode]
//     Показать текущее состояние: включена ли фича, какие items связаны в
//     пул, и (если указан barcode) остатки до/после.
// =============================================================================

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME     || 'bfc24_v2',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

async function getTenant(client, tenantCode) {
  const r = await client.query(`SELECT id, company_name, item_pooling_enabled FROM platform.tenants WHERE tenant_code=$1`, [tenantCode]);
  if (r.rowCount === 0) throw new Error(`Тенант '${tenantCode}' не найден`);
  return r.rows[0];
}

async function cmdEnable(client, [tenantCode]) {
  const tenant = await getTenant(client, tenantCode);
  await client.query(`UPDATE platform.tenants SET item_pooling_enabled=TRUE WHERE id=$1`, [tenant.id]);
  console.log(`Пулинг остатков включён для тенанта "${tenant.company_name}" (id=${tenant.id}).`);
}

async function cmdCreatePool(client, [tenantCode, poolClientCode, ...nameParts]) {
  const poolClientName = nameParts.join(' ');
  if (!poolClientCode || !poolClientName) {
    throw new Error('Использование: create-pool <tenant_code> <pool_client_code> <pool_client_name...>');
  }
  const tenant = await getTenant(client, tenantCode);

  const existing = await client.query(
    `SELECT id FROM wms.clients WHERE tenant_id=$1 AND client_code=$2`,
    [tenant.id, poolClientCode]
  );
  if (existing.rowCount > 0) {
    console.log(`Клиент с кодом '${poolClientCode}' уже существует (id=${existing.rows[0].id}) — просто помечаю is_pool=TRUE.`);
    await client.query(`UPDATE wms.clients SET is_pool=TRUE WHERE id=$1`, [existing.rows[0].id]);
    console.log(`Готово. pool_client_id=${existing.rows[0].id}`);
    return;
  }

  const ins = await client.query(
    `INSERT INTO wms.clients (tenant_id, client_code, client_name, is_active, is_pool, notes)
     VALUES ($1,$2,$3,TRUE,TRUE,$4)
     RETURNING id`,
    [tenant.id, poolClientCode, poolClientName, 'Виртуальный пул остатков (миграция 061) - создан автоматически']
  );
  console.log(`Создан пул-клиент "${poolClientName}" (code=${poolClientCode}), id=${ins.rows[0].id}.`);
  console.log(`Не забудь: enable ${tenantCode} (если ещё не делал) и link ${tenantCode} ${poolClientCode} <barcode> для каждого общего товара.`);
}

async function resolvePoolClient(client, tenant, poolClientCode) {
  const poolClientRes = await client.query(
    `SELECT id, client_name FROM wms.clients WHERE tenant_id=$1 AND client_code=$2 AND is_pool=TRUE`,
    [tenant.id, poolClientCode]
  );
  if (poolClientRes.rowCount === 0) throw new Error(`Пул-клиент с кодом '${poolClientCode}' не найден (сначала create-pool)`);
  return poolClientRes.rows[0];
}

/** Связать в пул все items данного штрихкода. Возвращает {linked, poolItemId} или null, если штрихкода нет ни у кого. */
async function linkOneBarcode(client, tenant, poolClientId, barcode) {
  const itemsRes = await client.query(
    `SELECT i.id, i.client_id, c.client_name, c.is_pool
     FROM wms.items i JOIN wms.clients c ON c.id=i.client_id
     WHERE i.tenant_id=$1 AND i.barcode=$2`,
    [tenant.id, barcode]
  );
  if (itemsRes.rowCount === 0) return null;

  // Пуловый item — находим существующий у пул-клиента, либо создаём (копируя
  // название/вендор-код с первого попавшегося реального item для удобства).
  let poolItemRow = itemsRes.rows.find(r => r.is_pool);
  let poolItemId;
  if (poolItemRow) {
    poolItemId = poolItemRow.id;
  } else {
    const sample = itemsRes.rows[0];
    const sampleItem = await client.query(`SELECT item_name, vendor_code, unit, volume_liters FROM wms.items WHERE id=$1`, [sample.id]);
    const s = sampleItem.rows[0];
    const insPoolItem = await client.query(
      `INSERT INTO wms.items (tenant_id, client_id, barcode, item_name, vendor_code, unit, volume_liters, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pool')
       ON CONFLICT (tenant_id, client_id, barcode) DO UPDATE SET updated_at=NOW()
       RETURNING id`,
      [tenant.id, poolClientId, barcode, s?.item_name || barcode, s?.vendor_code || null, s?.unit || 'шт', s?.volume_liters || null]
    );
    poolItemId = insPoolItem.rows[0].id;
    console.log(`  Создан item пул-клиента для штрихкода '${barcode}': id=${poolItemId}`);
  }

  let linked = 0;
  for (const row of itemsRes.rows) {
    if (row.id === poolItemId) continue; // сам пуловый item не связываем сам с собой
    await client.query(
      `INSERT INTO wms.item_pool_links (tenant_id, item_id, pool_item_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (item_id) DO UPDATE SET pool_item_id=EXCLUDED.pool_item_id`,
      [tenant.id, row.id, poolItemId]
    );
    console.log(`  Связан: item_id=${row.id} (клиент "${row.client_name}") -> пуловый item_id=${poolItemId}`);
    linked++;
  }
  return { linked, poolItemId };
}

async function cmdLink(client, [tenantCode, poolClientCode, barcode]) {
  if (!barcode) throw new Error('Использование: link <tenant_code> <pool_client_code> <barcode>');
  const tenant = await getTenant(client, tenantCode);
  const poolClient = await resolvePoolClient(client, tenant, poolClientCode);

  const result = await linkOneBarcode(client, tenant, poolClient.id, barcode);
  if (!result) {
    throw new Error(`Штрихкод '${barcode}' не найден ни у одного клиента этого тенанта - сначала заведите товар в каталоге хотя бы у одного клиента`);
  }
  console.log(`Готово: связано ${result.linked} item(ов) со штрихкодом '${barcode}' в пул "${poolClient.client_name}".`);
}

/**
 * Связать в пул ВСЕ штрихкоды, которые вообще есть у обычных (не-пуловых)
 * клиентов тенанта - для случая "у нас вообще все товары общие между
 * клиентами, отдельных нет" (обсуждение с пользователем 15.09.2026). Сразу
 * следом переносит и существующий остаток (как отдельная команда transfer,
 * но по каждому штрихкоду по кругу) - чтобы не гонять вручную по одной.
 */
async function cmdLinkAll(client, [tenantCode, poolClientCode]) {
  if (!poolClientCode) throw new Error('Использование: link-all <tenant_code> <pool_client_code>');
  const tenant = await getTenant(client, tenantCode);
  const poolClient = await resolvePoolClient(client, tenant, poolClientCode);

  const barcodesRes = await client.query(
    `SELECT DISTINCT i.barcode
     FROM wms.items i JOIN wms.clients c ON c.id=i.client_id
     WHERE i.tenant_id=$1 AND c.is_pool=FALSE AND i.barcode IS NOT NULL AND i.barcode <> ''
     ORDER BY i.barcode`,
    [tenant.id]
  );
  console.log(`Найдено ${barcodesRes.rowCount} уникальных штрихкодов у обычных клиентов тенанта "${tenant.company_name}".\n`);

  let linkedBarcodes = 0, totalLinks = 0, transferredBarcodes = 0, totalTransferred = 0;
  for (const row of barcodesRes.rows) {
    const barcode = row.barcode;
    console.log(`--- ${barcode} ---`);
    const linkResult = await linkOneBarcode(client, tenant, poolClient.id, barcode);
    if (linkResult) {
      linkedBarcodes++;
      totalLinks += linkResult.linked;
    }
    const moved = await transferOneBarcode(client, tenant, barcode);
    if (moved > 0) { transferredBarcodes++; totalTransferred += moved; }
  }
  console.log(`\nГотово: связано ${linkedBarcodes} штрихкодов (${totalLinks} item-связей), перенесён остаток по ${transferredBarcodes} штрихкодам (всего ${totalTransferred} шт.).`);
}

/** Перенести существующий остаток всех связанных в пул items данного штрихкода. Возвращает суммарно перенесённое количество. */
async function transferOneBarcode(client, tenant, barcode) {
  const linksRes = await client.query(
    `SELECT ipl.item_id, ipl.pool_item_id, i.client_id AS src_client_id, pi.client_id AS pool_client_id
     FROM wms.item_pool_links ipl
     JOIN wms.items i ON i.id = ipl.item_id
     JOIN wms.items pi ON pi.id = ipl.pool_item_id
     WHERE ipl.tenant_id=$1 AND i.barcode=$2`,
    [tenant.id, barcode]
  );
  if (linksRes.rowCount === 0) return 0;

  let totalMoved = 0;
  for (const row of linksRes.rows) {
    const balRes = await client.query(
      `SELECT location_id, warehouse_id, qty_on_hand FROM wms.stock_balances
       WHERE tenant_id=$1 AND client_id=$2 AND item_id=$3 AND qty_on_hand>0
       FOR UPDATE`,
      [tenant.id, row.src_client_id, row.item_id]
    );
    for (const bal of balRes.rows) {
      const qty = Number(bal.qty_on_hand);
      // Расход у исходного клиента
      await client.query(
        `INSERT INTO wms.stock_movements
           (tenant_id,warehouse_id,client_id,item_id,barcode,movement_type,qty,
            from_location_id,ref_type,comment)
         VALUES($1,$2,$3,$4,$5,'pool_merge',$6,$7,'item_pool_link','Перенос в общий пул остатков (миграция 061)')`,
        [tenant.id, bal.warehouse_id, row.src_client_id, row.item_id, barcode, -qty, bal.location_id]
      );
      await client.query(
        `SELECT * FROM wms.apply_stock_movement($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenant.id, bal.warehouse_id, row.src_client_id, row.item_id, bal.location_id, barcode, -qty, null]
      );
      // Приход пул-клиенту в ТУ ЖЕ ячейку (физически товар никуда не двигаем)
      await client.query(
        `INSERT INTO wms.stock_movements
           (tenant_id,warehouse_id,client_id,item_id,barcode,movement_type,qty,
            to_location_id,ref_type,comment)
         VALUES($1,$2,$3,$4,$5,'pool_merge',$6,$7,'item_pool_link','Перенос в общий пул остатков (миграция 061)')`,
        [tenant.id, bal.warehouse_id, row.pool_client_id, row.pool_item_id, barcode, qty, bal.location_id]
      );
      await client.query(
        `SELECT * FROM wms.apply_stock_movement($1,$2,$3,$4,$5,$6,$7,$8)`,
        [tenant.id, bal.warehouse_id, row.pool_client_id, row.pool_item_id, bal.location_id, barcode, qty, null]
      );
      console.log(`  Перенесено ${qty} шт. (item_id=${row.item_id} -> pool_item_id=${row.pool_item_id}, ячейка_id=${bal.location_id})`);
      totalMoved += qty;
    }
  }
  return totalMoved;
}

async function cmdTransfer(client, [tenantCode, barcode]) {
  if (!barcode) throw new Error('Использование: transfer <tenant_code> <barcode>');
  const tenant = await getTenant(client, tenantCode);
  const totalMoved = await transferOneBarcode(client, tenant, barcode);
  if (totalMoved === 0) {
    console.log(`Нет связанных в пул items для штрихкода '${barcode}' (или переносить нечего - остаток уже 0) - сначала link.`);
    return;
  }
  console.log(`Готово: перенесено всего ${totalMoved} шт. по штрихкоду '${barcode}'.`);
}

async function cmdStatus(client, [tenantCode, barcode]) {
  const tenant = await getTenant(client, tenantCode);
  console.log(`Тенант "${tenant.company_name}": пулинг ${tenant.item_pooling_enabled ? 'ВКЛЮЧЁН' : 'выключен'}.`);

  const poolsRes = await client.query(`SELECT id, client_code, client_name FROM wms.clients WHERE tenant_id=$1 AND is_pool=TRUE`, [tenant.id]);
  console.log(`Пул-клиенты (${poolsRes.rowCount}):`);
  for (const p of poolsRes.rows) console.log(`  #${p.id} ${p.client_code} "${p.client_name}"`);

  const linksRes = await client.query(
    `SELECT ipl.item_id, i.barcode, i.client_id, c.client_name, ipl.pool_item_id
     FROM wms.item_pool_links ipl
     JOIN wms.items i ON i.id=ipl.item_id
     JOIN wms.clients c ON c.id=i.client_id
     WHERE ipl.tenant_id=$1
     ORDER BY i.barcode`,
    [tenant.id]
  );
  console.log(`Связки в пул (${linksRes.rowCount}):`);
  for (const l of linksRes.rows) console.log(`  ${l.barcode}: item_id=${l.item_id} (клиент "${l.client_name}") -> pool_item_id=${l.pool_item_id}`);

  if (barcode) {
    const balRes = await client.query(
      `SELECT sb.client_id, c.client_name, sb.item_id, SUM(sb.qty_on_hand)::int AS qty_on_hand, SUM(sb.qty_available)::int AS qty_available
       FROM wms.stock_balances sb
       JOIN wms.clients c ON c.id=sb.client_id
       WHERE sb.tenant_id=$1 AND sb.barcode=$2
       GROUP BY sb.client_id, c.client_name, sb.item_id`,
      [tenant.id, barcode]
    );
    console.log(`Остаток по штрихкоду '${barcode}':`);
    for (const b of balRes.rows) console.log(`  клиент "${b.client_name}": item_id=${b.item_id}, on_hand=${b.qty_on_hand}, available=${b.qty_available}`);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const commands = { enable: cmdEnable, 'create-pool': cmdCreatePool, link: cmdLink, 'link-all': cmdLinkAll, transfer: cmdTransfer, status: cmdStatus };
  if (!cmd || !commands[cmd]) {
    console.error('Использование: node scripts/item-pool-admin.js <enable|create-pool|link|transfer|status> ...');
    console.error('См. комментарий в начале файла для точных аргументов каждой подкоманды.');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await commands[cmd](client, rest);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Ошибка (откачено):', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
