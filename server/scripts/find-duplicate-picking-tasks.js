#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { Pool } = require('pg');

// =============================================================================
// Диагностика: дубли задач на сборку (wms.picking_tasks) под один и тот же
// заказ WB — симптом гонки в POST /wb/generate-wave (SELECT-затем-INSERT без
// настоящего уникального ограничения в БД). Только ЧТЕНИЕ, ничего не меняет.
// Использование: cd server && node scripts/find-duplicate-picking-tasks.js
// =============================================================================

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME     || 'bfc24_v2',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

async function main() {
  const client = await pool.connect();
  try {
    const dupRes = await client.query(`
      SELECT pt.tenant_id, pt.shipment_code, pt.wb_order_id, pt.barcode, i.item_name,
             COUNT(*) AS dup_count, array_agg(pt.id ORDER BY pt.id) AS task_ids,
             array_agg(pt.status ORDER BY pt.id) AS statuses
      FROM wms.picking_tasks pt
      LEFT JOIN wms.items i ON i.id = pt.item_id
      WHERE pt.wb_order_id IS NOT NULL
      GROUP BY pt.tenant_id, pt.shipment_code, pt.wb_order_id, pt.barcode, i.item_name
      HAVING COUNT(*) > 1
      ORDER BY pt.shipment_code
    `);

    if (dupRes.rowCount === 0) {
      console.log('Дублей не найдено — задач на сборку с повтором по (tenant, shipment, wb_order, barcode) нет.');
      return;
    }

    console.log(`Найдено ${dupRes.rowCount} групп(ы) с дублями:\n`);
    for (const r of dupRes.rows) {
      console.log(
        `tenant=${r.tenant_id} shipment=${r.shipment_code} wb_order_id=${r.wb_order_id} ` +
        `barcode=${r.barcode} item="${r.item_name || '—'}" x${r.dup_count} ` +
        `task_ids=[${r.task_ids.join(',')}] statuses=[${r.statuses.join(',')}]`
      );
    }

    // Дополнительно: у КАЖДОЙ дублирующей задачи (picking_tasks.id) — было ли
    // по ней реальное движение остатка (ref_type='picking_task', ref_id=task.id)?
    // Если да у ОБОИХ дублей одной группы — списание было дважды физически,
    // а не только задвоенная запись задачи на экране.
    console.log('\n--- Проверка физического списания по каждой дублирующей задаче (ref_type=picking_task) ---\n');
    const allTaskIds = [...new Set(dupRes.rows.flatMap(r => r.task_ids))];
    const movRes = await client.query(
      `SELECT m.ref_id AS task_id, m.barcode, m.movement_type, COUNT(*) AS n, SUM(m.qty) AS total_qty
       FROM wms.stock_movements m
       WHERE m.ref_type='picking_task' AND m.ref_id = ANY($1::bigint[])
       GROUP BY m.ref_id, m.barcode, m.movement_type
       ORDER BY m.ref_id`,
      [allTaskIds]
    );
    if (movRes.rowCount === 0) {
      console.log('Движений по этим task_id не найдено — возможно, задачи ещё не были фактически собраны/списаны.');
    } else {
      for (const r of movRes.rows) {
        console.log(`task_id=${r.task_id} barcode=${r.barcode} type=${r.movement_type} count=${r.n} total_qty=${r.total_qty}`);
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Ошибка:', err.message);
  process.exit(1);
});
