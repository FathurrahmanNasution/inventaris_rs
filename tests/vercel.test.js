// Kesiapan deploy Vercel: entry point, vercel.json, trust proxy, dan ukuran pool.
// Setiap skenario env dijalankan di proses Node terpisah dengan DATABASE_URL palsu;
// pool pg baru terhubung saat ada query, jadi tes ini tidak menyentuh jaringan/Neon.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const BASE_ENV = {
  PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
  DATABASE_URL: 'postgresql://user:pass@127.0.0.1:1/none',
  JWT_SECRET: 'isolated-test-secret-not-for-use-outside-tests-123456789'
  // dotenv tidak menimpa variabel yang sudah ada, jadi DATABASE_URL palsu di atas tetap dipakai.
};

function probe(env, script) {
  const out = execFileSync(process.execPath, ['-e', script], { cwd: root, env: { ...BASE_ENV, ...env }, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}
const SETTINGS = `const app = require('./server'); const db = require('./src/config/db');
console.log(JSON.stringify({ trust: app.get('trust proxy'), max: db.pool.options.max, sameApp: require('./api/index') === app }));`;

// Kirim POST ke /api/auth/logout lewat HTTPS di belakang proxy: tanpa trust proxy
// protokol terbaca http sehingga cek Origin menolak (403); dengan trust proxy lolos ke
// pemeriksaan sesi (401). Tidak ada query database di jalur ini.
const PROXIED_WRITE = `const app = require('./server');
const server = app.listen(0, '127.0.0.1', async () => {
  const host = '127.0.0.1:' + server.address().port;
  const res = await fetch('http://' + host + '/api/auth/logout', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://' + host, 'X-Forwarded-Proto': 'https' }, body: '{}' });
  console.log(JSON.stringify({ status: res.status }));
  server.close(); require('./src/config/db').pool.end();
});`;

test('api/index.js exports the same Express app as server.js', () => {
  assert.equal(probe({}, SETTINGS).sameApp, true);
});

test('local run: proxy headers are not trusted and the pool keeps 10 connections', () => {
  assert.deepEqual(probe({}, SETTINGS), { trust: false, max: 10, sameApp: true });
});

test('on Vercel: trust proxy is enabled and the pool is small', () => {
  const s = probe({ VERCEL: '1' }, SETTINGS);
  assert.equal(s.trust, 1);
  assert.equal(s.max, 3);
});

test('TRUST_PROXY and PG_POOL_MAX can be set explicitly', () => {
  const s = probe({ TRUST_PROXY: 'loopback', PG_POOL_MAX: '5' }, SETTINGS);
  assert.equal(s.trust, 'loopback');
  assert.equal(s.max, 5);
});

test('HTTPS writes behind the Vercel proxy pass the Origin check', () => {
  assert.equal(probe({}, PROXIED_WRITE).status, 403, 'tanpa trust proxy: ditolak');
  assert.equal(probe({ VERCEL: '1' }, PROXIED_WRITE).status, 401, 'dengan trust proxy: lolos cek Origin');
});

test('vercel.json routes every path to the function and bundles views and images', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.deepEqual(config.rewrites, [{ source: '/(.*)', destination: '/api' }]);
  const fn = config.functions['api/index.js'];
  assert.equal(fn.includeFiles, '{views,images}/**');
  assert.ok(fs.existsSync(path.join(root, 'api', 'index.js')));
  for (const dir of ['views', 'images']) assert.ok(fs.readdirSync(path.join(root, dir)).length > 0, dir + ' tidak kosong');
});

test('.env.example lists the required variables without real values', () => {
  const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  for (const name of ['DATABASE_URL', 'JWT_SECRET', 'NODE_ENV', 'APP_ORIGIN', 'PG_POOL_MAX', 'TRUST_PROXY'])
    assert.match(example, new RegExp('^' + name + '=', 'm'), name);
  assert.match(example, /^DATABASE_URL=$/m, 'tanpa connection string asli');
  assert.match(example, /^JWT_SECRET=$/m, 'tanpa secret asli');
});

test('README no longer publishes account passwords', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /Admin123!|Staff123!/);
});
