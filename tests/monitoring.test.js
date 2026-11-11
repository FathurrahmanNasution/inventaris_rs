// Pengujian HTTP terisolasi modul Monitoring Kedaluwarsa & Stok Minimum.
// Memakai in-memory DB adapter (tests/helpers/memdb) — tidak menyentuh Neon.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'isolated-test-secret-not-for-use-outside-tests-123456789';
process.env.NODE_ENV = 'test';
delete process.env.APP_ORIGIN;

const { createDb } = require('./helpers/memdb');
const db = createDb();
const dbPath = require.resolve('../src/config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };

let app, server, origin, auth;
const ROLES = ['admin', 'gudang', 'pelayanan', 'kepala_farmasi'];

before(async () => {
  auth = require('../src/services/authService');
  app = require('../server');
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

beforeEach(() => {
  db.state.today = '2026-09-21';
  db.state.users = ROLES.map((role, i) => ({ user_id: i + 1, username: 'test_' + role, password_hash: 'hash_' + role, role, status: 'aktif', created_at: '2026-09-01T00:00:00Z' }));
  db.state.medicines = [
    { medicine_code: 'MED-A', name: 'Amoxicillin', category: 'Antibiotik', unit: 'Kapsul', price: 1000, min_stock: 100, status: 'aktif' },
    { medicine_code: 'MED-B', name: 'Betadine', category: 'Antiseptik', unit: 'Botol', price: 2000, min_stock: 50, status: 'aktif' },
    { medicine_code: 'MED-C', name: 'Cefixime', category: 'Antibiotik', unit: 'Kapsul', price: 3000, min_stock: 10, status: 'aktif' },
    { medicine_code: 'MED-D', name: 'Obat Lama', category: 'Lain', unit: 'Tablet', price: 500, min_stock: 999, status: 'nonaktif' },
    { medicine_code: 'MED-E', name: 'Ranitidine', category: 'Lambung', unit: 'Ampul', price: 5000, min_stock: 5, status: 'aktif' }
  ];
  db.state.batches = [
    { batch_number: 'B-A1', medicine_code: 'MED-A', current_qty: 150, expired_date: '2026-10-01', supplier: 'PBF Satu' }, // 10 hari (kritis)
    { batch_number: 'B-A2', medicine_code: 'MED-A', current_qty: 0, expired_date: '2026-10-02', supplier: 'PBF Satu' },   // qty 0 (diabaikan)
    { batch_number: 'B-B1', medicine_code: 'MED-B', current_qty: 40, expired_date: '2026-11-20', supplier: 'PBF Dua' },   // 60 hari (perhatian)
    { batch_number: 'B-C1', medicine_code: 'MED-C', current_qty: 5, expired_date: '2026-09-10', supplier: 'PBF Tiga' },   // -11 hari (kritis, lewat)
    { batch_number: 'B-C2', medicine_code: 'MED-C', current_qty: 3, expired_date: '2027-06-01', supplier: 'PBF Tiga' }    // > 90 hari (aman)
  ];
  db.state.transactions = []; db.state.opname = []; db.state.opnameItems = []; db.state.logs = [];
  db.state.seq = { opname: 0, item: 0, tx: 0, log: 0 };
});

function token(id = 1) { return auth.createJwtToken(db.state.users.find(u => u.user_id === id)); }
async function request(path, { method = 'GET', body, jwt, headers = {} } = {}) {
  const response = await fetch(origin + path, { method, redirect: 'manual',
    headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(jwt ? { Cookie: 'token=' + jwt } : {}), ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}

test('monitoring endpoints require authentication', async () => {
  for (const path of ['/api/monitoring/expiry', '/api/monitoring/low-stock', '/api/monitoring/summary'])
    assert.equal((await request(path)).status, 401);
  assert.equal((await request('/api/monitoring/action', { method: 'POST', body: { batchNumber: 'B-A1', action: 'retur' } })).status, 401);
});

test('expiry alerts classify critical (<=30d incl. expired) and warning (31-90d), skip safe/zero', async () => {
  const result = await request('/api/monitoring/expiry', { jwt: token(2) });
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.data.summary, { all: 3, critical: 2, warning: 1 });
  const alerts = result.data.data.alerts;
  assert.equal(alerts.length, 3);
  assert.equal(alerts[0].batch_number, 'B-C1');            // paling mendesak (kedaluwarsa terdekat)
  assert.equal(alerts[0].days_remaining, -11);
  assert.equal(alerts[0].status, 'critical');
  assert.ok(!alerts.some(a => a.batch_number === 'B-A2'), 'batch stok 0 tidak muncul');
  assert.ok(!alerts.some(a => a.batch_number === 'B-C2'), 'batch > 90 hari tidak muncul');
});

test('expiry filter critical/warning returns only matching rows', async () => {
  const critical = (await request('/api/monitoring/expiry?filter=critical', { jwt: token(3) })).data.data;
  assert.equal(critical.filter, 'critical');
  assert.equal(critical.alerts.length, 2);
  assert.ok(critical.alerts.every(a => a.status === 'critical'));
  const warning = (await request('/api/monitoring/expiry?filter=warning', { jwt: token(3) })).data.data;
  assert.equal(warning.alerts.length, 1);
  assert.equal(warning.alerts[0].batch_number, 'B-B1');
});

test('low-stock lists medicines at/below min_stock, excludes inactive, flags out-of-stock', async () => {
  const result = await request('/api/monitoring/low-stock', { jwt: token(1) });
  assert.equal(result.status, 200);
  const codes = result.data.data.items.map(i => i.medicine_code);
  assert.deepEqual([...codes].sort(), ['MED-B', 'MED-C', 'MED-E']);
  assert.ok(!codes.includes('MED-A'), 'stok cukup tidak termasuk');
  assert.ok(!codes.includes('MED-D'), 'obat nonaktif dikecualikan');
  assert.equal(result.data.data.items.find(i => i.medicine_code === 'MED-E').status, 'habis');
  assert.equal(result.data.data.items.find(i => i.medicine_code === 'MED-B').status, 'menipis');
});

test('summary aggregates expiry and stock counts', async () => {
  const data = (await request('/api/monitoring/summary', { jwt: token(4) })).data.data;
  assert.deepEqual(data, { expiring_critical: 2, expiring_warning: 1, expiring_total: 3, low_stock: 3, out_of_stock: 1 });
});

test('all authenticated roles can read monitoring', async () => {
  for (const id of [1, 2, 3, 4]) assert.equal((await request('/api/monitoring/expiry', { jwt: token(id) })).status, 200);
});

test('action records audit for operational roles, denies Admin IT, validates input', async () => {
  // Admin IT dilarang (separation of duties)
  assert.equal((await request('/api/monitoring/action', { jwt: token(1), method: 'POST', body: { batchNumber: 'B-A1', action: 'retur' } })).status, 403);
  // Jenis aksi tidak valid
  assert.equal((await request('/api/monitoring/action', { jwt: token(4), method: 'POST', body: { batchNumber: 'B-A1', action: 'hapus' } })).status, 400);
  // Batch tidak ada
  assert.equal((await request('/api/monitoring/action', { jwt: token(2), method: 'POST', body: { batchNumber: 'NOPE', action: 'retur' } })).status, 404);
  // Berhasil + tercatat di audit
  const ok = await request('/api/monitoring/action', { jwt: token(2), method: 'POST', body: { batch_number: 'B-A1', action: 'distribusi' } });
  assert.equal(ok.status, 200);
  assert.equal(db.state.logs.at(-1).action, 'monitoring_distribusi: batch=B-A1');
});
