// Child processes isolate module caches, environment and the singleton pg pool.
// Only mocks and loopback protocol fixtures are used; never the shared database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const mockStartup = String.raw`
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const scenario = process.env.STARTUP_SCENARIO;
let pools = 0, queries = 0, ends = 0, listening = false, ready = false, resolveProbe;
const errors = [], output = [];
const log = console.log;
console.log = (...args) => { output.push(args.join(' ')); log(...args); };
console.error = (...args) => { errors.push(args.join(' ')); log(...args); };
process.on('unhandledRejection', () => { process.exitCode = 90; });
process.on('exit', () => log('METRICS ' + JSON.stringify({ pools, queries, ends, listening })));
const fault = () => {
  if (scenario === 'connection-timeout') return new Error('Connection terminated due to connection timeout');
  if (scenario === 'query-timeout') return new Error('Query read timeout');
  return Object.assign(new Error('sensitive-connection-details-do-not-print'), {
    code: scenario === 'main-dns' ? 'ENOTFOUND' : scenario
  });
};
class Pool extends EventEmitter {
  constructor(options) {
    super(); pools++; this.options = options;
    assert.equal(options.connectionTimeoutMillis, 10000);
    assert.equal(options.query_timeout, undefined);
    assert.equal(options.idleTimeoutMillis, 30000);
    assert.equal(options.max, 10);
    // Do not send unsupported startup settings through Neon's pooler.
    assert.equal(options.statement_timeout, undefined);
  }
  query(sql) {
    queries++; assert.equal(sql.text, 'SELECT 1'); assert.equal(sql.query_timeout, 15000);
    if (scenario === 'success') return new Promise(resolve => {
      resolveProbe = () => { ready = true; resolve({ rows: [{ '?column?': 1 }] }); };
    });
    if (scenario === 'listen-error') { ready = true; return Promise.resolve({ rows: [] }); }
    return Promise.reject(fault());
  }
  async end() { ends++; }
}
const realLoad = Module._load;
Module._load = function(name, ...args) {
  return name === 'pg' ? { Pool } : realLoad.call(this, name, ...args);
};
if (scenario === 'main-dns') {
  Module.runMain(require('node:path').resolve('server.js'));
} else {
  (async () => {
    const app = require('./server');
    const db = require('./src/config/db');
    assert.equal(require('./src/config/db').pool, db.pool);
    assert.equal(pools, 1);
    assert.equal(queries, 0); // Importing the app must not connect (test/embedding contract).
    if (scenario === 'import') return;
    if (scenario === 'idle-error') {
      db.pool.emit('error', Object.assign(new Error('sensitive-connection-details-do-not-print'), { code: 'ECONNRESET' }));
      assert.match(errors.join(' '), /ECONNRESET/);
      assert.equal(queries, 0); return;
    }
    const listen = app.listen;
    app.listen = function(...args) {
      assert.equal(ready, true); listening = true;
      if (scenario === 'listen-error') {
        const server = new EventEmitter();
        queueMicrotask(() => server.emit('error', Object.assign(new Error('private-listen-details'), { code: 'EADDRINUSE' })));
        return server;
      }
      return listen.apply(this, args);
    };
    if (scenario === 'success') {
      const pending = app.start();
      assert.equal(listening, false);
      assert.equal(output.some(line => line.includes('[Database] Siap')), false);
      resolveProbe();
      const server = await pending;
      try {
        assert.equal(output.filter(line => line.includes('[Database] Siap')).length, 1);
        assert.ok(output.findIndex(line => line.includes('[Database] Siap')) <
          output.findIndex(line => line.includes('Server Backend aktif')));
        const origin = 'http://127.0.0.1:' + server.address().port;
        assert.equal((await fetch(origin + '/login')).status, 200);
        assert.equal((await fetch(origin + '/api/stock/medicines')).status, 401);
        assert.equal(queries, 1); assert.equal(pools, 1);
      } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await db.pool.end();
      }
    } else {
      await assert.rejects(app.start());
      assert.equal(ends, 1);
      assert.equal(listening, scenario === 'listen-error');
      assert.equal(output.some(line => line.includes('Server Backend aktif')), false);
      assert.match(errors.join(' '), /\[Startup Error\]/);
      if (scenario !== 'listen-error') assert.equal(output.some(line => line.includes('[Database] Siap')), false);
    }
    assert.equal(queries, 1);
  })().catch(error => { log(error.stack); process.exitCode = 91; });
}
`;

function run(source, scenario) {
  const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', source], {
    cwd: path.resolve(__dirname, '..'), timeout: 8000, encoding: 'utf8',
    env: { ...process.env, STARTUP_SCENARIO: scenario, PORT: '0', NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://fixture:never-display@127.0.0.1:1/isolated',
      JWT_SECRET: 'startup-tests-isolated-secret-only-1234567890123456789' }
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /sensitive-connection-details-do-not-print|never-display|private-listen-details/);
  return result;
}

test('import creates one lazy pool and does not start HTTP or execute startup SQL', () => {
  const result = run(mockStartup, 'import');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /"pools":1,"queries":0,"ends":0,"listening":false/);
});

test('startup waits for SELECT 1, uses one pool and serves HTTP only after readiness', () => {
  const result = run(mockStartup, 'success');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /"pools":1,"queries":1,"ends":1,"listening":true/);
});

for (const scenario of ['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', '28P01', 'connection-timeout', 'query-timeout', 'listen-error']) {
  test(`startup handles ${scenario}, reports a safe reason and closes the pool`, () => {
    const result = run(mockStartup, scenario);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const expected = scenario.includes('timeout') ? 'DB_TIMEOUT' : scenario === 'listen-error' ? 'EADDRINUSE' : scenario;
    assert.ok(result.stdout.includes('[Startup Error] ' + expected), result.stdout);
  });
}

test('actual main entry point exits 1 on DB failure without unhandled rejection', () => {
  const result = run(mockStartup, 'main-dns');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /\[Startup Error\] ENOTFOUND/);
  assert.match(result.stdout, /"pools":1,"queries":1,"ends":1,"listening":false/);
});

test('idle pool errors are handled and logged without exposing connection details', () => {
  const result = run(mockStartup, 'idle-error');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /ECONNRESET/);
});

const realTimeout = String.raw`
const assert = require('node:assert/strict');
const net = require('node:net');
const sockets = new Set();
const scenario = process.env.STARTUP_SCENARIO;
(async () => {
  const fixture = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    if (scenario === 'real-query-timeout') {
      let buffer = Buffer.alloc(0), handshake = false;
      socket.on('data', chunk => {
        if (handshake) return; // Accept SELECT 1 but never return a result.
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length < 4 || buffer.length < buffer.readInt32BE(0)) return;
        handshake = true;
        socket.write(Buffer.from([82,0,0,0,8,0,0,0,0,90,0,0,0,5,73]));
      });
    }
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  process.env.DATABASE_URL = 'postgresql://fixture:never-display@127.0.0.1:' + fixture.address().port + '/isolated?sslmode=disable';
  const db = require('./src/config/db');
  assert.equal(db.pool.options.connectionTimeoutMillis, 10000);
  assert.equal(db.pool.options.query_timeout, undefined);
  // Shorten only this isolated pool's timers to exercise the real pg driver.
  db.pool.options.connectionTimeoutMillis = 150;
  const realQuery = db.pool.query.bind(db.pool);
  db.pool.query = (config, ...args) => {
    assert.equal(config.text, 'SELECT 1');
    assert.equal(config.query_timeout, 15000);
    return realQuery({ ...config, query_timeout: 150 }, ...args);
  };
  const app = require('./server');
  const before = Date.now();
  try {
    await assert.rejects(app.start(), /timeout/i);
    assert.ok(Date.now() - before < 3000, 'startup must settle promptly');
    assert.equal(db.pool.ended, true);
    console.log('REAL_TIMEOUT_OK ' + scenario);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => fixture.close(resolve));
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
`;

for (const scenario of ['real-connect-timeout', 'real-query-timeout']) {
  test(`${scenario}: real pg driver settles against a loopback blackhole without retries`, () => {
    const result = run(realTimeout, scenario);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(result.stdout.includes('REAL_TIMEOUT_OK ' + scenario));
    assert.match(result.stderr, /\[Startup Error\] DB_TIMEOUT/);
  });
}
