// Real PostgreSQL verification of Admin behavior without applying the stock migration.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const url = process.env.ADMIN_TEST_DATABASE_URL;
if (!url) {
  test('PostgreSQL Admin integration (set ADMIN_TEST_DATABASE_URL to dedicated local admin_inventory_test)', { skip: true }, () => {});
} else {
  const target = new URL(url);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.pathname !== '/admin_inventory_test' || target.search)
    throw new Error('Admin tests require a local admin_inventory_test database without URL query options.');
  const { Pool } = require('pg');
  const bcrypt = require('bcryptjs');
  const schema = 'admin_test_' + randomUUID().replaceAll('-', '');
  const bootstrap = new Pool({ connectionString: url, ssl: false });
  const pool = new Pool({ connectionString: url, ssl: false, options: '-c search_path=' + schema, max: 10 });
  const query = (sql, params) => pool.query(sql, params);
  const dbPath = require.resolve('../src/config/db');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool, query } };
  process.env.JWT_SECRET = 'isolated-admin-postgres-test-secret-only-123456789';
  process.env.NODE_ENV = 'test';
  delete process.env.APP_ORIGIN;
  let server, origin, auth, userService, users, hash;
  before(async () => {
    await bootstrap.query('CREATE SCHEMA ' + schema);
    // Reuse the verified base-schema fixture as-is; NO stock_documents migration.
    await query(readFileSync(path.join(__dirname, 'fixtures/stock-schema.sql'), 'utf8'));
    hash = await bcrypt.hash('PgOriginal123!', 4);
    auth = require('../src/services/authService');
    userService = require('../src/services/userService');
    server = require('../server').listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    origin = 'http://127.0.0.1:' + server.address().port;
  });
  beforeEach(async () => {
    // This search_path contains only our new random schema, never public/shared tables.
    await query('TRUNCATE users, audit_logs RESTART IDENTITY CASCADE');
    users = [];
    for (const role of ['admin', 'gudang', 'pelayanan', 'kepala_farmasi'])
      users.push((await query('INSERT INTO users (username,password_hash,role) VALUES ($1,$2,$3) RETURNING *', ['pg_' + role, hash, role])).rows[0]);
  });
  after(async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await pool.end();
    if (!/^admin_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Unsafe test schema');
    await bootstrap.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await bootstrap.end();
  });
  const token = (id = 1) => auth.createJwtToken(users.find(user => user.user_id === id));
  async function request(route, { method = 'GET', body, jwt = token(), headers = {} } = {}) {
    const response = await fetch(origin + route, { method, redirect: 'manual',
      headers: { ...(jwt ? { Authorization: 'Bearer ' + jwt } : {}),
        ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await response.text(); let data; try { data = JSON.parse(raw); } catch { data = raw; }
    return { status: response.status, data, headers: response.headers };
  }
  const editBody = (changes = {}) => ({ username: 'pg_gudang', role: 'gudang', status: 'aktif', ...changes });
  const update = (body, id = 2, jwt = token()) => request('/api/users/' + id, { method: 'PATCH', body, jwt });
  const logs = async () => (await query('SELECT * FROM audit_logs ORDER BY log_id')).rows;
  const stored = async (id = 2) => (await query('SELECT * FROM users WHERE user_id=$1', [id])).rows[0];
  const assertPublic = user => assert.deepEqual(Object.keys(user).sort(), ['created_at', 'role', 'status', 'user_id', 'username']);

  test('Admin list and details return safe fields in stable ID order without a stock migration', async () => {
    assert.equal((await query("SELECT to_regclass('stock_documents') AS name")).rows[0].name, null);
    const result = await request('/api/users'); assert.equal(result.status, 200);
    assert.deepEqual(result.data.data.users.map(user => user.user_id), [1, 2, 3, 4]);
    result.data.data.users.forEach(assertPublic);
    const detail = await request('/api/users/2'); assert.equal(detail.status, 200);
    assertPublic(detail.data.data.user); assert.equal(detail.data.data.user.username, 'pg_gudang');
    assert.equal((await logs()).length, 0);
  });
  test('details reject invalid or absent IDs and allow inactive-account inspection', async () => {
    for (const id of ['0', '-1', '1.5', 'abc', '2147483648']) assert.equal((await request('/api/users/' + id)).status, 400);
    assert.equal((await request('/api/users/999')).status, 404);
    await query("UPDATE users SET status='nonaktif' WHERE user_id=2");
    assert.equal((await request('/api/users/2')).data.data.user.status, 'nonaktif');
  });
  test('Admin APIs reject anonymous and all operational roles, including Kepala Farmasi', async () => {
    for (const jwt of [null, token(2), token(3), token(4)]) {
      const expected = jwt ? 403 : 401;
      for (const route of ['/api/users', '/api/users/1', '/api/audit-logs']) assert.equal((await request(route, { jwt })).status, expected);
      for (const [route, method] of [['/api/users', 'POST'], ['/api/users/2', 'PATCH'], ['/api/users/2/reset-password', 'POST']])
        assert.equal((await request(route, { jwt, method, body: {} })).status, expected);
    }
    assert.equal((await logs()).length, 0);
  });
  test('profile update normalizes username and ignores restricted mass-assignment fields', async () => {
    const before = await stored();
    const r = await update(editBody({ username: '  Renamed_Staff  ', user_id: 99, password_hash: 'forged-hash', created_at: '1900-01-01', password: 'Ignored123' }));
    assert.equal(r.status, 200); assertPublic(r.data.data.user);
    const after = await stored(); assert.equal(after.username, 'renamed_staff');
    assert.equal(after.password_hash, before.password_hash); assert.equal(after.user_id, before.user_id);
    assert.equal(after.created_at.getTime(), before.created_at.getTime());
    assert.equal((await logs())[0].action, 'update_user: target=2 fields=username');
  });
  test('role updates accept exactly the four existing roles and stale JWT roles cannot escalate', async () => {
    const staffToken = token(2);
    for (const role of ['pelayanan', 'kepala_farmasi', 'admin', 'gudang']) {
      assert.equal((await update(editBody({ role }))).status, 200);
      assert.equal((await request('/api/auth/me', { jwt: staffToken })).data.data.user.role, role);
      assert.equal((await request('/api/users', { jwt: staffToken })).status, role === 'admin' ? 200 : 403);
    }
    const count = (await logs()).length;
    for (const role of ['superadmin', 'Administrator IT', '', null, ['admin']]) assert.equal((await update(editBody({ role }))).status, 400);
    assert.equal((await logs()).length, count);
  });
  test('deactivation rejects login and active sessions while preserving account and stock references', async () => {
    await query("INSERT INTO medicines (medicine_code,name,category,unit) VALUES ('REF','Obat','Uji','Tablet'); INSERT INTO medicine_batches VALUES ('REF-B','REF',1,'2099-01-01','PBF',CURRENT_TIMESTAMP); INSERT INTO stock_transactions (medicine_code,batch_number,user_id,transaction_type,quantity) VALUES ('REF','REF-B',2,'IN',1)");
    const oldToken = token(2);
    assert.equal((await update(editBody({ status: 'nonaktif' }))).status, 200);
    assert.equal((await request('/api/auth/me', { jwt: oldToken })).status, 401);
    const denied = await request('/api/auth/login', { method: 'POST', jwt: null, body: { username: 'pg_gudang', password: 'PgOriginal123!' } });
    assert.equal(denied.status, 401); assert.equal((await stored()).status, 'nonaktif');
    assert.equal((await query('SELECT user_id FROM stock_transactions')).rows[0].user_id, 2);
    assert.equal((await logs()).length, 2);
  });
  test('reactivation follows the existing credential/session policy', async () => {
    const oldToken = token(2);
    await update(editBody({ status: 'nonaktif' }));
    assert.equal((await update(editBody())).status, 200);
    assert.equal((await request('/api/auth/me', { jwt: oldToken })).status, 200);
    assert.deepEqual((await logs()).map(log => log.action), ['update_user: target=2 fields=status', 'update_user: target=2 fields=status']);
  });
  test('own role/status changes and last-admin lockout are blocked; own username remains editable', async () => {
    for (const changes of [{ role: 'gudang' }, { status: 'nonaktif' }])
      assert.equal((await update({ username: 'pg_admin', role: 'admin', status: 'aktif', ...changes }, 1)).status, 400);
    assert.equal((await logs()).length, 0);
    assert.equal((await update({ username: 'pg_admin_renamed', role: 'admin', status: 'aktif' }, 1)).status, 200);
    assert.equal((await query("SELECT COUNT(*) FROM users WHERE role='admin' AND status='aktif'")).rows[0].count, '1');
  });
  test('concurrent administrators cannot deactivate each other and remove all active admins', async () => {
    const second = (await query("INSERT INTO users (username,password_hash,role) VALUES ('pg_admin_two',$1,'admin') RETURNING *", [hash])).rows[0];
    users.push(second);
    const results = await Promise.all([
      update({ username: second.username, role: 'admin', status: 'nonaktif' }, second.user_id, token(1)),
      update({ username: 'pg_admin', role: 'admin', status: 'nonaktif' }, 1, token(second.user_id))
    ]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 401]);
    assert.equal((await query("SELECT COUNT(*) FROM users WHERE role='admin' AND status='aktif'")).rows[0].count, '1');
    assert.equal((await logs()).length, 1);
  });
  test('Admin password reset hashes the new value and invalidates all old target sessions', async () => {
    const first = token(2), second = token(2);
    const r = await request('/api/users/2/reset-password', { method: 'POST', body: { newPassword: 'PgReplacement123!' } });
    assert.equal(r.status, 200); assert.ok(await bcrypt.compare('PgReplacement123!', (await stored()).password_hash));
    for (const jwt of [first, second]) assert.equal((await request('/api/auth/me', { jwt })).status, 401);
    assert.equal((await request('/api/users/1/reset-password', { method: 'POST', body: { newPassword: 'PgReplacement123!' } })).status, 400);
    assert.equal((await request('/api/users/999/reset-password', { method: 'POST', body: { newPassword: 'PgReplacement123!' } })).status, 404);
    const login = await request('/api/auth/login', { method: 'POST', jwt: null, body: { username: 'pg_gudang', password: 'PgReplacement123!' } });
    assert.equal(login.status, 200);
    assert.ok(!(await logs()).some(log => log.action.includes('PgReplacement')));
  });
  test('all roles change their own password only after old-password verification', async () => {
    for (const user of users) {
      const jwt = token(user.user_id);
      assert.equal((await request('/api/auth/password', { method: 'PATCH', jwt, body: { oldPassword: 'wrong', newPassword: 'PgChanged123!' } })).status, 400);
      assert.equal((await stored(user.user_id)).password_hash, hash);
      const r = await request('/api/auth/password', { method: 'PATCH', jwt, body: { oldPassword: 'PgOriginal123!', newPassword: 'PgChanged123!', user_id: 999 } });
      assert.equal(r.status, 200); assert.match(r.headers.get('set-cookie'), /Expires=/);
      assert.ok(await bcrypt.compare('PgChanged123!', (await stored(user.user_id)).password_hash));
      assert.equal((await request('/api/auth/me', { jwt })).status, 401);
    }
    assert.equal((await logs()).length, 4);
  });
  test('password validation rejects weak or oversized values without any audit mutation', async () => {
    for (const newPassword of ['short1', 'abcdefgh', '12345678', 'A1' + 'é'.repeat(36), null, {}, 'A1' + 'x'.repeat(71)]) {
      assert.equal((await request('/api/users/2/reset-password', { method: 'POST', body: { newPassword } })).status, 400);
      assert.equal((await request('/api/auth/password', { method: 'PATCH', body: { oldPassword: 'PgOriginal123!', newPassword } })).status, 400);
    }
    assert.equal((await request('/api/auth/password', { method: 'PATCH', body: { newPassword: 'PgChanged123!' } })).status, 400);
    assert.equal((await logs()).length, 0); assert.equal((await stored()).password_hash, hash);
  });
  test('Add Account regression preserves normalization, confirmation, active status, bcrypt and audit', async () => {
    const r = await request('/api/users', { method: 'POST', body: { username: '  New_Pg_Staff ', role: 'pelayanan', password: 'PgNewAccount123!', confirmPassword: 'PgNewAccount123!' } });
    assert.equal(r.status, 201); assertPublic(r.data.data.user);
    const created = await stored(r.data.data.user.user_id);
    assert.equal(created.username, 'new_pg_staff'); assert.equal(created.status, 'aktif');
    assert.ok(await bcrypt.compare('PgNewAccount123!', created.password_hash));
    assert.match((await logs())[0].action, /^create_user: target=5 role=pelayanan$/);
    for (const body of [
      { username: 'new_pg_staff', password: 'PgNewAccount123!', role: 'gudang' },
      { username: 'other_pg_staff', password: 'PgNewAccount123!', confirmPassword: 'different', role: 'gudang' },
      { username: 'other_pg_staff', password: 'weak', role: 'gudang' }
    ]) assert.equal((await request('/api/users', { method: 'POST', body })).status, body.username === 'new_pg_staff' ? 409 : 400);
    assert.equal((await logs()).length, 1);
  });
  test('audit failure rolls back profile, role/status, reset, self-password and Add Account', async () => {
    await query("CREATE FUNCTION fail_admin_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated admin audit failure'; END $$; CREATE TRIGGER fail_admin_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_admin_audit()");
    try {
      const results = [
        await update(editBody({ username: 'rolled_back', role: 'pelayanan', status: 'nonaktif' })),
        await request('/api/users/2/reset-password', { method: 'POST', body: { newPassword: 'PgChanged123!' } }),
        await request('/api/auth/password', { method: 'PATCH', jwt: token(3), body: { oldPassword: 'PgOriginal123!', newPassword: 'PgChanged123!' } }),
        await request('/api/users', { method: 'POST', body: { username: 'rolled_back_new', role: 'gudang', password: 'PgNewAccount123!' } })
      ];
      for (const r of results) { assert.equal(r.status, 500); assert.ok(!JSON.stringify(r.data).includes('simulated')); }
      const user = await stored(); assert.equal(user.username, 'pg_gudang'); assert.equal(user.role, 'gudang'); assert.equal(user.status, 'aktif');
      assert.equal(user.password_hash, hash); assert.equal((await stored(3)).password_hash, hash);
      assert.equal((await query('SELECT COUNT(*) FROM users')).rows[0].count, '4'); assert.equal((await logs()).length, 0);
    } finally { await query('DROP TRIGGER fail_admin_audit ON audit_logs; DROP FUNCTION fail_admin_audit()'); }
  });
  test('invalid updates and conflicting usernames preserve the account and audit trail', async () => {
    for (const body of [editBody({ status: 'deleted' }), editBody({ username: 'bad name' }), {}, editBody({ role: {} })])
      assert.equal((await update(body)).status, 400);
    assert.equal((await update(editBody({ username: 'pg_admin' }))).status, 409);
    assert.equal((await logs()).length, 0); assert.equal((await stored()).username, 'pg_gudang');
  });
  test('audit events identify actor, target, changed fields and IP without leaking credentials', async () => {
    await update(editBody({ username: 'pg_staff_changed', role: 'pelayanan', status: 'nonaktif' }));
    await request('/api/users/2/reset-password', { method: 'POST', body: { newPassword: 'PgResetAudit123!' } });
    await request('/api/auth/password', { method: 'PATCH', jwt: token(3), body: { oldPassword: 'PgOriginal123!', newPassword: 'PgAuditChanged123!' } });
    const result = await request('/api/audit-logs'); assert.equal(result.status, 200);
    const records = result.data.data.logs;
    assert.deepEqual([...records].reverse().map(log => log.action), ['update_user: target=2 fields=username,role,status', 'reset_password: target=2', 'change_password: target=3']);
    assert.deepEqual([...records].reverse().map(log => log.user_id), [1, 1, 3]);
    assert.ok(records.every(log => log.ip_address && log.created_at && log.action.length <= 100));
    assert.ok(!/password_hash|PgResetAudit|PgAuditChanged|PgOriginal|credential|Bearer|\$2[aby]\$/.test(JSON.stringify(result.data)));
  });
  test('audit search matches action, username and IP while escaping SQL wildcard characters', async () => {
    await auth.writeAuditLog(2, 'update_user: literal_%\\', '198.51.100.20');
    await auth.writeAuditLog(1, 'reset_password: target=3', '198.51.100.21');
    for (const search of ['UPDATE_USER', 'pg_gudang', '198.51.100.20', 'literal_%\\']) {
      const r = await request('/api/audit-logs?' + new URLSearchParams({ search }));
      assert.equal(r.status, 200); assert.equal(r.data.data.logs.length, 1); assert.equal(r.data.data.logs[0].user_id, 2);
    }
    assert.equal((await request('/api/audit-logs?' + new URLSearchParams({ search: '%no-match_' }))).data.data.logs.length, 0);
  });
  test('audit pagination is bounded and stable when timestamps tie; logs have no mutation endpoint', async () => {
    await query("INSERT INTO audit_logs (user_id, action, created_at) SELECT 1, 'update_user: target=2', '2026-11-01'::timestamp FROM generate_series(1,55)");
    const first = (await request('/api/audit-logs')).data.data;
    const second = (await request('/api/audit-logs?page=2')).data.data;
    assert.equal(first.logs.length, 50); assert.equal(first.hasMore, true); assert.equal(second.logs.length, 5); assert.equal(second.hasMore, false);
    assert.deepEqual([...first.logs, ...second.logs].map(log => log.log_id), Array.from({ length: 55 }, (_, i) => 55 - i));
    for (const suffix of ['page=0', 'page=-1', 'page=1.5', 'page=100001', 'page=1&page=2', 'search=' + 'x'.repeat(101)])
      assert.equal((await request('/api/audit-logs?' + suffix)).status, 400);
    for (const method of ['PATCH', 'DELETE']) assert.equal((await request('/api/audit-logs/1', { method, body: {} })).status, 404);
    assert.equal((await logs()).length, 55);
  });
  test('existing login/logout use secure cookies and security audit events without disclosing tokens', async () => {
    const login = await request('/api/auth/login', { method: 'POST', jwt: null, body: { username: 'pg_admin', password: 'PgOriginal123!' } });
    assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /HttpOnly/);
    assert.match(login.headers.get('set-cookie'), /SameSite=Lax/); assertPublic(login.data.data.user);
    assert.equal(login.data.data.token, undefined);
    const logout = await request('/api/auth/logout', { method: 'POST', body: {} });
    assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /Expires=/);
    assert.deepEqual((await logs()).map(log => log.action), ['login_success', 'logout']);
  });
  test('services recheck actor authority even when called outside HTTP middleware', async () => {
    await assert.rejects(userService.getUserDetails(2, 3), { status: 403 });
    await assert.rejects(userService.updateUser(2, editBody(), 3, '127.0.0.1'), { status: 403 });
    await assert.rejects(userService.changePassword(2, 'PgChanged123!', 3, '127.0.0.1'), { status: 403 });
    await assert.rejects(userService.changePassword(2, 'PgChanged123!', 3, '127.0.0.1', 'PgOriginal123!'), { status: 400 });
    await query("UPDATE users SET status='nonaktif' WHERE user_id=1");
    await assert.rejects(userService.getUserDetails(2, 1), { status: 401 });
    await assert.rejects(userService.updateUser(2, editBody(), 1, '127.0.0.1'), { status: 401 });
    assert.equal((await logs()).length, 0);
  });
  test('Admin stock operations remain forbidden before any stock-schema query; CSRF remains enforced', async () => {
    assert.equal((await query("SELECT to_regclass('stock_documents') AS name")).rows[0].name, null);
    for (const route of ['/api/stock/in', '/api/stock/out']) assert.equal((await request(route, { method: 'POST', body: {} })).status, 403);
    for (const route of ['/stok-masuk', '/stok-keluar']) assert.equal((await request(route)).status, 403);
    assert.equal((await request('/api/stock/out', { method: 'POST', jwt: token(2), body: {} })).status, 403);
    assert.equal((await request('/api/stock/in', { method: 'POST', jwt: token(3), body: {} })).status, 403);
    assert.equal((await update(editBody(), 2, token(4))).status, 403);
    assert.equal((await request('/api/users/2', { method: 'PATCH', body: editBody(), headers: { Origin: 'https://foreign.invalid' } })).status, 403);
    assert.equal((await request('/api/users/2', { method: 'PATCH', body: editBody(), headers: { 'Content-Type': 'text/plain' } })).status, 415);
  });
}
