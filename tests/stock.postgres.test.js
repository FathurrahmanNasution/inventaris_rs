// Real PostgreSQL tests. Never fall back to DATABASE_URL or connect to remote hosts.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const url = process.env.STOCK_TEST_DATABASE_URL;
if (!url) {
  test('PostgreSQL stock integration (set STOCK_TEST_DATABASE_URL to a dedicated local test DB)', { skip: true }, () => {});
} else {
  const target = new URL(url);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.pathname !== '/stock_inventory_test' || target.search)
    throw new Error('Stock tests require a local database named stock_inventory_test, without URL query options.');
  const { Pool } = require('pg');
  const schema = 'stock_test_' + randomUUID().replaceAll('-', '');
  const bootstrap = new Pool({ connectionString: url, ssl: false });
  const pool = new Pool({ connectionString: url, ssl: false, options: '-c search_path=' + schema, max: 12 });
  const db = { pool, query: (sql, params) => pool.query(sql, params) };
  const dbPath = require.resolve('../src/config/db');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
  process.env.JWT_SECRET = 'stock-integration-local-tests-only-secret-123456789';
  process.env.NODE_ENV = 'test';
  delete process.env.APP_ORIGIN;
  let server, origin, auth, users, today, tomorrow, later, hash;
  const sqlFile = file => readFileSync(path.join(__dirname, '..', file), 'utf8');
  const day = offset => new Date(Date.parse(today) + offset * 86400000).toISOString().slice(0, 10);
  before(async () => {
    await bootstrap.query('CREATE SCHEMA ' + schema);
    await pool.query(sqlFile('tests/fixtures/stock-schema.sql'));
    await pool.query(sqlFile('migrations/001_stock_documents.sql'));
    // Re-applying the additive migration must preserve existing schema/data.
    await pool.query(sqlFile('migrations/001_stock_documents.sql'));
    hash = await require('bcryptjs').hash('StockTest123!', 4);
    today = (await pool.query("SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date::text AS day")).rows[0].day;
    tomorrow = day(1); later = day(30);
    auth = require('../src/services/authService');
    server = require('../server').listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  beforeEach(async () => {
    // Only our randomly-created schema is in search_path; public/shared data is never touched.
    await pool.query('TRUNCATE stock_transactions, stock_documents, medicine_batches, medicines, audit_logs, users RESTART IDENTITY CASCADE');
    users = [];
    for (const role of ['admin', 'gudang', 'pelayanan', 'kepala_farmasi']) {
      users.push((await pool.query('INSERT INTO users (username,password_hash,role) VALUES ($1,$2,$3) RETURNING *', ['test_' + role, hash, role])).rows[0]);
    }
    await pool.query("INSERT INTO medicines (medicine_code,name,category,unit,status) VALUES ('MED-A','Obat A','Uji','Tablet','aktif'),('MED-B','Obat B','Uji','Kapsul','aktif'),('OLD','Nonaktif','Uji','Tablet','nonaktif')");
  });
  after(async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await pool.end();
    // Cleanup owns exactly this newly generated schema in the dedicated local database.
    if (!/^stock_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe schema');
    await bootstrap.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await bootstrap.end();
  });
  const token = role => auth.createJwtToken(users.find(u => u.role === role));
  async function request(route, { method = 'GET', body, role = 'gudang', jwt, headers = {} } = {}) {
    const response = await fetch(origin + route, { method, redirect: 'manual',
      headers: { ...(role ? { Authorization: 'Bearer ' + (jwt || token(role)) } : {}),
        ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await response.text(); let data; try { data = JSON.parse(raw); } catch { data = raw; }
    return { status: response.status, data, headers: response.headers };
  }
  const incoming = (batch = 'B-1', qty = 10, exp = tomorrow, code = 'MED-A') => ({
    reference_number: 'FAK-TEST', received_date: today, supplier: 'PBF Uji', notes: 'Terima uji',
    items: [{ medicine_code: code, batch_number: batch, quantity: qty, expired_date: exp, unit_price: '1250.25' }]
  });
  const outgoing = qty => ({ reference_number: 'RSP-TEST', destination: 'IGD', medicine_code: 'MED-A', quantity: qty, notes: 'Uji resep' });
  const stockIn = body => request('/api/stock/in', { method: 'POST', body });
  const stockOut = body => request('/api/stock/out', { method: 'POST', role: 'pelayanan', body });
  const quantities = async () => (await pool.query('SELECT batch_number,current_qty FROM medicine_batches ORDER BY batch_number')).rows;
  async function counts() {
    const result = {};
    for (const table of ['medicine_batches', 'stock_documents', 'stock_transactions', 'audit_logs']) result[table] = Number((await pool.query('SELECT COUNT(*) FROM ' + table)).rows[0].count);
    return result;
  }

  test('stock IN commits batch, purchase price, reference, audit and reloadable receipt', async () => {
    const r = await stockIn(incoming()); assert.equal(r.status, 201);
    const doc = r.data.data;
    assert.equal(doc.items[0].unit_price, '1250.25'); assert.equal(doc.supplier, 'PBF Uji');
    assert.deepEqual(await quantities(), [{ batch_number: 'B-1', current_qty: 10 }]);
    const receipt = (await request('/api/stock/documents/' + doc.document_id)).data.data;
    assert.equal(receipt.items[0].quantity, 10); assert.equal(receipt.reference_number, 'FAK-TEST');
    assert.equal(receipt.username, 'test_gudang'); assert.equal(receipt.notes, 'Terima uji');
    const audit = (await pool.query('SELECT * FROM audit_logs')).rows[0];
    assert.match(audit.action, /stock_in: document=/); assert.ok(audit.ip_address); assert.equal(audit.user_id, 2);
    assert.equal((await request('/api/stock/receipts?limit=5')).data.data[0].document_id, doc.document_id);
  });
  test('duplicate batch is globally rejected, including another medicine and exhausted batches', async () => {
    await stockIn(incoming()); await stockOut(outgoing(10));
    const before = await counts();
    assert.equal((await stockIn(incoming('B-1', 5, later, 'MED-B'))).status, 409);
    assert.deepEqual(await counts(), before);
    const body = incoming(); body.items.push({ ...body.items[0] });
    assert.equal((await stockIn(body)).status, 409);
  });
  test('expiry yesterday, today, impossible date and future received date are rejected', async () => {
    for (const exp of [day(-1), today, '2027-02-30', 'not-a-date']) assert.equal((await stockIn(incoming('B', 10, exp))).status, 400);
    const future = incoming(); future.received_date = tomorrow;
    assert.equal((await stockIn(future)).status, 400);
    const backdated = incoming('BACK', 10, today); backdated.received_date = day(-5);
    assert.equal((await stockIn(backdated)).status, 400);
    assert.equal((await counts()).medicine_batches, 0);
  });
  test('valid backdated receipt retains transaction date', async () => {
    const body = incoming(); body.received_date = day(-3);
    const r = await stockIn(body); assert.equal(r.status, 201); assert.equal(r.data.data.transaction_date, day(-3));
  });
  test('quantities, medicine, price and required document fields are validated', async () => {
    for (const quantity of [0, -1, 1.5, '2', 2147483648, null]) {
      const body = incoming(); body.items[0].quantity = quantity;
      assert.equal((await stockIn(body)).status, 400);
      assert.equal((await stockOut({ ...outgoing(1), quantity })).status, 400);
    }
    for (const value of [-1, '', '1.001', '1e3', true, 10000000000000]) {
      const body = incoming(); body.items[0].unit_price = value; assert.equal((await stockIn(body)).status, 400);
    }
    for (const field of ['reference_number', 'supplier', 'received_date']) {
      const body = incoming(); delete body[field]; assert.equal((await stockIn(body)).status, 400);
    }
    assert.equal((await stockIn(incoming('B', 1, later, 'MISSING'))).status, 404);
    assert.equal((await stockIn(incoming('B', 1, later, 'OLD'))).status, 409);
    assert.equal((await stockOut({ ...outgoing(1), destination: '' })).status, 400);
    assert.equal((await counts()).stock_documents, 0);
  });
  test('OUT from one batch stores reference, destination, ledger and audit', async () => {
    await stockIn(incoming()); const r = await stockOut(outgoing(4)); assert.equal(r.status, 201);
    assert.equal(r.data.data.items.length, 1); assert.equal(r.data.data.items[0].quantity, 4);
    assert.equal((await quantities())[0].current_qty, 6);
    const receipt = (await request('/api/stock/documents/' + r.data.data.document_id)).data.data;
    assert.equal(receipt.destination, 'IGD'); assert.equal(receipt.reference_number, 'RSP-TEST');
    assert.equal(receipt.items[0].batch_number, 'B-1');
    assert.match((await pool.query('SELECT action FROM audit_logs ORDER BY log_id DESC LIMIT 1')).rows[0].action, /^stock_out:/);
  });
  test('OUT uses multiple batches by expiry with deterministic batch-number tie break', async () => {
    await stockIn(incoming('Z-LATE', 15, later)); await stockIn(incoming('B-EARLY', 3)); await stockIn(incoming('A-EARLY', 5));
    const r = await stockOut(outgoing(10)); assert.equal(r.status, 201);
    assert.deepEqual(r.data.data.items.map(i => [i.batch_number, i.quantity]), [['A-EARLY', 5], ['B-EARLY', 3], ['Z-LATE', 2]]);
    assert.deepEqual((await quantities()).map(b => b.current_qty), [0, 0, 13]);
  });
  test('insufficient stock leaves every batch, document, ledger and audit unchanged', async () => {
    await stockIn(incoming()); const before = await counts();
    assert.equal((await stockOut(outgoing(11))).status, 409);
    assert.deepEqual(await counts(), before); assert.equal((await quantities())[0].current_qty, 10);
  });
  test('expired and expiry-today batches are excluded from preview and deduction', async () => {
    await stockIn(incoming('GOOD', 5));
    await pool.query("INSERT INTO medicine_batches VALUES ('EXPIRED','MED-A',100,$1,'PBF',CURRENT_TIMESTAMP),('TODAY','MED-A',100,$2,'PBF',CURRENT_TIMESTAMP)", [day(-1), today]);
    const preview = (await request('/api/stock/medicines/MED-A/batches')).data.data;
    assert.deepEqual(preview.map(b => b.batch_number), ['GOOD']);
    assert.equal((await stockOut(outgoing(6))).status, 409);
    assert.equal((await stockOut(outgoing(5))).status, 201);
    assert.deepEqual((await quantities()).map(b => b.current_qty), [100, 0, 100]);
  });
  test('parallel deductions cannot oversell (real PostgreSQL row locks)', async () => {
    await stockIn(incoming('B-1', 10));
    const results = await Promise.all([stockOut(outgoing(7)), stockOut(outgoing(7))]);
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    assert.equal((await quantities())[0].current_qty, 3);
    assert.equal((await pool.query("SELECT SUM(quantity) AS n FROM stock_transactions WHERE transaction_type='OUT'")).rows[0].n, '7');
    assert.equal((await counts()).audit_logs, 2);
  });
  test('simultaneous duplicate IN requests create one batch and one receipt', async () => {
    const results = await Promise.all([stockIn(incoming()), stockIn(incoming())]);
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    assert.deepEqual(await counts(), { medicine_batches: 1, stock_documents: 1, stock_transactions: 1, audit_logs: 1 });
  });
  test('multi-item receipt rolls back when a later item conflicts', async () => {
    await stockIn(incoming('EXISTING')); const before = await counts();
    const body = incoming('NEW'); body.items.push({ ...body.items[0], batch_number: 'EXISTING' });
    assert.equal((await stockIn(body)).status, 409); assert.deepEqual(await counts(), before);
    assert.equal((await quantities())[0].batch_number, 'EXISTING');
  });
  test('multi-medicine OUT rolls back earlier allocations if a later medicine is insufficient', async () => {
    await stockIn(incoming()); const before = await counts();
    const body = { ...outgoing(1), items: [{ medicine_code: 'MED-A', quantity: 2 }, { medicine_code: 'MED-B', quantity: 1 }] };
    assert.equal((await stockOut(body)).status, 409); assert.deepEqual(await counts(), before);
    assert.equal((await quantities())[0].current_qty, 10);
  });
  test('audit insert failure rolls back IN and OUT including already changed batches', async () => {
    await stockIn(incoming());
    await pool.query("CREATE FUNCTION fail_stock_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated audit failure'; END $$; CREATE TRIGGER fail_stock_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_stock_audit()");
    try {
      const before = await counts();
      assert.equal((await stockIn(incoming('NEW'))).status, 500);
      assert.equal((await stockOut(outgoing(3))).status, 500);
      assert.deepEqual(await counts(), before); assert.equal((await quantities())[0].current_qty, 10);
    } finally { await pool.query('DROP TRIGGER fail_stock_audit ON audit_logs; DROP FUNCTION fail_stock_audit()'); }
  });
  test('ledger failure on second OUT batch rolls back first deduction and first OUT entry', async () => {
    await stockIn(incoming('FIRST', 3)); await stockIn(incoming('SECOND', 5, later));
    await pool.query("CREATE FUNCTION fail_stock_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.transaction_type='OUT' AND NEW.batch_number='SECOND' THEN RAISE EXCEPTION 'simulated ledger failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_stock_ledger BEFORE INSERT ON stock_transactions FOR EACH ROW EXECUTE FUNCTION fail_stock_ledger()");
    try {
      const before = await counts();
      assert.equal((await stockOut(outgoing(5))).status, 500);
      assert.deepEqual(await counts(), before); assert.deepEqual((await quantities()).map(b => b.current_qty), [3, 5]);
    } finally { await pool.query('DROP TRIGGER fail_stock_ledger ON stock_transactions; DROP FUNCTION fail_stock_ledger()'); }
  });
  test('authentication, stale role/status, CSRF and RBAC for all four roles', async () => {
    assert.equal((await request('/api/stock/in', { method: 'POST', role: null, body: incoming() })).status, 401);
    for (const role of ['admin', 'pelayanan']) assert.equal((await request('/api/stock/in', { method: 'POST', role, body: incoming() })).status, 403);
    for (const role of ['admin', 'gudang']) assert.equal((await request('/api/stock/out', { method: 'POST', role, body: outgoing(1) })).status, 403);
    assert.equal((await request('/stok-keluar', { role: 'admin' })).status, 403);
    assert.equal((await request('/stok-masuk', { role: 'admin' })).status, 403);
    const jwt = token('gudang');
    await pool.query("UPDATE users SET role='admin' WHERE user_id=2");
    assert.equal((await request('/api/stock/in', { method: 'POST', jwt, body: incoming() })).status, 403);
    await pool.query("UPDATE users SET status='nonaktif' WHERE user_id=2");
    assert.equal((await request('/api/stock/in', { method: 'POST', jwt, body: incoming() })).status, 401);
    assert.equal((await request('/api/stock/in', { method: 'POST', role: 'kepala_farmasi', body: incoming(), headers: { Origin: 'https://foreign.invalid' } })).status, 403);
    assert.equal((await request('/api/stock/in', { method: 'POST', role: 'kepala_farmasi', body: incoming() })).status, 201);
    assert.equal((await request('/api/stock/out', { method: 'POST', role: 'kepala_farmasi', body: outgoing(1) })).status, 201);
  });
  test('history integrates IN/OUT with period opening balance and audit/document consistency', async () => {
    const body = incoming(); body.received_date = day(-2); await stockIn(body); await stockOut(outgoing(4));
    const history = (await request('/api/stock/history?medicine_code=MED-A')).data.data;
    assert.deepEqual(history.entries.map(i => [i.opening_balance, i.change, i.closing_balance]), [[0, 10, 10], [10, -4, 6]]);
    const filtered = (await request('/api/stock/history?medicine_code=MED-A&from=' + today)).data.data;
    assert.equal(filtered.entries.length, 1); assert.equal(filtered.opening_balance, 10); assert.equal(filtered.final_balance, 6);
    const persisted = await counts(); assert.equal(persisted.stock_documents, persisted.audit_logs); assert.equal(persisted.stock_transactions, 2);
    const docs = (await pool.query('SELECT document_id FROM stock_documents')).rows;
    const logs = (await pool.query('SELECT action FROM audit_logs')).rows;
    for (const doc of docs) assert.ok(logs.some(log => log.action.includes(doc.document_id)));
  });
  test('lookups, missing receipts, invalid query values and real fixture login', async () => {
    assert.equal((await request('/api/stock/medicines', { role: null })).status, 401);
    assert.equal((await request('/api/stock/medicines')).data.data.data.length, 2);
    assert.equal((await request('/api/stock/medicines/MISSING/batches')).status, 404);
    assert.equal((await request('/api/stock/documents/invalid')).status, 400);
    assert.equal((await request('/api/stock/documents/' + randomUUID())).status, 404);
    assert.equal((await request('/api/stock/receipts?limit=0')).status, 400);
    assert.equal((await request('/api/stock/history?medicine_code=MED-A&from=2027-02-30')).status, 400);
    const login = await request('/api/auth/login', { role: null, method: 'POST', body: { username: 'test_gudang', password: 'StockTest123!' } });
    assert.equal(login.status, 200); assert.ok(login.headers.get('set-cookie'));
  });
}
