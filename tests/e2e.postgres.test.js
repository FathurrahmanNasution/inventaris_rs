// Uji integrasi end-to-end lintas modul pada PostgreSQL lokal sungguhan (tidak pernah Neon / DATABASE_URL).
// Alur: Admin membuat akun (pengganti Sign Up) -> login per peran -> Kepala Farmasi tambah obat
// -> Gudang stok masuk -> Data Obat/Monitoring/Dashboard/Laporan membaca stok yang sama
// -> Pelayanan stok keluar FEFO -> nonaktif obat & akun.
// Menjalankan query modul Data Obat, Laporan, Monitoring, dan Dashboard di PostgreSQL asli
// (tes lain untuk modul itu memakai adapter in-memory). Tiap run memakai schema baru lalu dihapus.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const url = process.env.E2E_TEST_DATABASE_URL;
if (!url) {
  test('PostgreSQL end-to-end integration (set E2E_TEST_DATABASE_URL to a dedicated local e2e_inventory_test DB)', { skip: true }, () => {});
} else {
  const target = new URL(url);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.pathname !== '/e2e_inventory_test' || target.search)
    throw new Error('E2E tests require a local database named e2e_inventory_test, without URL query options.');
  const { Pool } = require('pg');
  const bcrypt = require('bcryptjs');
  const { randomUUID } = require('node:crypto');
  const schema = 'e2e_test_' + randomUUID().replaceAll('-', '');
  const bootstrap = new Pool({ connectionString: url, ssl: false });
  const pool = new Pool({ connectionString: url, ssl: false, options: '-c search_path=' + schema + ' -c timezone=Asia/Jakarta', max: 8 });
  const dbPath = require.resolve('../src/config/db');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool, query: (sql, params) => pool.query(sql, params) } };
  process.env.JWT_SECRET = 'e2e-integration-local-tests-only-secret-123456789';
  process.env.NODE_ENV = 'test';
  delete process.env.APP_ORIGIN;
  const sqlFile = file => readFileSync(path.join(__dirname, '..', file), 'utf8');

  const PW = { admin: 'AdminE2e123', kepala_farmasi: 'KepalaE2e123', gudang: 'GudangE2e123', pelayanan: 'LayanE2e123' };
  let server, origin, today, day;
  const jar = {};

  async function call(who, path, { method = 'GET', body } = {}) {
    const res = await fetch(origin + path, { method, redirect: 'manual',
      headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(jar[who] ? { Cookie: jar[who] } : {}) },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  async function login(who, username, password, remember) {
    const res = await call(who, '/api/auth/login', { method: 'POST', body: { username, password, remember } });
    if (res.status === 200) jar[who] = res.headers.get('set-cookie').split(';')[0];
    return res;
  }

  before(async () => {
    await bootstrap.query('CREATE SCHEMA ' + schema);
    await pool.query(sqlFile('tests/fixtures/stock-schema.sql'));
    await pool.query(sqlFile('migrations/001_stock_documents.sql'));
    await pool.query("INSERT INTO users (username, password_hash, role) VALUES ('e2e_admin', $1, 'admin')", [await bcrypt.hash(PW.admin, 10)]);
    today = (await pool.query("SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date::text AS d")).rows[0].d;
    day = n => new Date(Date.parse(today) + n * 864e5).toISOString().slice(0, 10);
    const app = require('../server');
    server = app.listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  after(async () => {
    server?.closeAllConnections(); await new Promise(r => server ? server.close(r) : r());
    await pool.end(); await bootstrap.query('DROP SCHEMA ' + schema + ' CASCADE'); await bootstrap.end();
  });

  test('1. Login & "Sign Up" via Admin: halaman publik, registrasi tertutup, Admin membuat akun tiap peran', async () => {
    assert.equal((await call('anon', '/login')).status, 200);
    assert.equal((await call('anon', '/register')).headers.get('location'), '/login');
    assert.equal((await call('anon', '/api/auth/register', { method: 'POST', body: { username: 'x', password: 'Abcdef123' } })).status, 404);
    assert.equal((await call('anon', '/dashboard')).headers.get('location'), '/login');

    const bad = await login('admin', 'e2e_admin', 'salah-sandi');
    assert.equal(bad.status, 401); assert.equal(bad.data.message, 'Username atau kata sandi tidak valid.');
    const ok = await login('admin', 'E2E_Admin', PW.admin, false);
    assert.equal(ok.status, 200); assert.equal(ok.data.data.user.role, 'admin');
    assert.doesNotMatch(ok.headers.get('set-cookie'), /Max-Age/, 'tanpa "Ingat saya" = cookie sesi');

    for (const role of ['kepala_farmasi', 'gudang', 'pelayanan']) {
      const res = await call('admin', '/api/users', { method: 'POST', body: { username: 'e2e_' + role, password: PW[role], confirmPassword: PW[role], role } });
      assert.equal(res.status, 201, role + ': ' + JSON.stringify(res.data));
    }
    assert.equal((await call('admin', '/api/users', { method: 'POST', body: { username: 'e2e_gudang', password: 'Lainnya123', role: 'gudang' } })).status, 409);
    assert.equal((await call('admin', '/api/users', { method: 'POST', body: { username: 'e2e_lemah', password: 'pendek', role: 'gudang' } })).status, 400);

    for (const role of ['kepala_farmasi', 'gudang', 'pelayanan']) {
      const res = await login(role, 'e2e_' + role, PW[role], true);
      assert.equal(res.status, 200); assert.match(res.headers.get('set-cookie'), /Max-Age=28800/);
      assert.equal((await call(role, '/api/auth/me')).data.data.user.role, role);
      assert.equal((await call(role, '/api/users', { method: 'POST', body: { username: 'e2e_x', password: 'Abcdef123', role: 'admin' } })).status, 403, 'hanya Admin buat akun');
    }
    const audit = (await pool.query('SELECT action FROM audit_logs ORDER BY log_id')).rows.map(r => r.action);
    assert.ok(audit.includes('login_success') && audit.some(a => a.startsWith('login_failed')) && audit.filter(a => a.startsWith('create_user')).length === 3);
  });

  test('2. Data Obat: hanya Kepala Farmasi menambah obat; obat baru muncul di katalog & lookup stok', async () => {
    const med = { medicine_code: 'e2eamx', name: 'Amoxicillin E2E 500mg', category: 'Antibiotik', unit: 'Kapsul', min_stock: 100, price: 1200 };
    for (const role of ['admin', 'gudang', 'pelayanan']) assert.equal((await call(role, '/api/medicines', { method: 'POST', body: med })).status, 403);
    const created = await call('kepala_farmasi', '/api/medicines', { method: 'POST', body: med });
    assert.equal(created.status, 201); assert.equal(created.data.data.medicine_code, 'E2EAMX');
    assert.equal((await call('kepala_farmasi', '/api/medicines', { method: 'POST', body: med })).status, 409);
    assert.equal((await call('kepala_farmasi', '/api/medicines', { method: 'POST', body: { ...med, medicine_code: 'E2E2', min_stock: '' } })).status, 400);
    assert.equal((await call('kepala_farmasi', '/api/medicines', { method: 'POST', body: { medicine_code: 'E2EPCT', name: 'Paracetamol E2E', category: 'Analgesik', unit: 'Tablet', min_stock: 10, price: 300 } })).status, 201);

    const list = (await call('pelayanan', '/api/medicines?search=e2e&limit=20')).data.data;
    assert.equal(list.total, 2);
    const amx = list.data.find(m => m.medicine_code === 'E2EAMX');
    assert.deepEqual([amx.total_stock, amx.days, amx.is_active], [0, null, true]);
    assert.deepEqual((await call('gudang', '/api/medicines?filter=kritis')).data.data.data.map(m => m.medicine_code).sort(), ['E2EAMX', 'E2EPCT']);
    const cats = (await call('gudang', '/api/categories')).data.data.map(c => c.name);
    assert.ok(cats.includes('Antibiotik') && cats.at(-1) === 'Lainnya');
    assert.ok((await call('gudang', '/api/stock/medicines?limit=500')).data.data.data.some(m => m.medicine_code === 'E2EAMX'));
  });

  test('3. Stok Masuk: Gudang mencatat 2 batch; RBAC, validasi kedaluwarsa & batch unik', async () => {
    const receipt = (ref, batch, exp, qty) => ({ reference_number: ref, received_date: today, supplier: 'PBF E2E', notes: 'uji e2e',
      items: [{ medicine_code: 'E2EAMX', batch_number: batch, expired_date: exp, quantity: qty, unit_price: '1200' }] });
    assert.equal((await call('pelayanan', '/api/stock/in', { method: 'POST', body: receipt('PO-X', 'B-X', day(100), 5) })).status, 403);
    assert.equal((await call('admin', '/api/stock/in', { method: 'POST', body: receipt('PO-X', 'B-X', day(100), 5) })).status, 403);
    assert.equal((await call('gudang', '/api/stock/in', { method: 'POST', body: receipt('PO-X', 'B-X', today, 5) })).status, 400, 'REQ-STK-002');

    const near = await call('gudang', '/api/stock/in', { method: 'POST', body: receipt('PO-E2E-1', 'E2E-B1', day(20), 80) });
    assert.equal(near.status, 201, JSON.stringify(near.data));
    assert.equal((await call('kepala_farmasi', '/api/stock/in', { method: 'POST', body: receipt('PO-E2E-2', 'E2E-B2', day(200), 120) })).status, 201);
    assert.equal((await call('gudang', '/api/stock/in', { method: 'POST', body: receipt('PO-E2E-3', 'E2E-B1', day(300), 1) })).status, 409, 'REQ-STK-001 batch unik');
    const doc = await call('pelayanan', '/api/stock/documents/' + near.data.data.document_id);
    assert.equal(doc.status, 200); assert.equal(doc.data.data.items[0].batch_number, 'E2E-B1');

    const fefo = (await call('pelayanan', '/api/stock/medicines/E2EAMX/batches')).data.data;
    assert.deepEqual(fefo.map(b => [b.batch_number, Number(b.current_qty)]), [['E2E-B1', 80], ['E2E-B2', 120]]);
  });

  test('4. Integrasi baca: Data Obat, Monitoring, Dashboard, Laporan membaca stok yang sama', async () => {
    const amx = (await call('gudang', '/api/medicines?search=E2EAMX')).data.data.data[0];
    assert.deepEqual([amx.total_stock, amx.days], [200, 20]);
    assert.deepEqual((await call('gudang', '/api/medicines?filter=expiring')).data.data.data.map(m => m.medicine_code), ['E2EAMX']);
    assert.deepEqual((await call('gudang', '/api/medicines?filter=aman')).data.data.data.map(m => m.medicine_code), ['E2EAMX']);
    const expiry = (await call('pelayanan', '/api/monitoring/expiry?filter=all')).data.data;
    assert.ok(JSON.stringify(expiry).includes('E2E-B1'), 'batch 20 hari muncul di alert');
    const low = (await call('pelayanan', '/api/monitoring/low-stock')).data.data;
    assert.ok(JSON.stringify(low).includes('E2EPCT') && !JSON.stringify(low).includes('E2EAMX'));
    const dash = await call('kepala_farmasi', '/api/dashboard');
    assert.equal(dash.status, 200, JSON.stringify(dash.data));
    const val = (await call('kepala_farmasi', '/api/laporan/valuation')).data.data;
    const vAmx = val.items.find(i => i.medicine_code === 'E2EAMX');
    assert.equal(Number(vAmx.total_stock), 200); assert.equal(Number(vAmx.total_value), 240000);
  });

  test('5. Stok Keluar FEFO: Pelayanan mengambil lintas batch, stok tidak bisa negatif, kartu stok berjalan', async () => {
    const out = body => call('pelayanan', '/api/stock/out', { method: 'POST', body });
    assert.equal((await call('gudang', '/api/stock/out', { method: 'POST', body: { reference_number: 'R', destination: 'IGD', items: [{ medicine_code: 'E2EAMX', quantity: 1 }] } })).status, 403);
    const tooMuch = await out({ reference_number: 'RSP-E2E-0', destination: 'IGD', items: [{ medicine_code: 'E2EAMX', quantity: 201 }] });
    assert.ok(tooMuch.status >= 400 && tooMuch.status < 500, 'REQ-STK-004');
    const res = await out({ reference_number: 'RSP-E2E-1', destination: 'Rawat Inap', items: [{ medicine_code: 'E2EAMX', quantity: 100 }] });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    const left = (await call('pelayanan', '/api/stock/medicines/E2EAMX/batches')).data.data;
    assert.deepEqual(left.map(b => [b.batch_number, Number(b.current_qty)]), [['E2E-B2', 100]], 'B1 (exp terdekat) habis lebih dulu');
    const tx = (await pool.query("SELECT batch_number, quantity FROM stock_transactions WHERE transaction_type='OUT' ORDER BY transaction_id")).rows;
    assert.deepEqual(tx.map(t => [t.batch_number, t.quantity]), [['E2E-B1', 80], ['E2E-B2', 20]]);

    const amx = (await call('gudang', '/api/medicines?search=E2EAMX')).data.data.data[0];
    assert.deepEqual([amx.total_stock, amx.days], [100, 200]);
    const card = (await call('gudang', '/api/laporan/stock-card?medicine_code=E2EAMX')).data.data;
    assert.equal(card.opening_balance, 0); assert.equal(card.final_balance, 100);
    assert.deepEqual(card.entries.map(e => e.closing_balance), [80, 200, 120, 100]);
    const cardPeriod = (await call('gudang', '/api/laporan/stock-card?medicine_code=E2EAMX&from=' + day(1))).data.data;
    assert.equal(cardPeriod.opening_balance, 100); assert.equal(cardPeriod.entries.length, 0);
    const hist = await call('gudang', '/api/stock/history?medicine_code=E2EAMX');
    assert.equal(hist.status, 200); assert.equal(hist.data.data.final_balance, 100);
    assert.equal((await call('gudang', '/api/stock/history')).status, 400, 'medicine_code wajib');
  });

  test('6. Nonaktif obat & akun: obat hilang dari lookup stok, sesi akun nonaktif ditolak, halaman RBAC', async () => {
    assert.equal((await call('gudang', '/api/medicines/E2EPCT/status', { method: 'PATCH', body: { is_active: false } })).status, 403);
    assert.equal((await call('kepala_farmasi', '/api/medicines/E2EPCT/status', { method: 'PATCH', body: { is_active: false } })).status, 200);
    assert.ok(!(await call('gudang', '/api/stock/medicines?limit=500')).data.data.data.some(m => m.medicine_code === 'E2EPCT'));
    const blocked = await call('gudang', '/api/stock/in', { method: 'POST', body: { reference_number: 'PO-N', received_date: today, supplier: 'PBF',
      items: [{ medicine_code: 'E2EPCT', batch_number: 'E2E-N1', expired_date: day(90), quantity: 5, unit_price: '1' }] } });
    assert.ok(blocked.status >= 400 && blocked.status < 500, 'obat nonaktif tidak boleh diterima');
    assert.equal((await pool.query("SELECT 1 FROM medicines WHERE medicine_code='E2EPCT'")).rowCount, 1, 'soft delete');

    assert.equal((await call('pelayanan', '/stok-masuk')).status, 403);
    assert.equal((await call('gudang', '/stok-keluar')).status, 403);
    for (const page of ['/data-obat', '/laporan', '/monitoring', '/dashboard']) assert.equal((await call('gudang', page)).status, 200, page);

    const gudangId = (await pool.query("SELECT user_id FROM users WHERE username='e2e_gudang'")).rows[0].user_id;
    assert.equal((await call('admin', '/api/users/' + gudangId, { method: 'PATCH', body: { username: 'e2e_gudang', role: 'gudang', status: 'nonaktif' } })).status, 200);
    assert.equal((await call('gudang', '/api/auth/me')).status, 401, 'sesi lama langsung ditolak');
    assert.equal((await login('gudang2', 'e2e_gudang', PW.gudang)).status, 401);
    assert.equal((await call('pelayanan', '/api/auth/logout', { method: 'POST' })).status, 200);
    const actions = (await pool.query('SELECT action FROM audit_logs')).rows.map(r => r.action);
    for (const a of ['medicine_create', 'medicine_status', 'logout']) assert.ok(actions.some(x => x.startsWith(a)), a);
  });
}
