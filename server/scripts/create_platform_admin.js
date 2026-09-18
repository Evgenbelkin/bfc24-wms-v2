#!/usr/bin/env node
'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// =============================================================================
// Создание первого Platform Owner аккаунта.
// Миграции НЕ сеют platform.users — без этого скрипта войти в
// POST /api/v2/auth/platform/login попросту некому.
//
// Использование:
//   node scripts/create_platform_admin.js <username> <email> <password> ["Полное имя"]
//
// Пароль передаётся аргументом (или через env PLATFORM_ADMIN_PASSWORD),
// не запрашивается интерактивно — проще и предсказуемее для одноразового скрипта.
// Смени пароль сразу после первого входа при желании.
// =============================================================================

const BCRYPT_ROUNDS = 12; // держим в синхроне с server/src/modules/auth/auth.service.js

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME     || 'bfc24_v2',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

async function main() {
  const [username, email, passwordArg, fullName] = process.argv.slice(2);
  const password = passwordArg || process.env.PLATFORM_ADMIN_PASSWORD;

  if (!username || !email || !password) {
    console.error('Usage: node scripts/create_platform_admin.js <username> <email> <password> ["Full Name"]');
    console.error('(password can also come from env var PLATFORM_ADMIN_PASSWORD)');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
  }

  const client = await pool.connect();
  try {
    const exists = await client.query(
      `SELECT id FROM platform.users WHERE username=$1 OR email=$2`,
      [username, email]
    );
    if (exists.rowCount > 0) {
      console.error(`Platform user with this username or email already exists (id=${exists.rows[0].id}).`);
      console.error('Pick a different username/email, or update the password directly via SQL if you need to reset it.');
      process.exit(1);
    }

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const r = await client.query(
      `INSERT INTO platform.users (username, email, password_hash, full_name, is_active)
       VALUES ($1,$2,$3,$4,TRUE) RETURNING id, username, email, created_at`,
      [username, email, hash, fullName || null]
    );
    console.log('Platform admin created:', r.rows[0]);
    console.log('\nLog in via POST /api/v2/auth/platform/login with this username + password.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
