// Execute the actual inline page scripts with controlled fetch timing and a small DOM
// adapter. No server, database, browser dependency or implementation functions are mocked.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = (data, status = 200) => ({ status, ok: status < 400, json: async () => data });
const batch = (code, stock, exp = '2099-01-01') => ({ batch_number: code, current_qty: stock, expired_date: exp });
const detail = (id, username) => response({ data: { user: { user_id: id, username, role: 'gudang', status: 'aktif' } } });

async function page(name, options = {}) {
  const html = readFileSync(path.join(__dirname, '../views', name + '.html'), 'utf8');
  const elements = new Map();
  class Element {
    constructor(tag = 'div') { this.tag = tag; this.children = []; this.events = {}; this.value = ''; this.disabled = false; this.hidden = false; this.dataset = {}; this._text = ''; }
    set id(id) { this._id = id; elements.set(id, this); }
    get id() { return this._id; }
    set textContent(text) { this._text = String(text); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(' '); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; this._text = ''; }
    addEventListener(type, handler) { (this.events[type] ||= []).push(handler); }
    async dispatch(type) { await Promise.all((this.events[type] || []).map(handler => handler({ preventDefault() {} }))); }
    reset() { for (const id of this.fields || []) elements.get(id).value = ''; }
    showModal() { this.open = true; }
    close() { this.open = false; return this.dispatch('close'); }
    querySelector() { return elements.get(this.id === 'userDialog' ? 'userForm' : 'resetForm'); }
  }
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) { const element = new Element(); element.id = match[1]; }
  for (const match of html.matchAll(/<form\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g))
    elements.get(match[1]).fields = [...match[2].matchAll(/\bid="([^"]+)"/g)].map(field => field[1]);
  const closeButtons = [...html.matchAll(/data-close="([^"]+)"/g)].map(match => {
    const button = new Element('button'); button.dataset.close = match[1]; return button;
  });
  const main = new Element('main'), requests = [], confirmations = [];
  const account = { user_id: 1, username: 'admin_test', role: name === 'admin' ? 'admin' : 'kepala_farmasi', status: 'aktif' };
  const users = [account, { user_id: 2, username: 'staff_two', role: 'gudang', status: 'aktif' }, { user_id: 3, username: 'staff_three', role: 'pelayanan', status: 'aktif' }];
  const medicines = [{ medicine_code: 'A', name: 'Obat A', unit: 'Tablet' }, { medicine_code: 'B', name: 'Obat B', unit: 'Kapsul' }];
  const document = {
    getElementById: id => elements.get(id) || null,
    createElement: tag => new Element(tag),
    querySelector: () => main,
    querySelectorAll: () => closeButtons
  };
  const context = vm.createContext({ document, URLSearchParams, TextEncoder,
    location: { assign() {} }, window: { print() {} },
    confirm(text) { confirmations.push(text); return options.confirm ? options.confirm(text) : true; },
    async fetch(url, init = {}) {
      const request = { url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined };
      requests.push(request);
      const custom = options.fetch?.(request);
      if (custom !== undefined) return custom;
      if (url === '/api/auth/me') return response({ data: { user: account } });
      if (url === '/api/users') return response({ data: { users } });
      if (url.startsWith('/api/audit-logs?')) return response({ data: { logs: [], page: 1, hasMore: false } });
      if (url === '/api/stock/medicines?limit=500') return response({ data: { data: medicines } });
      if (url.endsWith('/batches')) return response({ data: [batch('EARLY', 3), batch('LATE', 4, '2099-02-01')] });
      if (url === '/api/stock/out') return response({ data: {
        document_id: 'test-document', reference_number: request.body.reference_number, destination: request.body.destination,
        transaction_date: '2098-12-01', username: 'tester', notes: request.body.notes,
        items: [{ medicine_code: 'A', medicine_name: 'Obat A', unit: 'Tablet', batch_number: 'EARLY', quantity: request.body.quantity, expired_date: '2099-01-01' }]
      } });
      throw new Error('Unexpected fixture request: ' + request.method + ' ' + url);
    }
  });
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) vm.runInContext(match[1], context);
  await settle();
  const get = id => elements.get(id);
  return { get, requests, confirmations, users,
    posts: () => requests.filter(request => request.method === 'POST'),
    edit: id => get('usersBody').children.find(row => row.children[0].textContent.includes(users.find(user => user.user_id === id).username)).children[4].children[0],
    reset: id => get('usersBody').children.find(row => row.children[0].textContent.includes(users.find(user => user.user_id === id).username)).children[4].children[1],
    async choose(code) { get('drug').value = code; await get('drug').dispatch('change'); await settle(); },
    async quantity(qty) { get('qty').value = String(qty); await get('qty').dispatch('input'); },
    fill() { get('refNo').value = 'RSP-TEST'; get('unit').value = 'IGD'; get('note').value = 'Catatan'; },
    submit: () => get('outForm').dispatch('submit')
  };
}

test('Admin ignores late Edit success after Add Account opens, preserving all draft fields', async () => {
  const pending = deferred();
  const p = await page('admin', { fetch: r => r.url === '/api/users/2' ? pending.promise : undefined });
  const edit = p.edit(2), work = edit.dispatch('click');
  assert.equal(edit.disabled, true); assert.equal(edit.textContent, 'Memuat...');
  await p.get('addUser').dispatch('click');
  for (const [id, value] of Object.entries({ username: 'draft_account', role: 'pelayanan', password: 'DraftPass123!', confirmPassword: 'DraftPass123!' })) p.get(id).value = value;
  pending.resolve(detail(2, 'latest_staff')); await work;
  assert.equal(p.get('formTitle').textContent, 'Tambah Pengguna');
  assert.equal(p.get('username').value, 'draft_account'); assert.equal(p.get('role').value, 'pelayanan');
  assert.equal(p.get('password').value, 'DraftPass123!'); assert.equal(p.get('confirmPassword').value, 'DraftPass123!');
  assert.equal(p.get('initialPasswordFields').hidden, false); assert.equal(edit.disabled, false);
});
test('Admin ignores stale Edit errors after Add Account supersedes the request', async () => {
  const pending = deferred();
  const p = await page('admin', { fetch: r => r.url === '/api/users/2' ? pending.promise : undefined });
  p.get('message').hidden = true;
  const work = p.edit(2).dispatch('click'); await p.get('addUser').dispatch('click');
  pending.resolve(response({ message: 'stale failure' }, 404)); await work;
  assert.equal(p.get('message').hidden, true); assert.equal(p.get('formTitle').textContent, 'Tambah Pengguna');
});
test('Admin latest Edit wins out-of-order requests and uses fresh API data', async () => {
  const a = deferred(), b = deferred();
  const p = await page('admin', { fetch: r => r.url === '/api/users/2' ? a.promise : r.url === '/api/users/3' ? b.promise : undefined });
  const first = p.edit(2).dispatch('click'), second = p.edit(3).dispatch('click');
  b.resolve(detail(3, 'fresh_three')); await second;
  a.resolve(detail(2, 'stale_two')); await first;
  assert.equal(p.get('username').value, 'fresh_three'); assert.equal(p.get('formTitle').textContent, 'Edit Pengguna');
});
test('Admin opening Reset supersedes an outstanding Edit; current Edit errors remain visible', async () => {
  const pending = deferred();
  const p = await page('admin', { fetch: r => r.url === '/api/users/2' ? pending.promise : undefined });
  const work = p.edit(2).dispatch('click'); await p.reset(3).dispatch('click');
  pending.resolve(detail(2, 'late_staff')); await work;
  assert.equal(p.get('resetDialog').open, true); assert.notEqual(p.get('userDialog').open, true);
  const failed = await page('admin', { fetch: r => r.url === '/api/users/2' ? response({ message: 'Detail gagal' }, 404) : undefined });
  await failed.edit(2).dispatch('click'); assert.equal(failed.get('message').textContent, 'Detail gagal');
  assert.equal(failed.edit(2).disabled, false);
});
test('Stock Out blocks button and programmatic submit while batches are loading', async () => {
  const pending = deferred();
  const p = await page('stok-keluar', { fetch: r => r.url.endsWith('/batches') ? pending.promise : undefined });
  p.fill(); await p.choose('A'); await p.quantity(2);
  assert.equal(p.get('saveOut').disabled, true); assert.match(p.get('batchAuto').value, /Memuat/);
  await p.submit(); assert.equal(p.posts().length, 0); assert.equal(p.confirmations.length, 0);
  pending.resolve(response({ data: [batch('READY', 5)] })); await settle();
  assert.equal(p.get('saveOut').disabled, false);
});
test('Stock Out validates total eligible stock, permits multi-batch requests and blocks insufficient stock', async () => {
  const p = await page('stok-keluar'); p.fill(); await p.choose('A'); await p.quantity(6);
  assert.equal(p.get('saveOut').disabled, false);
  assert.equal(p.get('batchAuto').value, 'EARLY: 3 | LATE: 3');
  await p.quantity(8); assert.equal(p.get('saveOut').disabled, true); assert.match(p.get('message').textContent, /Tersedia: 7/);
  await p.submit(); assert.equal(p.posts().length, 0); assert.equal(p.confirmations.length, 0);
});
test('Stock Out zero stock and invalid quantities remain blocked', async () => {
  const p = await page('stok-keluar', { fetch: r => r.url.endsWith('/batches') ? response({ data: [] }) : undefined });
  p.fill(); await p.choose('A');
  for (const qty of [1, 0, -1, 1.5]) { await p.quantity(qty); assert.equal(p.get('saveOut').disabled, true); await p.submit(); }
  assert.equal(p.posts().length, 0);
});
test('Stock Out ignores a previous medicine response while the selected medicine is loading', async () => {
  const a = deferred(), b = deferred();
  const p = await page('stok-keluar', { fetch: r => r.url.includes('/A/batches') ? a.promise : r.url.includes('/B/batches') ? b.promise : undefined });
  await p.choose('A'); await p.quantity(2); await p.choose('B');
  a.resolve(response({ data: [batch('STALE', 100)] })); await settle();
  assert.equal(p.get('saveOut').disabled, true); assert.match(p.get('batchAuto').value, /Memuat/);
  b.resolve(response({ data: [batch('CURRENT', 4)] })); await settle();
  assert.equal(p.get('saveOut').disabled, false); assert.equal(p.get('batchAuto').value, 'CURRENT: 2');
});
test('Stock Out A-B-A selection ignores earlier same-medicine results and stale failures', async () => {
  const first = deferred(), middle = deferred(), latest = deferred(); let count = 0;
  const p = await page('stok-keluar', { fetch: r => r.url.includes('/A/batches') ? (++count === 1 ? first.promise : latest.promise) : r.url.includes('/B/batches') ? middle.promise : undefined });
  await p.choose('A'); await p.quantity(2); await p.choose('B'); await p.choose('A');
  latest.resolve(response({ data: [batch('NEW', 1)] })); await settle();
  first.resolve(response({ data: [batch('OLD', 100)] })); middle.reject(new Error('stale request failed')); await settle();
  assert.equal(p.get('saveOut').disabled, true); assert.equal(p.get('batchAuto').value, 'NEW: 1 | Kurang: 1');
  assert.match(p.get('message').textContent, /Tersedia: 1/);
});
test('Stock Out a failed latest preview cannot be enabled by an older successful response', async () => {
  const old = deferred(), current = deferred(); let count = 0;
  const p = await page('stok-keluar', { fetch: r => r.url.endsWith('/batches') ? (++count === 1 ? old.promise : current.promise) : undefined });
  p.fill(); await p.choose('A'); await p.quantity(2); await p.choose('A');
  current.reject(new Error('Latest preview failed')); await settle();
  old.resolve(response({ data: [batch('OLD', 100)] })); await settle();
  assert.equal(p.get('saveOut').disabled, true); assert.match(p.get('message').textContent, /Latest preview failed/);
  await p.submit(); assert.equal(p.posts().length, 0);
});
test('Stock Out clearing selection invalidates an in-flight batch request', async () => {
  const pending = deferred();
  const p = await page('stok-keluar', { fetch: r => r.url.endsWith('/batches') ? pending.promise : undefined });
  await p.choose('A'); await p.quantity(1); await p.choose('');
  pending.resolve(response({ data: [batch('OLD', 10)] })); await settle();
  assert.equal(p.get('saveOut').disabled, true); assert.equal(p.get('batchAuto').value, '');
});
test('Stock Out confirmation includes medicine, quantity, reference and complete FEFO plan; Cancel sends no POST', async () => {
  const p = await page('stok-keluar', { confirm: () => false });
  p.fill(); await p.choose('A'); await p.quantity(6); await p.submit();
  assert.equal(p.confirmations.length, 1);
  for (const value of ['Obat A', '6 Tablet', 'RSP-TEST', 'EARLY: 3', 'LATE: 3']) assert.ok(p.confirmations[0].includes(value));
  assert.equal(p.posts().length, 0); assert.equal(p.get('qty').value, '6'); assert.equal(p.get('note').value, 'Catatan');
  assert.equal(p.get('saveOut').disabled, false);
});
test('Stock Out suppresses duplicate submits and refreshes availability while preserving workflow context', async () => {
  const pending = deferred(); let batches = 0;
  const p = await page('stok-keluar', { fetch: r => {
    if (r.url === '/api/stock/out') return pending.promise;
    if (r.url.endsWith('/batches')) return response({ data: [batch('LIVE', ++batches === 1 ? 7 : 1)] });
  } });
  p.fill(); await p.choose('A'); await p.quantity(6);
  const work = p.submit(); await settle();
  await p.submit(); await p.quantity(1); await p.submit();
  assert.equal(p.posts().length, 1); assert.equal(p.confirmations.length, 1); assert.equal(p.get('saveOut').disabled, true);
  const sent = p.posts()[0].body;
  assert.deepEqual(sent, { reference_number: 'RSP-TEST', destination: 'IGD', medicine_code: 'A', quantity: 6, notes: 'Catatan' });
  pending.resolve(response({ data: { document_id: 'D', reference_number: 'RSP-TEST', transaction_date: '2098-01-01', destination: 'IGD', username: 'actor', items: [] } }));
  await work;
  assert.equal(p.get('drug').value, 'A'); assert.equal(p.get('unit').value, 'IGD'); assert.equal(p.get('refNo').value, 'RSP-TEST');
  assert.equal(p.get('qty').value, ''); assert.equal(p.get('note').value, ''); assert.equal(batches, 2);
  await p.quantity(2); assert.equal(p.get('saveOut').disabled, true); assert.match(p.get('message').textContent, /Tersedia: 1/);
});
test('Stock Out backend stock rejection remains authoritative, keeps draft and reloads preview', async () => {
  let batches = 0;
  const p = await page('stok-keluar', { fetch: r => {
    if (r.url === '/api/stock/out') return response({ message: 'Stok berubah di server' }, 409);
    if (r.url.endsWith('/batches')) return response({ data: [batch('LIVE', ++batches === 1 ? 7 : 1)] });
  } });
  p.fill(); await p.choose('A'); await p.quantity(6); await p.submit();
  assert.equal(p.posts().length, 1); assert.equal(batches, 2); assert.equal(p.get('qty').value, '6'); assert.equal(p.get('note').value, 'Catatan');
  assert.equal(p.get('saveOut').disabled, true); assert.match(p.get('message').textContent, /Tersedia: 1/);
  assert.equal(p.get('receipt'), undefined);
});
