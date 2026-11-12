// Disposable server for the optional Playwright smoke check. No .env DB is used.
const { Pool } = require('pg');
const { randomUUID } = require('crypto');
const { readFileSync } = require('fs');
const path = require('path');
const target = new URL(process.env.STOCK_TEST_DATABASE_URL || 'http://invalid');
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.pathname !== '/stock_inventory_test' || target.search)
  throw new Error('Use a dedicated local stock_inventory_test database.');
const schema = 'stock_ui_' + randomUUID().replaceAll('-', '');
const bootstrap = new Pool({ connectionString: target.href, ssl: false });
const pool = new Pool({ connectionString: target.href, ssl: false, options: '-c search_path=' + schema });
const query = (sql, params) => pool.query(sql, params);
const dbPath = require.resolve('../../src/config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query, pool } };
process.env.JWT_SECRET = 'isolated-stock-ui-secret-not-for-production-123456789';
process.env.NODE_ENV = 'test';
delete process.env.APP_ORIGIN;
let server;
async function cleanup() {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await pool.end();
  if (!/^stock_ui_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe test schema');
  await bootstrap.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
  await bootstrap.end();
}
(async () => {
  await bootstrap.query('CREATE SCHEMA ' + schema);
  for (const file of ['tests/fixtures/stock-schema.sql', 'migrations/001_stock_documents.sql'])
    await query(readFileSync(path.join(__dirname, '../..', file), 'utf8'));
  const hash = await require('bcryptjs').hash('StockUi123!', 4);
  const actor = (await query("INSERT INTO users (username,password_hash,role) VALUES ('ui_kepala',$1,'kepala_farmasi') RETURNING *", [hash])).rows[0];
  await query("INSERT INTO medicines (medicine_code,name,category,unit) VALUES ('MED-UI','Obat Uji Browser','Uji','Tablet')");
  const today = (await query("SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date::text AS day")).rows[0].day;
  const day = offset => new Date(Date.parse(today) + offset * 86400000).toISOString().slice(0, 10);
  for (const [batch, qty, offset] of [['PRE-LATE', 8, 30], ['PRE-EARLY', 3, 1]])
    await require('../../src/services/stockService').stockIn({ reference_number: 'SEED-' + batch, received_date: today, supplier: 'PBF UI',
      items: [{ medicine_code: 'MED-UI', batch_number: batch, quantity: qty, expired_date: day(offset), unit_price: '10.00' }] }, actor.user_id, '127.0.0.1');
  server = require('../../server').listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  console.log(JSON.stringify({ ready: true, origin: 'http://127.0.0.1:' + server.address().port, today, expiry: day(10) }));
  process.stdin.once('data', () => cleanup().then(() => process.exit(0)).catch(() => process.exit(1)));
  process.stdin.resume();
})().catch(async error => { console.error(error.code || error.name); await cleanup(); process.exit(1); });
