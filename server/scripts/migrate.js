#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const fs   = require('fs');
const path = require('path');

// =============================================================================
// Скрипт применения SQL-миграций
// Использование: node scripts/migrate.js
// Применяет только новые миграции (хранит историю в таблице _migrations)
// =============================================================================

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME     || 'bfc24_v2',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

const migrationsDir = path.join(__dirname, '../../db/migrations');

async function migrate() {
  const client = await pool.connect();
  try {
    // Создаём таблицу миграций если нет
    await client.query(`
      CREATE TABLE IF NOT EXISTS public._migrations (
        id         SERIAL PRIMARY KEY,
        filename   TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Получаем уже применённые
    const applied = await client.query(`SELECT filename FROM public._migrations ORDER BY id`);
    const appliedSet = new Set(applied.rows.map(r => r.filename));

    // Читаем файлы миграций
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    let count = 0;
    for (const file of files) {
      if (appliedSet.has(file)) {
        console.log(`[SKIP] ${file}`);
        continue;
      }

      console.log(`[APPLY] ${file}...`);
      let sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

      // Вставляем запись в _migrations ВНУТРЬ транзакции самой миграции.
      // Каждый SQL-файл заканчивается на COMMIT; — вставляем INSERT перед ним.
      // Это гарантирует атомарность: либо миграция применена И записана, либо ни то ни другое.
      const insertMigration = `INSERT INTO public._migrations (filename) VALUES ('${file.replace(/'/g, "''")}');\n`;

      if (sql.trimEnd().toUpperCase().endsWith('COMMIT;')) {
        // Вставляем INSERT прямо перед финальным COMMIT
        sql = sql.trimEnd().slice(0, -7) + '\n' + insertMigration + 'COMMIT;\n';
      } else {
        // Если нет COMMIT (нестандартная миграция) — выполняем отдельно
        sql = sql + '\n' + insertMigration;
      }

      try {
        // Выполняем весь SQL как одну команду (BEGIN...COMMIT внутри него)
        await client.query(sql);
        console.log(`[OK]   ${file}`);
        count++;
      } catch (err) {
        // При ошибке PG автоматически откатит транзакцию из BEGIN/COMMIT
        console.error(`[FAIL] ${file}:`, err.message);
        process.exit(1);
      }
    }

    if (count === 0) {
      console.log('No new migrations to apply.');
    } else {
      console.log(`\nApplied ${count} migration(s).`);
    }

  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => {
  console.error('Migration error:', err);
  process.exit(1);
});
