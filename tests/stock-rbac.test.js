// Full HTTP/auth/controller/service authorization checks against a private in-memory
// database adapter. No pg connection, migrations, Neon data or operational accounts.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'stock-rbac-isolated-test-secret-not-for-production-123456789';
process.env.NODE_ENV = 'test';
delete process.env.APP_ORIGIN;

let state, snapshot, connections, writes, server, origin, auth, service;
const copy = value => structuredClone(value);
async function query(sql, params = []) {
  const q = sql.replace(/\s+/g, ' ').trim();
  if (q === 'BEGIN') { snapshot = copy(state); return { rows: [] }; }
  if (q === 'ROLLBACK') { state = snapshot; return { rows: [] }; }
  if (q === 'COMMIT') return { rows: [] };
  if (q.includes('FROM users')) {
    const selected = q.includes('WHERE user_id = $1') ? state.users.filter(user => user.user_id === params[0]) : state.users;
    const rows = copy(selected);
    if (!q.includes('password_hash')) rows.forEach(user => delete user.password_hash);
    return { rows };
  }
  if (q.includes("AT TIME ZONE 'Asia/Jakarta'")) return { rows: [{ today: '2098-01-01' }] };
  if (q.includes('FROM medicines WHERE medicine_code = $1'))
    return { rows: params[0] === 'MED-RBAC' ? [{ medicine_code: 'MED-RBAC', name: 'Obat Uji', unit: 'Tablet', status: 'aktif' }] : [] };
  if (q.includes('FROM medicine_batches')) return { rows: copy(state.batches.filter(batch =>
    batch.medicine_code === params[0] && batch.current_qty > 0 && batch.expired_date > params[1])
    .sort((a, b) => a.expired_date.localeCompare(b.expired_date) || a.batch_number.localeCompare(b.batch_number))) };
  writes++;
  if (q.startsWith('INSERT INTO stock_documents')) {
    const document = { document_id: params[0], transaction_type: params[1], reference_number: params[2], transaction_date: params[3],
      supplier: params[4], destination: params[5], notes: params[6], user_id: params[7] };
    state.documents.push(document); return { rows: [copy(document)] };
  }
  if (q.startsWith('INSERT INTO medicine_batches')) {
    state.batches.push({ batch_number: params[0], medicine_code: params[1], current_qty: params[2], expired_date: params[3], supplier: params[4] });
    return { rows: [] };
  }
  if (q.startsWith('UPDATE medicine_batches')) {
    const batch = state.batches.find(batch => batch.batch_number === params[1] && batch.current_qty >= params[0]);
    if (!batch) return { rows: [] };
    batch.current_qty -= params[0]; return { rows: [{ current_qty: batch.current_qty }] };
  }
  if (q.startsWith('INSERT INTO stock_transactions')) {
    const tx = { transaction_id: state.transactions.length + 1, medicine_code: params[0], batch_number: params[1], user_id: params[2],
      transaction_type: params[3], quantity: params[4], reference_number: params[5], transaction_date: params[6], document_id: params[7], unit_price: params[8] };
    state.transactions.push(tx); return { rows: [copy(tx)] };
  }
  if (q.startsWith('INSERT INTO audit_logs')) {
    state.logs.push({ user_id: params[0], action: params[1], ip_address: params[2] }); return { rows: [] };
  }
  throw new Error('Unexpected isolated RBAC SQL: ' + q);
}
const dbPath = require.resolve('../src/config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  query, pool: { async connect() { connections++; return { query, release() {} }; } }
} };
before(async () => {
  auth = require('../src/services/authService');
  service = require('../src/services/stockService');
  server = require('../server').listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
});
beforeEach(() => {
  state = {
    users: ['admin', 'gudang', 'pelayanan', 'kepala_farmasi'].map((role, i) => ({
      user_id: i + 1, username: 'rbac_' + role, role, status: 'aktif', password_hash: 'isolated-hash-' + role, created_at: '2098-01-01'
    })),
    batches: [{ batch_number: 'SEED', medicine_code: 'MED-RBAC', current_qty: 20, expired_date: '2099-01-01', supplier: 'PBF Uji' }],
    documents: [], transactions: [], logs: []
  };
  snapshot = null; connections = 0; writes = 0;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
const token = (role, claimRole = role) => auth.createJwtToken({ ...state.users.find(user => user.role === role), role: claimRole });
async function request(url, { role, jwt, method = 'GET', body, accept = 'text/html', cookie = false } = {}) {
  const credential = jwt || (role && token(role));
  const result = await fetch(origin + url, { method, redirect: 'manual', headers: {
    Accept: accept, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    ...(credential ? cookie ? { Cookie: 'token=' + credential } : { Authorization: 'Bearer ' + credential } : {})
  }, body: method === 'POST' ? JSON.stringify(body || {}) : undefined });
  const raw = await result.text(); let data; try { data = JSON.parse(raw); } catch { data = raw; }
  return { status: result.status, data, headers: result.headers };
}
const payload = type => type === 'IN' ? {
  reference_number: 'FAK-RBAC', received_date: '2098-01-01', supplier: 'PBF Uji',
  items: [{ medicine_code: 'MED-RBAC', batch_number: 'NEW-RBAC', expired_date: '2099-01-01', quantity: 2, unit_price: '10.00' }]
} : { reference_number: 'RSP-RBAC', destination: 'IGD Uji', medicine_code: 'MED-RBAC', quantity: 3 };

// Expected permissions are explicit SRS assertions, independent of production ROLES.
for (const [role, allowIn, allowOut] of [
  ['admin', false, false], ['gudang', true, false], ['pelayanan', false, true], ['kepala_farmasi', true, true]
]) {
  for (const [type, path, allowed] of [['IN', 'masuk', allowIn], ['OUT', 'keluar', allowOut]]) {
    test(`${role}: GET /stok-${path} is ${allowed ? 'allowed' : 'forbidden'}`, async () => {
      const initial = copy(state);
      const result = await request('/stok-' + path, { role, cookie: true });
      assert.equal(result.status, allowed ? 200 : 403);
      if (allowed) assert.match(result.data, type === 'IN' ? /id="frm"/ : /id="outForm"/);
      else assert.equal(result.data.message, 'Peran Anda tidak diizinkan mengakses fitur ini.');
      assert.deepEqual(state, initial); assert.equal(connections, 0); assert.equal(writes, 0);
    });
    test(`${role}: POST /api/stock/${type.toLowerCase()} is ${allowed ? 'allowed' : 'forbidden'}`, async () => {
      const initial = copy(state);
      const result = await request('/api/stock/' + type.toLowerCase(), { role, method: 'POST', body: payload(type) });
      assert.equal(result.status, allowed ? 201 : 403);
      if (!allowed) {
        assert.equal(result.data.message, 'Peran Anda tidak diizinkan mengakses fitur ini.');
        assert.deepEqual(state, initial); assert.equal(connections, 0); assert.equal(writes, 0);
      } else {
        assert.equal(result.data.data.transaction_type, type);
        assert.equal(state.documents.length, 1); assert.equal(state.transactions.length, 1); assert.equal(state.logs.length, 1);
        assert.equal(state.logs[0].user_id, state.users.find(user => user.role === role).user_id);
        assert.match(state.logs[0].action, type === 'IN' ? /^stock_in:/ : /^stock_out:/);
        if (type === 'IN') assert.equal(state.batches.find(batch => batch.batch_number === 'NEW-RBAC').current_qty, 2);
        else assert.equal(state.batches[0].current_qty, 17);
      }
    });
  }
}
test('unauthenticated page requests redirect to login; JSON/API requests return 401 without writes', async () => {
  const initial = copy(state);
  for (const page of ['/stok-masuk', '/stok-keluar']) {
    const browser = await request(page); assert.equal(browser.status, 302); assert.equal(browser.headers.get('location'), '/login');
    assert.equal((await request(page, { accept: 'application/json' })).status, 401);
  }
  for (const type of ['IN', 'OUT']) assert.equal((await request('/api/stock/' + type.toLowerCase(), { method: 'POST', body: payload(type) })).status, 401);
  assert.deepEqual(state, initial); assert.equal(connections, 0); assert.equal(writes, 0);
});
test('session role values come from the database and stale JWT role claims cannot bypass either guard', async () => {
  for (const role of ['admin', 'gudang', 'pelayanan', 'kepala_farmasi'])
    assert.equal((await request('/api/auth/me', { role })).data.data.user.role, role);
  const stale = token('gudang', 'kepala_farmasi');
  assert.equal((await request('/api/auth/me', { jwt: stale })).data.data.user.role, 'gudang');
  assert.equal((await request('/stok-keluar', { jwt: stale })).status, 403);
  assert.equal((await request('/api/stock/out', { jwt: stale, method: 'POST', body: payload('OUT') })).status, 403);
  assert.equal(writes, 0); assert.equal(connections, 0);
});
test('unknown role aliases, inactive accounts and invalid tokens fail closed', async () => {
  const jwt = token('gudang');
  state.users[1].role = 'staf_gudang';
  for (const [url, method] of [['/stok-masuk', 'GET'], ['/stok-keluar', 'GET'], ['/api/stock/in', 'POST'], ['/api/stock/out', 'POST']])
    assert.equal((await request(url, { jwt, method, body: payload('IN') })).status, 403);
  state.users[1].status = 'nonaktif';
  for (const credential of [jwt, jwt + 'tampered']) {
    for (const [url, method] of [['/stok-masuk', 'GET'], ['/stok-keluar', 'GET'], ['/api/stock/in', 'POST'], ['/api/stock/out', 'POST']])
      assert.equal((await request(url, { jwt: credential, method, body: payload('IN'), accept: 'application/json' })).status, 401);
  }
  assert.equal(writes, 0); assert.equal(connections, 0);
});
test('service authorization independently rejects forbidden actors even without HTTP middleware', async () => {
  const initial = copy(state);
  for (const [type, roles] of [['IN', ['admin', 'pelayanan']], ['OUT', ['admin', 'gudang']]]) {
    for (const role of roles) {
      const actor = state.users.find(user => user.role === role);
      await assert.rejects(service[type === 'IN' ? 'stockIn' : 'stockOut'](payload(type), actor.user_id, '127.0.0.1'), { status: 403 });
    }
  }
  assert.deepEqual(state, initial); assert.equal(writes, 0);
});
test('Admin-only denial wording and operational account restrictions stay intact', async () => {
  const denied = await request('/api/users', { role: 'gudang' });
  assert.equal(denied.status, 403); assert.equal(denied.data.message, 'Akses khusus Administrator IT.');
  assert.equal((await request('/api/users', { role: 'admin' })).status, 200);
  assert.equal(writes, 0);
});
