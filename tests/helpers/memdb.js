// In-memory PostgreSQL stand-in untuk pengujian terisolasi modul monitoring &
// laporan. Tidak menyentuh Neon. Mem-pattern-match statement SQL yang dipakai
// service dan mengemulasi transaksi (BEGIN/COMMIT/ROLLBACK + FOR UPDATE) dengan
// snapshot seluruh tabel, mengikuti pola tests/admin.test.js.
'use strict';
const assert = require('node:assert/strict');

function copy(value) { return structuredClone(value); }
// Selisih hari antar dua tanggal 'YYYY-MM-DD' (meniru (date - date) PostgreSQL).
function dayDiff(toStr, fromStr) {
  return Math.round((Date.parse(toStr + 'T00:00:00Z') - Date.parse(fromStr + 'T00:00:00Z')) / 86400000);
}

function createDb() {
  const state = {
    today: '2026-09-21',
    users: [], medicines: [], batches: [], transactions: [], opname: [], opnameItems: [], logs: [],
    seq: { opname: 0, item: 0, tx: 0, log: 0 }
  };
  let snapshot = null;

  const totalStock = code => state.batches.filter(b => b.medicine_code === code)
    .reduce((sum, b) => sum + Number(b.current_qty), 0);
  const userName = id => (state.users.find(u => u.user_id === id) || {}).username || null;

  async function query(sql, params = []) {
    const q = sql.replace(/\s+/g, ' ').trim();

    // ---- Kontrol transaksi ----
    if (q === 'BEGIN') { snapshot = copy({ ...state }); return { rows: [] }; }
    if (q === 'ROLLBACK') { if (snapshot) Object.assign(state, snapshot); snapshot = null; return { rows: [] }; }
    if (q === 'COMMIT') { snapshot = null; return { rows: [] }; }
    if (q.startsWith('LOCK TABLE')) return { rows: [] };

    // ---- audit_logs ----
    if (q.startsWith('INSERT INTO audit_logs')) {
      assert.ok(params[1].length <= 100, 'audit action fits varchar(100)');
      state.logs.push({ log_id: ++state.seq.log, user_id: params[0], action: params[1], ip_address: params[2], created_at: new Date().toISOString() });
      return { rows: [] };
    }

    // ---- users ----
    if (q.includes('FROM users WHERE user_id = $1')) {
      const user = state.users.find(u => u.user_id === params[0]);
      return { rows: user ? [copy(user)] : [] };
    }

    // ---- monitoring: alert kedaluwarsa ----
    if (q.startsWith('SELECT b.batch_number, b.medicine_code, b.current_qty, b.expired_date, b.supplier')) {
      const rows = state.batches.filter(b => Number(b.current_qty) > 0)
        .sort((a, b) => a.expired_date.localeCompare(b.expired_date) || a.batch_number.localeCompare(b.batch_number))
        .map(b => {
          const m = state.medicines.find(x => x.medicine_code === b.medicine_code) || {};
          return { batch_number: b.batch_number, medicine_code: b.medicine_code, current_qty: Number(b.current_qty),
            expired_date: b.expired_date, supplier: b.supplier, name: m.name, unit: m.unit,
            days_remaining: dayDiff(b.expired_date, state.today) };
        });
      return { rows };
    }

    // ---- monitoring: low stock (HAVING ... <= min_stock) ----
    if (q.includes('HAVING COALESCE(SUM(b.current_qty), 0) <= m.min_stock')) {
      const rows = state.medicines.filter(m => m.status === 'aktif')
        .map(m => ({ medicine_code: m.medicine_code, name: m.name, unit: m.unit, min_stock: Number(m.min_stock), total_stock: totalStock(m.medicine_code) }))
        .filter(r => r.total_stock <= r.min_stock)
        .sort((a, b) => (a.total_stock - a.min_stock) - (b.total_stock - b.min_stock) || a.name.localeCompare(b.name));
      return { rows };
    }

    // ---- monitoring: cek keberadaan batch ----
    if (q === 'SELECT batch_number FROM medicine_batches WHERE batch_number = $1') {
      const b = state.batches.find(x => x.batch_number === params[0]);
      return { rows: b ? [{ batch_number: b.batch_number }] : [] };
    }

    // ---- laporan: valuasi aset ----
    if (q.includes('* m.price AS total_value')) {
      const rows = state.medicines.filter(m => m.status === 'aktif')
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(m => { const ts = totalStock(m.medicine_code); return { medicine_code: m.medicine_code, name: m.name, unit: m.unit, price: Number(m.price), total_stock: ts, total_value: ts * Number(m.price) }; });
      return { rows };
    }

    // ---- laporan: seed opname (system_qty per obat aktif) ----
    if (q.includes('COALESCE(SUM(b.current_qty), 0) AS system_qty')) {
      const rows = state.medicines.filter(m => m.status === 'aktif')
        .sort((a, b) => a.medicine_code.localeCompare(b.medicine_code))
        .map(m => ({ medicine_code: m.medicine_code, price: Number(m.price), system_qty: totalStock(m.medicine_code) }));
      return { rows };
    }

    // ---- laporan: lookup obat untuk kartu stok ----
    if (q === 'SELECT medicine_code, name, unit FROM medicines WHERE medicine_code = $1') {
      const m = state.medicines.find(x => x.medicine_code === params[0]);
      return { rows: m ? [{ medicine_code: m.medicine_code, name: m.name, unit: m.unit }] : [] };
    }

    // ---- laporan: mutasi / kartu stok ----
    if (q.startsWith('SELECT t.transaction_id, t.batch_number, t.transaction_type')) {
      const [code, from, to] = params;
      const rows = state.transactions.filter(t => t.medicine_code === code
        && (!from || t.transaction_date >= from) && (!to || t.transaction_date <= to))
        .sort((a, b) => a.transaction_date.localeCompare(b.transaction_date) || a.transaction_id - b.transaction_id)
        .map(t => ({ transaction_id: t.transaction_id, batch_number: t.batch_number, transaction_type: t.transaction_type,
          quantity: Number(t.quantity), transaction_date: t.transaction_date, reference_number: t.reference_number,
          created_at: t.created_at, username: userName(t.user_id) }));
      return { rows };
    }

    // ---- opname: insert sesi ----
    if (q.startsWith('INSERT INTO stock_opname (reference_number, status, created_by)')) {
      const session = { opname_id: ++state.seq.opname, reference_number: params[0], status: params[1],
        note: null, created_by: params[2], approved_by: null, created_at: new Date().toISOString(), submitted_at: null, approved_at: null };
      state.opname.push(session);
      return { rows: [{ opname_id: session.opname_id, reference_number: session.reference_number, status: session.status, created_by: session.created_by, created_at: session.created_at }] };
    }

    // ---- opname: insert item ----
    if (q.startsWith('INSERT INTO stock_opname_items (opname_id, medicine_code, system_qty, unit_price)')) {
      state.opnameItems.push({ item_id: ++state.seq.item, opname_id: params[0], medicine_code: params[1],
        system_qty: Number(params[2]), unit_price: Number(params[3]), physical_qty: null, note: null });
      return { rows: [] };
    }

    // ---- opname: daftar sesi ----
    if (q.startsWith('SELECT o.opname_id, o.reference_number, o.status, o.created_at, o.submitted_at, o.approved_at')) {
      const rows = [...state.opname].sort((a, b) => b.opname_id - a.opname_id).map(o => ({
        opname_id: o.opname_id, reference_number: o.reference_number, status: o.status, created_at: o.created_at,
        submitted_at: o.submitted_at, approved_at: o.approved_at, created_by_name: userName(o.created_by), approved_by_name: userName(o.approved_by) }));
      return { rows };
    }

    // ---- opname: detail sesi ----
    if (q.startsWith('SELECT o.opname_id, o.reference_number, o.status, o.note')) {
      const o = state.opname.find(x => x.opname_id === params[0]);
      if (!o) return { rows: [] };
      return { rows: [{ opname_id: o.opname_id, reference_number: o.reference_number, status: o.status, note: o.note,
        created_at: o.created_at, submitted_at: o.submitted_at, approved_at: o.approved_at,
        created_by_name: userName(o.created_by), approved_by_name: userName(o.approved_by) }] };
    }

    // ---- opname: item detail (join medicines) ----
    if (q.startsWith('SELECT i.item_id, i.medicine_code, i.system_qty, i.physical_qty, i.unit_price, i.note, m.name')) {
      const rows = state.opnameItems.filter(i => i.opname_id === params[0]).map(i => {
        const m = state.medicines.find(x => x.medicine_code === i.medicine_code) || {};
        return { ...copy(i), name: m.name, unit: m.unit };
      }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return { rows };
    }

    // ---- opname: batalkan (hapus sesi + item) ----
    if (q.startsWith('DELETE FROM stock_opname WHERE opname_id = $1')) {
      state.opname = state.opname.filter(o => o.opname_id !== params[0]);
      state.opnameItems = state.opnameItems.filter(i => i.opname_id !== params[0]);
      return { rows: [] };
    }

    // ---- opname: header sesi (FOR UPDATE) ----
    if (q.startsWith('SELECT opname_id, status FROM stock_opname WHERE opname_id = $1')) {
      const o = state.opname.find(x => x.opname_id === params[0]);
      return { rows: o ? [{ opname_id: o.opname_id, status: o.status }] : [] };
    }

    // ---- opname: satu item (system_qty) ----
    if (q.startsWith('SELECT system_qty FROM stock_opname_items WHERE opname_id = $1 AND medicine_code = $2')) {
      const item = state.opnameItems.find(i => i.opname_id === params[0] && i.medicine_code === params[1]);
      return { rows: item ? [{ system_qty: item.system_qty }] : [] };
    }

    // ---- opname: items untuk submit/approve ----
    if (q.startsWith('SELECT medicine_code, system_qty, physical_qty, note FROM stock_opname_items')) {
      return { rows: state.opnameItems.filter(i => i.opname_id === params[0]).map(copy) };
    }
    if (q.startsWith('SELECT opname_id, medicine_code, system_qty, physical_qty, note FROM stock_opname_items')) {
      return { rows: state.opnameItems.filter(i => i.opname_id === params[0]).map(copy) };
    }

    // ---- opname: update item fisik ----
    if (q.startsWith('UPDATE stock_opname_items SET physical_qty')) {
      const item = state.opnameItems.find(i => i.opname_id === params[2] && i.medicine_code === params[3]);
      if (item) { item.physical_qty = params[0]; item.note = params[1]; }
      return { rows: [] };
    }

    // ---- opname: update status ----
    if (q.includes("UPDATE stock_opname SET status = 'pending_approval'")) {
      const o = state.opname.find(x => x.opname_id === params[0]); if (o) { o.status = 'pending_approval'; o.submitted_at = new Date().toISOString(); }
      return { rows: [] };
    }
    if (q.includes("UPDATE stock_opname SET status = 'approved'")) {
      const o = state.opname.find(x => x.opname_id === params[2]); if (o) { o.status = 'approved'; o.approved_by = params[0]; o.note = params[1]; o.approved_at = new Date().toISOString(); }
      return { rows: [] };
    }
    if (q.includes("UPDATE stock_opname SET status = 'rejected'")) {
      const o = state.opname.find(x => x.opname_id === params[2]); if (o) { o.status = 'rejected'; o.approved_by = params[0]; o.note = params[1]; o.approved_at = new Date().toISOString(); }
      return { rows: [] };
    }

    // ---- batches untuk penyesuaian (FOR UPDATE) ----
    if (q.startsWith('SELECT batch_number, current_qty, expired_date FROM medicine_batches WHERE medicine_code = $1')) {
      const rows = state.batches.filter(b => b.medicine_code === params[0])
        .sort((a, b) => a.expired_date.localeCompare(b.expired_date) || a.batch_number.localeCompare(b.batch_number))
        .map(b => ({ batch_number: b.batch_number, current_qty: Number(b.current_qty), expired_date: b.expired_date }));
      return { rows };
    }
    if (q.startsWith('UPDATE medicine_batches SET current_qty = current_qty + $1')) {
      const b = state.batches.find(x => x.batch_number === params[1]); if (b) b.current_qty = Number(b.current_qty) + Number(params[0]);
      return { rows: [] };
    }
    if (q.startsWith('UPDATE medicine_batches SET current_qty = current_qty - $1')) {
      const b = state.batches.find(x => x.batch_number === params[1]); if (b) b.current_qty = Number(b.current_qty) - Number(params[0]);
      return { rows: [] };
    }

    // ---- insert transaksi penyesuaian ----
    if (q.startsWith('INSERT INTO stock_transactions')) {
      state.transactions.push({ transaction_id: ++state.seq.tx, medicine_code: params[0], batch_number: params[1],
        user_id: params[2], transaction_type: 'ADJUSTMENT', quantity: Number(params[3]), reference_number: params[4],
        transaction_date: state.today, created_at: new Date().toISOString() });
      return { rows: [] };
    }

    throw new Error('Unexpected test SQL: ' + q);
  }

  const pool = { connect: async () => ({ query, release() {} }) };
  return { state, query, pool };
}

module.exports = { createDb, dayDiff };
