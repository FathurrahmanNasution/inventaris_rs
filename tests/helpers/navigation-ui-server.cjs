// Browser fixture: real HTTP/session guards and views, with session SELECTs only.
// No PostgreSQL connection, operational accounts, migrations or write adapter.
process.env.JWT_SECRET = 'navigation-browser-fixture-secret-not-for-production-123456789';
process.env.NODE_ENV = 'test';
delete process.env.APP_ORIGIN;
const users = ['admin', 'gudang', 'pelayanan', 'kepala_farmasi'].map((role, i) => ({
  user_id: i + 1, username: 'nav_' + role, role, status: 'aktif', password_hash: 'fixture-' + role
}));
const dbPath = require.resolve('../../src/config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  async query(sql, params = []) {
    if (!sql.includes('FROM users') || !sql.includes('WHERE user_id = $1'))
      throw new Error('Navigation fixture permits only session SELECTs');
    return { rows: users.filter(user => user.user_id === params[0]).map(user => ({ ...user })) };
  },
  pool: { async connect() { throw new Error('Transactions forbidden in navigation fixture'); } }
} };
const app = require('../../server');
const { createJwtToken } = require('../../src/services/authService');
app.get('/__fixture/session/:role', (req, res) => {
  const user = users.find(user => user.role === req.params.role);
  if (!user) return res.status(400).end();
  res.cookie('token', createJwtToken(user), { httpOnly: true, sameSite: 'lax', path: '/' });
  res.json({ role: user.role });
});
const server = app.listen(0, '127.0.0.1', () => {
  console.log(JSON.stringify({ ready: true, origin: 'http://127.0.0.1:' + server.address().port }));
});
process.stdin.resume();
process.stdin.on('end', () => {
  server.closeAllConnections();
  server.close();
});
