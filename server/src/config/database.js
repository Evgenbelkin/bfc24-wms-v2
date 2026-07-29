'use strict';

const { Pool, types } = require('pg');
const config = require('./index');
const logger = require('../utils/logger');

// =============================================================================
// PostgreSQL connection pool
// Единственное место, где создаётся Pool. Весь код импортирует отсюда.
// =============================================================================

// По умолчанию node-postgres превращает колонки типа `date` в JS Date-объект
// на полночь ПО ЛОКАЛЬНОЙ ТАЙМЗОНЕ СЕРВЕРА, а не UTC. При сериализации в JSON
// (res.json → toISOString) это даёт сдвинутую дату/время — например
// period_date='2026-07-29' на сервере с TZ=Europe/Moscow (UTC+3) уходит на
// фронт как "2026-07-28T21:00:00.000Z", и в интерфейсе показывается вчерашний
// день с посторонним временем вместо чистой даты. Отдаём `date` как есть,
// строкой 'YYYY-MM-DD' — без создания Date вообще, без сдвига по таймзоне.
// Это глобальный парсер (действует на ЛЮБОЙ запрос через этот pool), поэтому
// чинит проблему сразу везде: period_date, valid_from/valid_to и т.д.
types.setTypeParser(types.builtins.DATE, (val) => val);

const pool = new Pool({
  host:     config.db.host,
  port:     config.db.port,
  database: config.db.name,
  user:     config.db.user,
  password: config.db.password,
  min:      config.db.pool.min,
  max:      config.db.pool.max,
  idleTimeoutMillis: config.db.pool.idleMs,
  connectionTimeoutMillis: 5000,
  ssl: config.isProd ? { rejectUnauthorized: false } : false,
});

pool.on('connect', () => {
  logger.debug('PostgreSQL: new client connected');
});

pool.on('error', (err) => {
  logger.error({ err }, 'PostgreSQL: unexpected client error');
});

/**
 * Выполнить параметризованный запрос
 */
async function query(sql, params = []) {
  const start = Date.now();
  try {
    const result = await pool.query(sql, params);
    const duration = Date.now() - start;
    if (duration > 500) {
      logger.warn({ sql: sql.slice(0, 100), duration }, 'Slow query detected');
    }
    return result;
  } catch (err) {
    logger.error({ err, sql: sql.slice(0, 200), params }, 'Database query error');
    throw err;
  }
}

/**
 * Выполнить несколько операций в одной транзакции.
 *
 * @param {function(client: PoolClient): Promise<T>} fn
 * @returns {Promise<T>}
 *
 * Использование:
 *   const result = await transaction(async (client) => {
 *     await client.query('INSERT ...', [...]);
 *     await client.query('UPDATE ...', [...]);
 *     return someValue;
 *   });
 */
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore rollback errors */ }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Проверить подключение к БД
 */
async function testConnection() {
  const result = await query('SELECT NOW() AS now, current_database() AS db');
  return result.rows[0];
}

/**
 * Получить клиент из пула (для длинных транзакций)
 * Не забудь вызвать client.release() в finally!
 */
async function getClient() {
  return pool.connect();
}

module.exports = { pool, query, transaction, testConnection, getClient };
