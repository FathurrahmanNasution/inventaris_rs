// Pengujian HTTP terisolasi endpoint Dashboard (REQ-DASH-001 s/d 004).
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

const tx = (id, code, type, quantity, date, ref) => ({ transaction_id: id, medicine_code: code, batch_number: 'B-X',
  user_id: 2, transaction_type: type, quantity, reference_number: ref, transaction_date: date, created_at: date + 'T08:00:00Z' });

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
    { batch_number: 'B-B1', medicine_code: 'MED-B', current_qty: 40, expired_date: '2026-11-20', supplier: 'PBF Dua' },   // 60 hari (perhatian)
    { batch_number: 'B-C1', medicine_code: 'MED-C', current_qty: 5, expired_date: '2026-09-10', supplier: 'PBF Tiga' },   // lewat 11 hari (kritis)
    { batch_number: 'B-C2', medicine_code: 'MED-C', current_qty: 3, expired_date: '2027-06-01', supplier: 'PBF Tiga' },   // aman
    { batch_number: 'B-D1', medicine_code: 'MED-D', current_qty: 70, expired_date: '2027-01-01', supplier: 'PBF Empat' }  // obat nonaktif
  ];
  db.state.transactions = [
    tx(1, 'MED-A', 'OUT', 99, '2026-03-30', 'RSP-OLD'),     // di luar jendela 6 bulan
    tx(2, 'MED-A', 'OUT', 4, '2026-07-15', 'RSP-001'),
    tx(3, 'MED-B', 'IN', 50, '2026-09-01', 'FKT-001'),
    tx(4, 'MED-A', 'OUT', 6, '2026-09-05', 'RSP-002'),
    tx(5, 'MED-C', 'OUT', 4, '2026-09-05', 'RSP-002'),
    tx(6, 'MED-C', 'ADJUSTMENT', -2, '2026-09-18', 'OPN-1'),
    tx(7, 'MED-A', 'IN', 20, '2026-09-20', 'FKT-002')
  ];
  db.state.opname = []; db.state.opnameItems = []; db.state.logs = [];
  db.state.seq = { opname: 0, item: 0, tx: 7, log: 0 };
});

function token(id = 1) { return auth.createJwtToken(db.state.users.find(u => u.user_id === id)); }
async function request(path, jwt) {
  const response = await fetch(origin + path, { redirect: 'manual', headers: jwt ? { Cookie: 'token=' + jwt } : {} });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}

test('dashboard requires authentication', async () => {
  assert.equal((await request('/api/dashboard')).status, 401);
});

test('every role can read the dashboard (read-only)', async () => {
  for (const [i] of ROLES.entries()) {
    const res = await request('/api/dashboard', token(i + 1));
    assert.equal(res.status, 200, ROLES[i]);
    assert.equal(res.data.success, true);
  }
});

test('KPI cards: active medicines, asset value, low stock, near expiry', async () => {
  const { data } = (await request('/api/dashboard', token(4))).data;
  assert.equal(data.totalMedicines, 4, 'obat nonaktif tidak dihitung');                 // REQ-DASH-001
  assert.equal(data.assetValue, 150 * 1000 + 40 * 2000 + 8 * 3000, 'qty x harga obat aktif'); // REQ-DASH-002
  assert.equal(data.lowStock, 3, 'Betadine, Cefixime, Ranitidine (habis)');            // REQ-DASH-003
  assert.equal(data.nearExpiry, 2, 'batch <= 30 hari termasuk yang sudah lewat');
});

test('monthly OUT trend covers the last 6 months with zero-filled gaps', async () => {
  const { monthlyOut } = (await request('/api/dashboard', token(4))).data.data;   // REQ-DASH-004
  assert.deepEqual(monthlyOut.map(m => m.key), ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
  assert.deepEqual(monthlyOut.map(m => m.month), ['Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep']);
  assert.deepEqual(monthlyOut.map(m => m.qty), [0, 0, 0, 4, 0, 10], 'hanya OUT, IN/ADJUSTMENT diabaikan');
});

test('alerts list expired/critical batches first, then low stock', async () => {
  const { alerts } = (await request('/api/dashboard', token(2))).data.data;
  assert.deepEqual(alerts.map(a => a.kind), ['expiry', 'expiry', 'stock', 'stock', 'stock']);
  assert.equal(alerts[0].batch_number, 'B-C1');
  assert.match(alerts[0].detail, /lewat 11 hari/);
  const habis = alerts.find(a => a.medicine_code === 'MED-E');
  assert.equal(habis.level, 'red');
  assert.match(habis.detail, /Stok habis/);
});

test('many expiry alerts never hide low-stock alerts (max 6 in total)', async () => {
  for (let i = 0; i < 8; i++)
    db.state.batches.push({ batch_number: 'B-X' + i, medicine_code: 'MED-A', current_qty: 1, expired_date: '2026-09-25', supplier: 'PBF' });
  const { alerts } = (await request('/api/dashboard', token(2))).data.data;
  assert.equal(alerts.length, 6);
  assert.equal(alerts.filter(a => a.kind === 'stock').length, 3);
  assert.equal(alerts.filter(a => a.kind === 'expiry').length, 3);
});

test('recent transactions are newest first and limited to 5', async () => {
  const { recentTransactions } = (await request('/api/dashboard', token(3))).data.data;
  assert.equal(recentTransactions.length, 5);
  assert.deepEqual(recentTransactions.map(t => t.reference_number), ['FKT-002', 'OPN-1', 'RSP-002', 'RSP-002', 'FKT-001']);
  assert.deepEqual(Object.keys(recentTransactions[0]).sort(), ['created_at', 'medicine_name', 'quantity', 'reference_number', 'type', 'unit']);
  assert.equal(recentTransactions[1].type, 'ADJUSTMENT');
});

test('category share is computed from active stock and skips empty categories', async () => {
  const { categoryShare } = (await request('/api/dashboard', token(4))).data.data;
  assert.deepEqual(categoryShare, [
    { name: 'Antibiotik', qty: 158, percent: 80 },
    { name: 'Antiseptik', qty: 40, percent: 20 }
  ]);
});

test('empty database yields zeros instead of errors', async () => {
  db.state.medicines = []; db.state.batches = []; db.state.transactions = [];
  const { data } = (await request('/api/dashboard', token(4))).data;
  assert.equal(data.totalMedicines, 0);
  assert.equal(data.assetValue, 0);
  assert.equal(data.monthlyOut.length, 6);
  assert.deepEqual(data.alerts, []);
  assert.deepEqual(data.recentTransactions, []);
  assert.deepEqual(data.categoryShare, []);
});

test('month window crosses the year boundary', () => {
  const { lastMonths } = require('../src/services/dashboardService');
  assert.deepEqual(lastMonths('2026-02-10'), ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02']);
});
