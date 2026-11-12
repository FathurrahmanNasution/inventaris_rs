// Disposable Admin UI server, using the base schema without the stock migration.
const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { readFileSync } = require('fs');
const path = require('path');
const target = new URL(process.env.ADMIN_TEST_DATABASE_URL || 'http://invalid');
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.pathname !== '/admin_inventory_test' || target.search)
  throw new Error('Use a dedicated local admin_inventory_test database.');
const schema = 'admin_ui_' + randomUUID().replaceAll('-', '');
const bootstrap = new Pool({ connectionString: target.href, ssl: false });
const pool = new Pool({ connectionString: target.href, ssl: false, options: '-c search_path=' + schema });
const query = (sql, params) => pool.query(sql, params);
const dbPath = require.resolve('../../src/config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query, pool } };
process.env.JWT_SECRET = 'isolated-admin-ui-secret-not-for-production-123456789';
process.env.NODE_ENV = 'test';
delete process.env.APP_ORIGIN;
let server;
async function cleanup() {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await pool.end();
  if (!/^admin_ui_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe test schema');
  await bootstrap.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
  await bootstrap.end();
}
(async () => {
  await bootstrap.query('CREATE SCHEMA ' + schema);
  await query(readFileSync(path.join(__dirname, '../fixtures/stock-schema.sql'), 'utf8'));
  const hash = await require('bcryptjs').hash('UiOriginal123!', 4);
  for (const role of ['admin', 'gudang', 'pelayanan', 'kepala_farmasi'])
    await query('INSERT INTO users (username,password_hash,role) VALUES ($1,$2,$3)', ['ui_' + role, hash, role]);
  for (let i = 1; i <= 20; i++)
    await query("INSERT INTO users (username,password_hash,role) VALUES ($1,$2,'pelayanan')", ['ui_fixture_' + i, hash]);
  await query("INSERT INTO audit_logs (user_id,action,ip_address) SELECT 1,'fixture_event','127.0.0.1' FROM generate_series(1,55)");
  server = require('../../server').listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  console.log(JSON.stringify({ ready: true, origin: 'http://127.0.0.1:' + server.address().port }));
  process.stdin.once('data', () => cleanup().then(() => process.exit(0)).catch(() => process.exit(1)));
  process.stdin.resume();
})().catch(async error => { console.error(error.code || error.name); await cleanup(); process.exit(1); });
