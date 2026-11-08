// Pengujian HTTP terisolasi modul Laporan: valuasi aset, kartu stok/mutasi, dan
// alur stock opname (buat -> input fisik -> ajukan -> approve/reject) termasuk
// eksekusi penyesuaian stok. Memakai in-memory DB adapter — tidak menyentuh Neon.
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
    { medicine_code: 'MED-A', name: 'Amoxicillin', category: 'Antibiotik', unit: 'Kapsul', price: 1000, min_stock: 100, status: 'aktif' },
    { medicine_code: 'MED-B', name: 'Betadine', category: 'Antiseptik', unit: 'Botol', price: 2000, min_stock: 50, status: 'aktif' },
    { medicine_code: 'MED-C', name: 'Cefixime', category: 'Antibiotik', unit: 'Kapsul', price: 3000, min_stock: 10, status: 'aktif' },
    { medicine_code: 'MED-D', name: 'Obat Lama', category: 'Lain', unit: 'Tablet', price: 500, min_stock: 1, status: 'nonaktif' },
    { medicine_code: 'MED-E', name: 'Ranitidine', category: 'Lambung', unit: 'Ampul', price: 5000, min_stock: 5, status: 'aktif' }
  ];
  db.state.batches = [
    { batch_number: 'B-A1', medicine_code: 'MED-A', current_qty: 150, expired_date: '2026-10-01', supplier: 'PBF Satu' },
    { batch_number: 'B-B1', medicine_code: 'MED-B', current_qty: 40, expired_date: '2026-11-20', supplier: 'PBF Dua' },
    { batch_number: 'B-C1', medicine_code: 'MED-C', current_qty: 5, expired_date: '2026-09-10', supplier: 'PBF Tiga' }, // FEFO lebih dulu
    { batch_number: 'B-C2', medicine_code: 'MED-C', current_qty: 3, expired_date: '2027-06-01', supplier: 'PBF Tiga' }
  ];
  db.state.transactions = [
    { transaction_id: 1, medicine_code: 'MED-A', batch_number: 'B-A1', user_id: 2, transaction_type: 'IN', quantity: 100, reference_number: 'FAK-1', transaction_date: '2026-09-01', created_at: '2026-09-01T01:00:00Z' },
    { transaction_id: 2, medicine_code: 'MED-A', batch_number: 'B-A1', user_id: 3, transaction_type: 'OUT', quantity: 30, reference_number: 'RES-1', transaction_date: '2026-09-05', created_at: '2026-09-05T01:00:00Z' },
    { transaction_id: 3, medicine_code: 'MED-A', batch_number: 'B-A1', user_id: 2, transaction_type: 'IN', quantity: 80, reference_number: 'FAK-2', transaction_date: '2026-09-10', created_at: '2026-09-10T01:00:00Z' }
  ];
  db.state.opname = []; db.state.opnameItems = []; db.state.logs = [];
  db.state.seq = { opname: 0, item: 0, tx: 3, log: 0 };
});

function token(id) { return auth.createJwtToken(db.state.users.find(u => u.user_id === id)); }
async function request(path, { method = 'GET', body, jwt, headers = {} } = {}) {
  const response = await fetch(origin + path, { method, redirect: 'manual',
    headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(jwt ? { Cookie: 'token=' + jwt } : {}), ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}
// Isi fisik semua item sesi (default sama dengan sistem = tanpa selisih), lalu override.
async function fillAndSubmit(opnameId, overrides = {}) {
  const detail = (await request('/api/laporan/opname/' + opnameId, { jwt: token(ID.gudang) })).data.data;
  const items = detail.items.map(i => ({
    medicine_code: i.medicine_code,
    physical_qty: overrides[i.medicine_code] !== undefined ? overrides[i.medicine_code].qty : i.system_qty,
    note: overrides[i.medicine_code] !== undefined ? overrides[i.medicine_code].note : undefined
  }));
  await request('/api/laporan/opname/' + opnameId + '/items', { jwt: token(ID.gudang), method: 'PATCH', body: { items } });
  return request('/api/laporan/opname/' + opnameId + '/submit', { jwt: token(ID.gudang), method: 'POST' });
}

test('laporan endpoints require authentication', async () => {
  assert.equal((await request('/api/laporan/valuation')).status, 401);
  assert.equal((await request('/api/laporan/opname')).status, 401);
});

test('valuation sums active stock value and excludes inactive medicines', async () => {
  const data = (await request('/api/laporan/valuation', { jwt: token(ID.kepala) })).data.data;
  assert.equal(data.item_count, 4);                                  // A, B, C, E (D nonaktif)
  assert.deepEqual(data.items.map(i => i.medicine_code), ['MED-A', 'MED-B', 'MED-C', 'MED-E']); // urut nama
  assert.equal(data.items[0].total_value, 150000);                  // 150 * 1000
  assert.equal(data.items[2].total_value, 24000);                   // (5+3) * 3000
  assert.equal(data.grand_total, 150000 + 80000 + 24000 + 0);
});

test('stock card builds running balance and honours the period filter', async () => {
  const all = (await request('/api/laporan/stock-card?medicine_code=MED-A', { jwt: token(ID.pelayanan) })).data.data;
  assert.equal(all.entries.length, 3);
  assert.deepEqual(all.entries.map(e => e.closing_balance), [100, 70, 150]);
  assert.equal(all.final_balance, 150);
  const windowed = (await request('/api/laporan/stock-card?medicine_code=MED-A&from=2026-09-04&to=2026-09-30', { jwt: token(ID.pelayanan) })).data.data;
  assert.equal(windowed.entries.length, 2);                         // tx 2026-09-01 di luar jendela
  assert.equal(windowed.final_balance, 50);                         // -30 + 80
  assert.equal((await request('/api/laporan/stock-card?medicine_code=GHOST', { jwt: token(ID.pelayanan) })).status, 404);
  assert.equal((await request('/api/laporan/stock-card?medicine_code=MED-A&from=bad', { jwt: token(ID.pelayanan) })).status, 400);
});

test('creating an opname seeds frozen system balances; Admin IT is denied', async () => {
  assert.equal((await request('/api/laporan/opname', { jwt: token(ID.admin), method: 'POST' })).status, 403);
  const created = await request('/api/laporan/opname', { jwt: token(ID.gudang), method: 'POST', body: { reference_number: 'OPN-SEP' } });
  assert.equal(created.status, 201);
  assert.equal(created.data.data.item_count, 4);
  const detail = (await request('/api/laporan/opname/' + created.data.data.opname_id, { jwt: token(ID.gudang) })).data.data;
  assert.equal(detail.status, 'draft');
  assert.equal(detail.items.find(i => i.medicine_code === 'MED-C').system_qty, 8);
  assert.equal(detail.items.find(i => i.medicine_code === 'MED-C').audit_status, 'belum_dihitung');
});

test('physical input requires a note when there is a discrepancy', async () => {
  const id = (await request('/api/laporan/opname', { jwt: token(ID.gudang), method: 'POST' })).data.data.opname_id;
  const noNote = await request('/api/laporan/opname/' + id + '/items', { jwt: token(ID.gudang), method: 'PATCH', body: { items: [{ medicine_code: 'MED-B', physical_qty: 35 }] } });
  assert.equal(noNote.status, 400);
  const withNote = await request('/api/laporan/opname/' + id + '/items', { jwt: token(ID.gudang), method: 'PATCH', body: { items: [{ medicine_code: 'MED-B', physical_qty: 35, note: 'rusak 5' }] } });
  assert.equal(withNote.status, 200);
  const detail = (await request('/api/laporan/opname/' + id, { jwt: token(ID.gudang) })).data.data;
  const row = detail.items.find(i => i.medicine_code === 'MED-B');
  assert.equal(row.difference_qty, -5);
  assert.equal(row.difference_value, -10000);                        // -5 * 2000
  assert.equal(row.audit_status, 'selisih_minor');
});

test('cannot submit until every item has a physical count', async () => {
  const id = (await request('/api/laporan/opname', { jwt: token(ID.gudang), method: 'POST' })).data.data.opname_id;
  await request('/api/laporan/opname/' + id + '/items', { jwt: token(ID.gudang), method: 'PATCH', body: { items: [{ medicine_code: 'MED-A', physical_qty: 150 }] } });
  assert.equal((await request('/api/laporan/opname/' + id + '/submit', { jwt: token(ID.gudang), method: 'POST' })).status, 400);
});

test('approval is Kepala-Farmasi-only and executes FEFO stock adjustments', async () => {
  const id = (await request('/api/laporan/opname', { jwt: token(ID.gudang), method: 'POST' })).data.data.opname_id;
  // MED-B +10 (tambah ke batch kedaluwarsa terjauh), MED-C -2 (kurangi FEFO)
  const submitted = await fillAndSubmit(id, { 'MED-B': { qty: 50, note: 'temuan lebih' }, 'MED-C': { qty: 6, note: 'hilang 2' } });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.data.data.status, 'pending_approval');

  assert.equal((await request('/api/laporan/opname/' + id + '/approve', { jwt: token(ID.gudang), method: 'POST' })).status, 403);
  const approved = await request('/api/laporan/opname/' + id + '/approve', { jwt: token(ID.kepala), method: 'POST', body: { note: 'disetujui' } });
  assert.equal(approved.status, 200);
  assert.equal(approved.data.data.adjusted, 2);

  // Stok batch tersesuaikan
  assert.equal(db.state.batches.find(b => b.batch_number === 'B-B1').current_qty, 50);  // 40 + 10
  assert.equal(db.state.batches.find(b => b.batch_number === 'B-C1').current_qty, 3);   // 5 - 2 (FEFO batch terdekat)
  assert.equal(db.state.batches.find(b => b.batch_number === 'B-C2').current_qty, 3);   // tak tersentuh
  // Transaksi ADJUSTMENT bertanda tercatat
  const adj = db.state.transactions.filter(t => t.transaction_type === 'ADJUSTMENT');
  assert.equal(adj.length, 2);
  assert.ok(adj.every(t => t.reference_number === 'OPNAME-' + id));
  assert.equal(adj.find(t => t.medicine_code === 'MED-B').quantity, 10);
  assert.equal(adj.find(t => t.medicine_code === 'MED-C').quantity, -2);
  // Idempoten: sesi sudah approved tak bisa disetujui ulang
  assert.equal((await request('/api/laporan/opname/' + id + '/approve', { jwt: token(ID.kepala), method: 'POST' })).status, 409);
});

test('rejecting a submitted opname leaves stock untouched', async () => {
  const id = (await request('/api/laporan/opname', { jwt: token(ID.gudang), method: 'POST' })).data.data.opname_id;
  await fillAndSubmit(id, { 'MED-B': { qty: 100, note: 'selisih besar' } });
  assert.equal((await request('/api/laporan/opname/' + id + '/reject', { jwt: token(ID.pelayanan), method: 'POST' })).status, 403);
  const rejected = await request('/api/laporan/opname/' + id + '/reject', { jwt: token(ID.kepala), method: 'POST', body: { note: 'perlu hitung ulang' } });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.data.data.status, 'rejected');
  assert.equal(db.state.batches.find(b => b.batch_number === 'B-B1').current_qty, 40); // tidak berubah
  assert.equal(db.state.transactions.filter(t => t.transaction_type === 'ADJUSTMENT').length, 0);
});

test('operational can cancel draft/pending session; admin denied; approved cannot be cancelled', async () => {
  // Batalkan sesi draft
  const draft = (await request('/api/laporan/opname', { jwt: token(ID.gudang), method: 'POST' })).data.data.opname_id;
  assert.equal((await request('/api/laporan/opname/' + draft + '/cancel', { jwt: token(ID.admin), method: 'POST' })).status, 403);
  assert.equal((await request('/api/laporan/opname/' + draft + '/cancel', { jwt: token(ID.pelayanan), method: 'POST' })).status, 200);
  assert.equal((await request('/api/laporan/opname/' + draft, { jwt: token(ID.gudang) })).status, 404); // terhapus
  // Batalkan sesi yang sudah diajukan (pending_approval)
  const pending = (await request('/api/laporan/opname', { jwt: token(ID.gudang), method: 'POST' })).data.data.opname_id;
  await fillAndSubmit(pending);
  assert.equal((await request('/api/laporan/opname/' + pending + '/cancel', { jwt: token(ID.gudang), method: 'POST' })).status, 200);
  // Sesi yang sudah disetujui tidak bisa dibatalkan
  const approved = (await request('/api/laporan/opname', { jwt: token(ID.gudang), method: 'POST' })).data.data.opname_id;
  await fillAndSubmit(approved);
  await request('/api/laporan/opname/' + approved + '/approve', { jwt: token(ID.kepala), method: 'POST' });
  assert.equal((await request('/api/laporan/opname/' + approved + '/cancel', { jwt: token(ID.gudang), method: 'POST' })).status, 409);
});

test('draft cannot be approved before submission', async () => {
  const id = (await request('/api/laporan/opname', { jwt: token(ID.gudang), method: 'POST' })).data.data.opname_id;
  assert.equal((await request('/api/laporan/opname/' + id + '/approve', { jwt: token(ID.kepala), method: 'POST' })).status, 409);
});
