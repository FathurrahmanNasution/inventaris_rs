// Isolated HTTP tests: replace the DB module before importing the app.
// No network/database connection or existing account is used or changed.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET = 'isolated-test-secret-not-for-use-outside-tests-123456789';
process.env.NODE_ENV = 'test';
delete process.env.APP_ORIGIN;
const bcrypt = require('bcryptjs');
let rows, logs, snapshot, failAudit = false, hash, app, server, origin, auth, nextId;
function copy(value) { return structuredClone(value); }
async function query(sql, params = []) {
  const q = sql.replace(/\s+/g, ' ').trim();
  if (q === 'BEGIN') { snapshot = { rows: copy(rows), logs: copy(logs) }; return { rows: [] }; }
  if (q === 'ROLLBACK') { rows = snapshot.rows; logs = snapshot.logs; return { rows: [] }; }
  if (q === 'COMMIT' || q.startsWith('LOCK TABLE')) return { rows: [] };
  if (q.startsWith('INSERT INTO audit_logs')) {
    if (failAudit) throw Object.assign(new Error('simulated failure'), { code: 'TEST_AUDIT_FAILURE' });
    assert.ok(params[1].length <= 100, 'audit action fits verified varchar(100)');
    logs.push({ log_id: logs.length + 1, user_id: params[0], action: params[1], ip_address: params[2], created_at: new Date().toISOString() });
    return { rows: [] };
  }
  if (q.startsWith('SELECT a.log_id')) {
    const pattern = params[0];
    const selected = [...logs].reverse().filter(l => !pattern || l.action.includes(pattern));
    return { rows: copy(selected.slice(params[2], params[2] + 51)) };
  }
  if (q.startsWith('SELECT') && q.includes('FROM users')) {
    let selected = rows;
    if (q.includes("WHERE role = 'admin'")) selected = rows.filter(u => u.role === 'admin' && u.status === 'aktif' && u.user_id !== params[0]);
    else if (q.includes('WHERE username = $1')) selected = rows.filter(u => u.username === params[0]);
    else if (q.includes('WHERE user_id = $1')) selected = rows.filter(u => u.user_id === params[0]);
    const result = copy(selected);
    if (!q.includes('password_hash')) result.forEach(u => delete u.password_hash);
    return { rows: result };
  }
  if (q.startsWith('INSERT INTO users')) {
    if (rows.some(u => u.username === params[0])) throw Object.assign(new Error('duplicate'), { code: '23505' });
    const u = { user_id: nextId++, username: params[0], password_hash: params[1], role: params[2], status: 'aktif', created_at: new Date().toISOString() };
    rows.push(u); const result = copy(u); delete result.password_hash;
    return { rows: [result] };
  }
  if (q.startsWith('UPDATE users SET username')) {
    if (rows.some(u => u.username === params[0] && u.user_id !== params[3])) throw Object.assign(new Error('duplicate'), { code: '23505' });
    const u = rows.find(u => u.user_id === params[3]);
    Object.assign(u, { username: params[0], role: params[1], status: params[2] });
    const result = copy(u); delete result.password_hash;
    return { rows: [result] };
  }
  if (q.startsWith('UPDATE users SET password_hash')) {
    rows.find(u => u.user_id === params[1]).password_hash = params[0]; return { rows: [] };
  }
  throw new Error('Unexpected test SQL: ' + q);
}
const dbPath = require.resolve('../src/config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true,
  exports: { query, pool: { connect: async () => ({ query, release() {} }) } } };
before(async () => {
  hash = await bcrypt.hash('Original123!', 4);
  auth = require('../src/services/authService');
  app = require('../server');
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
});
beforeEach(() => {
  rows = ['admin', 'gudang', 'pelayanan', 'kepala_farmasi'].map((role, i) => ({
    user_id: i + 1, username: 'test_' + role, password_hash: hash, role, status: 'aktif', created_at: '2026-10-30T00:00:00Z'
  }));
  logs = []; failAudit = false; nextId = 5;
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
function token(id = 1) { return auth.createJwtToken(rows.find(u => u.user_id === id)); }
async function request(path, { method = 'GET', body, jwt, headers = {} } = {}) {
  const response = await fetch(origin + path, { method, redirect: 'manual',
    headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(jwt ? { Cookie: 'token=' + jwt } : {}), ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, headers: response.headers };
}
test('anonymous Admin API is 401 and Admin page redirects to login', async () => {
  assert.equal((await request('/api/users')).status, 401);
  const result = await request('/admin');
  assert.equal(result.status, 302); assert.equal(result.headers.get('location'), '/login');
});
test('all non-Admin roles are denied user mutations, audit viewer and Admin HTML', async () => {
  for (const id of [2, 3, 4]) {
    const jwt = token(id);
    for (const url of ['/api/users', '/api/audit-logs', '/admin', '/admin/users'])
      assert.equal((await request(url, { jwt })).status, 403);
    for (const [url, method] of [['/api/users','POST'], ['/api/users/1','PATCH'], ['/api/users/1/reset-password','POST'], ['/api/auth/register','POST']])
      assert.equal((await request(url, { jwt, method })).status, 403);
  }
  assert.equal(logs.length, 0);
});
test('public registration cannot create an account of any role', async () => {
  const result = await request('/api/auth/register', { method: 'POST', body: { username: 'intruder', password: 'Intruder123', role: 'admin' } });
  assert.equal(result.status, 401); assert.equal(rows.length, 4);
});
test('Admin can read page, users, and audit logs without hashes', async () => {
  const jwt = token();
  assert.equal((await request('/admin', { jwt })).status, 200);
  const result = await request('/api/users', { jwt });
  assert.equal(result.status, 200); assert.equal(result.data.data.users.length, 4);
  assert.ok(!JSON.stringify(result.data).includes('password_hash'));
  assert.equal((await request('/api/audit-logs', { jwt })).status, 200);
});
test('create account normalizes username, hashes password and audits the actor', async () => {
  const result = await request('/api/users', { jwt: token(), method: 'POST', body: { username: 'New_Staff', password: 'StaffNew123', role: 'gudang' } });
  assert.equal(result.status, 201); assert.equal(result.data.data.user.username, 'new_staff');
  assert.equal(rows[4].status, 'aktif'); assert.ok(await bcrypt.compare('StaffNew123', rows[4].password_hash));
  assert.equal(logs[0].user_id, 1); assert.match(logs[0].action, /create_user: target=5/);
  assert.ok(!JSON.stringify(logs).includes('StaffNew123'));
});
test('duplicate and invalid account inputs do not mutate data', async () => {
  const jwt = token();
  assert.equal((await request('/api/users', { jwt, method: 'POST', body: { username: 'test_admin', password: 'StaffNew123', role: 'gudang' } })).status, 409);
  for (const body of [
    { username: {}, password: 'StaffNew123', role: 'gudang' },
    { username: 'new_staff', password: 'abcdefgh', role: 'gudang' },
    { username: 'new_staff', password: 'StaffNew123', role: 'superuser' },
    { username: 'new_staff', password: 'StaffNew123', confirmPassword: 'different', role: 'gudang' }
  ]) assert.equal((await request('/api/users', { jwt, method: 'POST', body })).status, 400);
  assert.equal(rows.length, 4); assert.equal(logs.length, 0);
});
test('Admin can edit username, role, deactivate and reactivate', async () => {
  const jwt = token(), staffToken = token(2);
  let result = await request('/api/users/2', { jwt, method: 'PATCH', body: { username: 'edited_staff', role: 'pelayanan', status: 'nonaktif' } });
  assert.equal(result.status, 200); assert.equal((await request('/api/auth/me', { jwt: staffToken })).status, 401);
  result = await request('/api/users/2', { jwt, method: 'PATCH', body: { username: 'edited_staff', role: 'pelayanan', status: 'aktif' } });
  assert.equal(result.status, 200); assert.equal(logs.length, 2);
});
test('current DB role overrides stale privileged JWT claims', async () => {
  const jwt = token(); rows[0].role = 'gudang';
  assert.equal((await request('/api/users', { jwt })).status, 403);
});
test('Admin cannot disable or demote their own account', async () => {
  const jwt = token();
  for (const body of [
    { username: 'test_admin', role: 'gudang', status: 'aktif' },
    { username: 'test_admin', role: 'admin', status: 'nonaktif' }
  ]) assert.equal((await request('/api/users/1', { jwt, method: 'PATCH', body })).status, 400);
  assert.equal(rows[0].role, 'admin'); assert.equal(rows[0].status, 'aktif');
});
test('unknown IDs and invalid status values fail without changes', async () => {
  const body = { username: 'renamed', role: 'gudang', status: 'aktif' }, jwt = token();
  assert.equal((await request('/api/users/999', { jwt, method: 'PATCH', body })).status, 404);
  assert.equal((await request('/api/users/nope', { jwt, method: 'PATCH', body })).status, 400);
  assert.equal((await request('/api/users/2', { jwt, method: 'PATCH', body: { ...body, status: 'deleted' } })).status, 400);
});
test('Admin password reset invalidates the target old session', async () => {
  const jwt = token(), old = token(2);
  assert.equal((await request('/api/users/2/reset-password', { jwt, method: 'POST', body: { newPassword: 'Replacement123' } })).status, 200);
  assert.equal((await request('/api/auth/me', { jwt: old })).status, 401);
  assert.ok(await bcrypt.compare('Replacement123', rows[1].password_hash));
  assert.equal(logs[0].action, 'reset_password: target=2');
  assert.equal((await request('/api/users/1/reset-password', { jwt, method: 'POST', body: { newPassword: 'Replacement123' } })).status, 400);
});
test('every authenticated role can change own password with old-password verification', async () => {
  for (const id of [1, 2, 3, 4]) {
    const jwt = token(id);
    const bad = await request('/api/auth/password', { jwt, method: 'PATCH', body: { oldPassword: 'wrong', newPassword: 'Replacement123' } });
    assert.equal(bad.status, 400);
    assert.equal((await request('/api/auth/password', { jwt, method: 'PATCH', body: { newPassword: 'Replacement123' } })).status, 400);
    const result = await request('/api/auth/password', { jwt, method: 'PATCH', body: { oldPassword: 'Original123!', newPassword: 'Replacement123' } });
    assert.equal(result.status, 200); assert.match(result.headers.get('set-cookie'), /Expires=/);
    assert.equal((await request('/api/auth/me', { jwt })).status, 401);
  }
});
test('audit insertion failure rolls back account changes and hides internal errors', async () => {
  failAudit = true;
  const result = await request('/api/users/2', { jwt: token(), method: 'PATCH', body: { username: 'changed', role: 'pelayanan', status: 'nonaktif' } });
  assert.equal(result.status, 500); assert.equal(rows[1].username, 'test_gudang');
  assert.ok(!JSON.stringify(result.data).includes('simulated')); assert.equal(logs.length, 0);
});
test('CSRF cross-origin and non-JSON writes are rejected', async () => {
  const jwt = token();
  assert.equal((await request('/api/users', { jwt, method: 'POST', headers: { Origin: 'https://foreign.example' } })).status, 403);
  assert.equal((await request('/api/users', { jwt, method: 'POST', headers: { 'Content-Type': 'text/plain' } })).status, 415);
});
test('audit filtering/pagination validates input and exposes no mutation endpoint', async () => {
  for (let i = 0; i < 55; i++) await auth.writeAuditLog(1, 'update_user: target=2', '127.0.0.1');
  const jwt = token(), first = await request('/api/audit-logs?search=update_user', { jwt });
  assert.equal(first.data.data.logs.length, 50); assert.equal(first.data.data.hasMore, true);
  const second = await request('/api/audit-logs?page=2', { jwt }); assert.equal(second.data.data.logs.length, 5);
  assert.equal((await request('/api/audit-logs?page=-1', { jwt })).status, 400);
  assert.equal((await request('/api/audit-logs/1', { jwt, method: 'DELETE' })).status, 404);
});
test('login sets HttpOnly cookie, audits login/logout, and fixes five-failure lockout', async () => {
  const success = await request('/api/auth/login', { method: 'POST', body: { username: 'test_admin', password: 'Original123!' } });
  assert.equal(success.status, 200); assert.match(success.headers.get('set-cookie'), /HttpOnly/);
  assert.equal(success.data.data.token, undefined);
  assert.equal((await request('/api/auth/logout', { jwt: token(), method: 'POST' })).status, 200);
  assert.deepEqual(logs.map(l => l.action), ['login_success', 'logout']);
  for (let i = 0; i < 5; i++) {
    const result = await request('/api/auth/login', { method: 'POST', body: { username: 'test_admin', password: 'wrong' } });
    assert.equal(result.status, 401);
  }
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { username: 'test_admin', password: 'Original123!' } })).status, 429);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { username: 'test_gudang', password: 'Original123!' } })).status, 429, 'IP limit applies across accounts');
});
test('JWT requires configured secret, caps lifetime and rejects old or forged tokens', async () => {
  const jwt = token(), claims = auth.verifyJwtToken(jwt);
  assert.equal(claims.exp - claims.iat, 28800);
  assert.equal((await request('/api/users', { jwt: jwt + 'tampered' })).status, 401);
  assert.equal(await auth.getSessionUser({ user_id: 1, role: 'admin' }), null);
  const secret = process.env.JWT_SECRET; delete process.env.JWT_SECRET;
  assert.throws(() => auth.createJwtToken(rows[0]), /JWT_SECRET/);
  process.env.JWT_SECRET = secret;
});
