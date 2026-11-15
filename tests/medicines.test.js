// Pengujian HTTP terisolasi modul Data Obat (REQ-MED-001 s/d 003, 005, 007).
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
const ID = { admin: 1, gudang: 2, pelayanan: 3, kepala: 4 };

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
    { medicine_code: 'AMOX500', name: 'Amoxicillin 500mg', category: 'Antibiotik', unit: 'Kapsul', price: 10000, min_stock: 100, status: 'aktif' },
    { medicine_code: 'OMP20', name: 'Omeprazole 20mg', category: 'Lambung', unit: 'Kapsul', price: 30000, min_stock: 50, status: 'aktif' },
    { medicine_code: 'PCT500', name: 'Paracetamol 500mg', category: 'Analgesik', unit: 'Tablet', price: 3000, min_stock: 200, status: 'aktif' },
    { medicine_code: 'AMBSYR', name: 'Ambroxol Syr', category: 'Mukolitik', unit: 'Botol', price: 16000, min_stock: 20, status: 'aktif' },
    { medicine_code: 'OLD1', name: 'Obat Lama', category: 'Lainnya', unit: 'Tablet', price: 500, min_stock: 10, status: 'nonaktif' }
  ];
  db.state.batches = [
    { batch_number: 'AMX-1', medicine_code: 'AMOX500', current_qty: 150, expired_date: '2026-10-01', supplier: 'PBF' }, // 10 hari
    { batch_number: 'AMX-2', medicine_code: 'AMOX500', current_qty: 0, expired_date: '2026-09-25', supplier: 'PBF' },  // kosong, diabaikan
    { batch_number: 'OMP-1', medicine_code: 'OMP20', current_qty: 40, expired_date: '2027-03-01', supplier: 'PBF' },   // menipis (40 <= 50)
    { batch_number: 'AMB-1', medicine_code: 'AMBSYR', current_qty: 36, expired_date: '2026-12-31', supplier: 'PBF' }
  ];
  db.state.transactions = []; db.state.opname = []; db.state.opnameItems = []; db.state.logs = [];
  db.state.seq = { opname: 0, item: 0, tx: 0, log: 0 };
});

function token(id) { return auth.createJwtToken(db.state.users.find(u => u.user_id === id)); }
async function request(path, { method = 'GET', body, jwt } = {}) {
  const response = await fetch(origin + path, { method, redirect: 'manual',
    headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(jwt ? { Cookie: 'token=' + jwt } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}
const newMedicine = (extra = {}) => ({ medicine_code: 'cpt25', name: 'Captopril 25mg', category: 'Antihipertensi', unit: 'Tablet', price: 1500, min_stock: 100, ...extra });

test('medicine endpoints require authentication', async () => {
  assert.equal((await request('/api/medicines')).status, 401);
  assert.equal((await request('/api/categories')).status, 401);
  assert.equal((await request('/api/medicines', { method: 'POST', body: newMedicine() })).status, 401);
});

test('list returns stock, nearest expiry, and status for every role', async () => {
  for (const id of Object.values(ID)) assert.equal((await request('/api/medicines', { jwt: token(id) })).status, 200);
  const { data, total } = (await request('/api/medicines?limit=100', { jwt: token(ID.pelayanan) })).data.data;
  assert.equal(total, 5);
  const amox = data.find(m => m.medicine_code === 'AMOX500');
  assert.deepEqual({ total_stock: amox.total_stock, days: amox.days, is_active: amox.is_active }, { total_stock: 150, days: 10, is_active: true });
  assert.equal(data.find(m => m.medicine_code === 'PCT500').days, null, 'tanpa batch bersisa');
  assert.equal(data.find(m => m.medicine_code === 'OLD1').is_active, false);
});

test('search, category, status filters and pagination (REQ-MED-001)', async () => {
  const get = async q => (await request('/api/medicines?' + q, { jwt: token(ID.gudang) })).data.data;
  assert.deepEqual((await get('search=amox')).data.map(m => m.medicine_code), ['AMOX500']);
  assert.deepEqual((await get('search=OMP')).data.map(m => m.medicine_code), ['OMP20']);
  assert.deepEqual((await get('category=Lambung')).data.map(m => m.medicine_code), ['OMP20']);
  assert.deepEqual((await get('filter=expiring')).data.map(m => m.medicine_code), ['AMOX500']);
  assert.deepEqual((await get('filter=low')).data.map(m => m.medicine_code).sort(), ['OMP20', 'PCT500']);
  assert.deepEqual((await get('filter=nonaktif')).data.map(m => m.medicine_code), ['OLD1']);
  assert.equal((await get('active=1')).total, 4);
  const page2 = await get('limit=2&page=2');
  assert.equal(page2.total, 5);
  assert.equal(page2.data.length, 2);
  assert.equal((await request('/api/medicines?filter=unknown', { jwt: token(ID.gudang) })).status, 400);
  assert.equal((await request('/api/medicines?limit=500', { jwt: token(ID.gudang) })).status, 400);
});

test('categories include every category already used in the database', async () => {
  const names = (await request('/api/categories', { jwt: token(ID.gudang) })).data.data.map(c => c.name);
  for (const used of ['Antibiotik', 'Lambung', 'Analgesik', 'Mukolitik', 'Lainnya']) assert.ok(names.includes(used), used);
  assert.ok(names.includes('Antidiabetik'), 'kategori bawaan tetap ada');
  assert.ok(!names.includes('Antidiabetes'), 'tidak ada nama ganda untuk antidiabetik');
  assert.equal(names.at(-1), 'Lainnya');
  assert.equal(new Set(names).size, names.length, 'tanpa duplikat');
});

test('only Kepala Farmasi can add or change medicine status (SRS 2.3)', async () => {
  for (const id of [ID.admin, ID.gudang, ID.pelayanan]) {
    assert.equal((await request('/api/medicines', { method: 'POST', body: newMedicine(), jwt: token(id) })).status, 403);
    assert.equal((await request('/api/medicines/AMOX500/status', { method: 'PATCH', body: { is_active: false }, jwt: token(id) })).status, 403);
  }
  assert.equal(db.state.medicines.length, 5);
  assert.equal(db.state.logs.length, 0);
});

test('creating a medicine validates input, normalizes the code, and writes an audit log', async () => {
  const jwt = token(ID.kepala);
  assert.equal((await request('/api/medicines', { method: 'POST', body: newMedicine({ min_stock: undefined }), jwt })).status, 400, 'min_stock wajib (REQ-MED-003)');
  assert.equal((await request('/api/medicines', { method: 'POST', body: newMedicine({ unit: 'Botol/Sirup' }), jwt })).status, 400, 'satuan harus dari daftar tetap');
  assert.equal((await request('/api/medicines', { method: 'POST', body: newMedicine({ category: 'Tidak Ada' }), jwt })).status, 400);
  assert.equal((await request('/api/medicines', { method: 'POST', body: newMedicine({ price: -1 }), jwt })).status, 400);
  assert.equal(db.state.logs.length, 0, 'input ditolak tidak dicatat');

  const created = await request('/api/medicines', { method: 'POST', body: newMedicine({ category: 'Lambung', unit: 'Botol' }), jwt });
  assert.equal(created.status, 201);
  assert.equal(created.data.data.medicine_code, 'CPT25');
  assert.equal(created.data.data.category, 'Lambung', 'kategori lama dari database bisa dipilih');
  assert.deepEqual(db.state.logs.map(l => [l.user_id, l.action]), [[ID.kepala, 'medicine_create: code=CPT25']]);
});

test('duplicate medicine code is rejected with a specific message (REQ-MED-002)', async () => {
  const res = await request('/api/medicines', { method: 'POST', body: newMedicine({ medicine_code: 'amox500' }), jwt: token(ID.kepala) });
  assert.equal(res.status, 409);
  assert.equal(res.data.message, 'Kode obat sudah digunakan.');
  assert.equal(db.state.logs.length, 0);
});

test('deactivating keeps the record (soft delete) and is audited (REQ-MED-007)', async () => {
  const jwt = token(ID.kepala);
  const off = await request('/api/medicines/AMOX500/status', { method: 'PATCH', body: { is_active: false }, jwt });
  assert.equal(off.status, 200);
  assert.deepEqual(off.data.data, { medicine_code: 'AMOX500', is_active: false });
  assert.equal(db.state.medicines.find(m => m.medicine_code === 'AMOX500').status, 'nonaktif');
  assert.equal(db.state.batches.filter(b => b.medicine_code === 'AMOX500').length, 2, 'batch tidak dihapus');
  await request('/api/medicines/AMOX500/status', { method: 'PATCH', body: { is_active: true }, jwt });
  assert.deepEqual(db.state.logs.map(l => l.action), ['medicine_status: code=AMOX500 status=nonaktif', 'medicine_status: code=AMOX500 status=aktif']);
  assert.equal((await request('/api/medicines/AMOX500/status', { method: 'PATCH', body: { is_active: 'no' }, jwt })).status, 400);
  assert.equal((await request('/api/medicines/GHOST/status', { method: 'PATCH', body: { is_active: false }, jwt })).status, 404);
  assert.equal(db.state.logs.length, 2, 'permintaan gagal tidak dicatat');
});
