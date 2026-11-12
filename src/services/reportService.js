// Pelaporan, Stock Opname & Ekspor Data (REQ-REP-001 s/d 005, REQ-STK-006).
// Menyediakan: laporan valuasi aset, mutasi/kartu stok, serta alur stock opname
// berjenjang (draft -> input fisik -> pengajuan -> approval Kepala Farmasi yang
// mengeksekusi penyesuaian stok batch secara transaksional).
const { query, pool } = require('../config/db');
const { writeAuditLog } = require('./auditService');

const OPNAME_STATUS = ['draft', 'pending_approval', 'approved', 'rejected'];

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}
function validId(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647)
    fail('ID tidak valid.');
  return Number(value);
}
function validDate(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)
    fail('Format ' + label + ' harus YYYY-MM-DD.');
  return value;
}
function validQty(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 2147483647)
    fail(label + ' harus bilangan bulat >= 0.');
  return value;
}
// Selisih qty & nilai + klasifikasi badge audit untuk satu baris opname.
function diffOf(item) {
  const physical = item.physical_qty === null || item.physical_qty === undefined ? null : Number(item.physical_qty);
  const system = Number(item.system_qty);
  const price = Number(item.unit_price);
  if (physical === null) return { physical_qty: null, difference_qty: null, difference_value: null, audit_status: 'belum_dihitung' };
  const difference = physical - system;
  return {
    physical_qty: physical,
    difference_qty: difference,
    difference_value: difference * price,
    audit_status: difference === 0 ? 'cocok' : Math.abs(difference) <= 5 ? 'selisih_minor' : 'selisih_besar'
  };
}
function shapeItem(item) {
  return {
    item_id: item.item_id, medicine_code: item.medicine_code, name: item.name,
    unit: item.unit, system_qty: Number(item.system_qty), unit_price: Number(item.unit_price),
    note: item.note || null, ...diffOf(item)
  };
}

// ---- Laporan Valuasi Aset (REQ-DASH-002) -----------------------------------
async function getValuation() {
  const result = await query(
    'SELECT m.medicine_code, m.name, m.unit, m.price, ' +
    'COALESCE(SUM(b.current_qty), 0) AS total_stock, ' +
    'COALESCE(SUM(b.current_qty), 0) * m.price AS total_value ' +
    'FROM medicines m LEFT JOIN medicine_batches b ON b.medicine_code = m.medicine_code ' +
    "WHERE m.status = 'aktif' " +
    'GROUP BY m.medicine_code, m.name, m.unit, m.price ORDER BY m.name ASC');
  const items = result.rows.map(row => ({
    medicine_code: row.medicine_code, name: row.name, unit: row.unit,
    total_stock: Number(row.total_stock), unit_price: Number(row.price),
    total_value: Number(row.total_value)
  }));
  const grandTotal = items.reduce((sum, item) => sum + item.total_value, 0);
  return { items, grand_total: grandTotal, item_count: items.length };
}

// ---- Laporan Mutasi / Kartu Stok Digital (REQ-STK-006, REQ-REP-004/005) -----
// Riwayat kronologis masuk/keluar/penyesuaian satu obat + saldo berjalan.
async function getStockCard({ medicineCode, from, to } = {}) {
  if (typeof medicineCode !== 'string' || !medicineCode.trim()) fail('Kode obat wajib diisi.');
  const code = medicineCode.trim();
  const dateFrom = validDate(from, 'tanggal awal');
  const dateTo = validDate(to, 'tanggal akhir');
  if (dateFrom && dateTo && dateFrom > dateTo) fail('Tanggal awal tidak boleh setelah tanggal akhir.');
  const medicine = (await query('SELECT medicine_code, name, unit FROM medicines WHERE medicine_code = $1', [code])).rows[0];
  if (!medicine) fail('Obat tidak ditemukan.', 404);

  const result = await query(
    'SELECT t.transaction_id, t.batch_number, t.transaction_type, t.quantity, ' +
    't.transaction_date::text AS transaction_date, t.reference_number, t.created_at, u.username ' +
    'FROM stock_transactions t LEFT JOIN users u ON u.user_id = t.user_id ' +
    'WHERE t.medicine_code = $1 ' +
    'AND ($2::date IS NULL OR t.transaction_date >= $2::date) ' +
    'AND ($3::date IS NULL OR t.transaction_date <= $3::date) ' +
    'ORDER BY t.transaction_date ASC, t.transaction_id ASC',
    // Include earlier mutations when calculating the opening balance of a period.
    [code, null, dateTo]);

  let balance = 0;
  const allRows = result.rows.map(tx => {
    const qty = Number(tx.quantity);
    // IN menambah, OUT mengurangi, ADJUSTMENT memakai nilai bertanda (signed).
    const change = tx.transaction_type === 'IN' ? qty : tx.transaction_type === 'OUT' ? -qty : qty;
    const opening = balance;
    balance += change;
    return {
      transaction_id: tx.transaction_id, batch_number: tx.batch_number,
      transaction_type: tx.transaction_type, quantity: qty, change,
      opening_balance: opening, closing_balance: balance,
      transaction_date: tx.transaction_date, reference_number: tx.reference_number,
      by: tx.username || null
    };
  });
  const rows = allRows.filter(tx => !dateFrom || String(tx.transaction_date).slice(0, 10) >= dateFrom);
  return {
    medicine: { medicine_code: medicine.medicine_code, name: medicine.name, unit: medicine.unit },
    period: { from: dateFrom, to: dateTo },
    entries: rows, opening_balance: rows[0]?.opening_balance ?? balance, final_balance: balance
  };
}

// ---- Stock Opname -----------------------------------------------------------
async function withTransaction(actorId, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const actor = (await client.query('SELECT user_id, role, status FROM users WHERE user_id = $1', [actorId])).rows[0];
    if (!actor || actor.status !== 'aktif') fail('Sesi tidak lagi aktif.', 401);
    const value = await work(client, actor);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

// Membuat sesi baru: membekukan saldo sistem tiap obat aktif sebagai lembar kerja.
async function createOpname({ referenceNumber } = {}, actorId, ipAddress) {
  const ref = referenceNumber === undefined || referenceNumber === null ? null : String(referenceNumber).trim().slice(0, 100) || null;
  return withTransaction(actorId, async (client, actor) => {
    const seeds = (await client.query(
      'SELECT m.medicine_code, m.price, COALESCE(SUM(b.current_qty), 0) AS system_qty ' +
      'FROM medicines m LEFT JOIN medicine_batches b ON b.medicine_code = m.medicine_code ' +
      "WHERE m.status = 'aktif' " +
      'GROUP BY m.medicine_code, m.price ORDER BY m.medicine_code ASC')).rows;
    if (!seeds.length) fail('Tidak ada obat aktif untuk diopname.');
    const session = (await client.query(
      'INSERT INTO stock_opname (reference_number, status, created_by) VALUES ($1, $2, $3) ' +
      'RETURNING opname_id, reference_number, status, created_by, created_at',
      [ref, 'draft', actor.user_id])).rows[0];
    for (const seed of seeds) {
      await client.query(
        'INSERT INTO stock_opname_items (opname_id, medicine_code, system_qty, unit_price) VALUES ($1, $2, $3, $4)',
        [session.opname_id, seed.medicine_code, Number(seed.system_qty), seed.price]);
    }
    await writeAuditLog(actor.user_id, 'opname_create: opname=' + session.opname_id, ipAddress, client);
    return { ...session, item_count: seeds.length };
  });
}

async function listOpname() {
  const result = await query(
    'SELECT o.opname_id, o.reference_number, o.status, o.created_at, o.submitted_at, o.approved_at, ' +
    'c.username AS created_by_name, a.username AS approved_by_name ' +
    'FROM stock_opname o LEFT JOIN users c ON c.user_id = o.created_by ' +
    'LEFT JOIN users a ON a.user_id = o.approved_by ORDER BY o.opname_id DESC');
  return result.rows;
}

async function getOpname(opnameId) {
  const id = validId(opnameId);
  const session = (await query(
    'SELECT o.opname_id, o.reference_number, o.status, o.note, o.created_at, o.submitted_at, o.approved_at, ' +
    'c.username AS created_by_name, a.username AS approved_by_name ' +
    'FROM stock_opname o LEFT JOIN users c ON c.user_id = o.created_by ' +
    'LEFT JOIN users a ON a.user_id = o.approved_by WHERE o.opname_id = $1', [id])).rows[0];
  if (!session) fail('Sesi opname tidak ditemukan.', 404);
  const items = (await query(
    'SELECT i.item_id, i.medicine_code, i.system_qty, i.physical_qty, i.unit_price, i.note, m.name, m.unit ' +
    'FROM stock_opname_items i JOIN medicines m ON m.medicine_code = i.medicine_code ' +
    'WHERE i.opname_id = $1 ORDER BY m.name ASC', [id])).rows;
  const shaped = items.map(shapeItem);
  const totals = shaped.reduce((acc, item) => {
    if (item.difference_qty !== null) { acc.difference_qty += item.difference_qty; acc.difference_value += item.difference_value; }
    return acc;
  }, { difference_qty: 0, difference_value: 0 });
  return { ...session, items: shaped, totals };
}

// Input hasil hitung fisik. Wajib keterangan bila ada selisih (REQ-REP-001/002).
async function inputPhysical(opnameId, body, actorId, ipAddress) {
  const id = validId(opnameId);
  const items = body && Array.isArray(body.items) ? body.items : null;
  if (!items || !items.length) fail('Daftar item fisik wajib diisi.');
  return withTransaction(actorId, async (client, actor) => {
    const session = (await client.query('SELECT opname_id, status FROM stock_opname WHERE opname_id = $1 FOR UPDATE', [id])).rows[0];
    if (!session) fail('Sesi opname tidak ditemukan.', 404);
    if (session.status !== 'draft') fail('Input fisik hanya untuk sesi berstatus draft.', 409);
    let updated = 0;
    for (const entry of items) {
      if (!entry || typeof entry.medicine_code !== 'string') fail('Setiap item wajib memiliki medicine_code.');
      const physical = validQty(entry.physical_qty, 'Stok fisik');
      const current = (await client.query(
        'SELECT system_qty FROM stock_opname_items WHERE opname_id = $1 AND medicine_code = $2',
        [id, entry.medicine_code.trim()])).rows[0];
      if (!current) fail('Obat ' + entry.medicine_code + ' bukan bagian dari sesi opname ini.', 404);
      const note = entry.note === undefined || entry.note === null ? null : String(entry.note).trim().slice(0, 255) || null;
      if (physical - Number(current.system_qty) !== 0 && !note) fail('Keterangan wajib diisi untuk obat dengan selisih: ' + entry.medicine_code);
      await client.query(
        'UPDATE stock_opname_items SET physical_qty = $1, note = $2 WHERE opname_id = $3 AND medicine_code = $4',
        [physical, note, id, entry.medicine_code.trim()]);
      updated++;
    }
    await writeAuditLog(actor.user_id, 'opname_input: opname=' + id + ' items=' + updated, ipAddress, client);
    return { opname_id: id, updated };
  });
}

// Ajukan sesi untuk persetujuan. Semua item wajib sudah terisi fisiknya.
async function submitOpname(opnameId, actorId, ipAddress) {
  const id = validId(opnameId);
  return withTransaction(actorId, async (client, actor) => {
    const session = (await client.query('SELECT opname_id, status FROM stock_opname WHERE opname_id = $1 FOR UPDATE', [id])).rows[0];
    if (!session) fail('Sesi opname tidak ditemukan.', 404);
    if (session.status !== 'draft') fail('Hanya sesi draft yang dapat diajukan.', 409);
    const items = (await client.query('SELECT medicine_code, system_qty, physical_qty, note FROM stock_opname_items WHERE opname_id = $1', [id])).rows;
    const pending = items.filter(i => i.physical_qty === null || i.physical_qty === undefined);
    if (pending.length) fail('Masih ada ' + pending.length + ' item belum diinput stok fisiknya.');
    const missingNote = items.filter(i => Number(i.physical_qty) - Number(i.system_qty) !== 0 && !i.note);
    if (missingNote.length) fail('Keterangan selisih belum lengkap pada ' + missingNote.length + ' item.');
    await client.query("UPDATE stock_opname SET status = 'pending_approval', submitted_at = CURRENT_TIMESTAMP WHERE opname_id = $1", [id]);
    await writeAuditLog(actor.user_id, 'opname_submit: opname=' + id, ipAddress, client);
    return { opname_id: id, status: 'pending_approval' };
  });
}

// Terapkan selisih ke stok batch. delta>0 ditambahkan ke batch kedaluwarsa
// terjauh; delta<0 dikurangi mengikuti FEFO (kedaluwarsa terdekat lebih dulu).
async function applyAdjustment(client, actorId, item) {
  const delta = Number(item.physical_qty) - Number(item.system_qty);
  if (delta === 0) return 0;
  const batches = (await client.query(
    'SELECT batch_number, current_qty, expired_date FROM medicine_batches ' +
    'WHERE medicine_code = $1 ORDER BY expired_date ASC, batch_number ASC FOR UPDATE',
    [item.medicine_code])).rows;
  if (!batches.length) fail('Tidak ada batch untuk menyesuaikan stok obat ' + item.medicine_code + '.');

  if (delta > 0) {
    const target = batches[batches.length - 1];          // kedaluwarsa terjauh
    await client.query('UPDATE medicine_batches SET current_qty = current_qty + $1 WHERE batch_number = $2', [delta, target.batch_number]);
    await client.query(
      'INSERT INTO stock_transactions (medicine_code, batch_number, user_id, transaction_type, quantity, reference_number) ' +
      "VALUES ($1, $2, $3, 'ADJUSTMENT', $4, $5)",
      [item.medicine_code, target.batch_number, actorId, delta, 'OPNAME-' + item.opname_id]);
    return delta;
  }
  let remaining = -delta;                                  // jumlah yang harus dikurangi
  for (const batch of batches) {
    if (remaining === 0) break;
    const take = Math.min(Number(batch.current_qty), remaining);
    if (take <= 0) continue;
    await client.query('UPDATE medicine_batches SET current_qty = current_qty - $1 WHERE batch_number = $2', [take, batch.batch_number]);
    await client.query(
      'INSERT INTO stock_transactions (medicine_code, batch_number, user_id, transaction_type, quantity, reference_number) ' +
      "VALUES ($1, $2, $3, 'ADJUSTMENT', $4, $5)",
      [item.medicine_code, batch.batch_number, actorId, -take, 'OPNAME-' + item.opname_id]);
    remaining -= take;
  }
  if (remaining > 0) fail('Stok batch tidak cukup untuk penyesuaian negatif obat ' + item.medicine_code + '.', 409);
  return delta;
}

// Approval oleh Kepala Instalasi Farmasi: mengeksekusi penyesuaian (REQ-REP-003).
async function approveOpname(opnameId, { note } = {}, actorId, ipAddress) {
  const id = validId(opnameId);
  const verifyNote = note === undefined || note === null ? null : String(note).trim().slice(0, 255) || null;
  return withTransaction(actorId, async (client, actor) => {
    if (actor.role !== 'kepala_farmasi') fail('Persetujuan opname hanya oleh Kepala Instalasi Farmasi.', 403);
    const session = (await client.query('SELECT opname_id, status FROM stock_opname WHERE opname_id = $1 FOR UPDATE', [id])).rows[0];
    if (!session) fail('Sesi opname tidak ditemukan.', 404);
    if (session.status !== 'pending_approval') fail('Hanya sesi yang diajukan yang dapat disetujui.', 409);
    const items = (await client.query('SELECT opname_id, medicine_code, system_qty, physical_qty, note FROM stock_opname_items WHERE opname_id = $1', [id])).rows;
    let adjusted = 0;
    for (const item of items) {
      if (item.physical_qty === null || item.physical_qty === undefined) continue;
      if (await applyAdjustment(client, actor.user_id, item) !== 0) adjusted++;
    }
    await client.query(
      "UPDATE stock_opname SET status = 'approved', approved_by = $1, approved_at = CURRENT_TIMESTAMP, note = $2 WHERE opname_id = $3",
      [actor.user_id, verifyNote, id]);
    await writeAuditLog(actor.user_id, 'opname_approved: opname=' + id + ' adjusted=' + adjusted, ipAddress, client);
    return { opname_id: id, status: 'approved', adjusted };
  });
}

// Tolak sesi (tanpa penyesuaian stok).
async function rejectOpname(opnameId, { note } = {}, actorId, ipAddress) {
  const id = validId(opnameId);
  const verifyNote = note === undefined || note === null ? null : String(note).trim().slice(0, 255) || null;
  return withTransaction(actorId, async (client, actor) => {
    if (actor.role !== 'kepala_farmasi') fail('Penolakan opname hanya oleh Kepala Instalasi Farmasi.', 403);
    const session = (await client.query('SELECT opname_id, status FROM stock_opname WHERE opname_id = $1 FOR UPDATE', [id])).rows[0];
    if (!session) fail('Sesi opname tidak ditemukan.', 404);
    if (session.status !== 'pending_approval') fail('Hanya sesi yang diajukan yang dapat ditolak.', 409);
    await client.query("UPDATE stock_opname SET status = 'rejected', approved_by = $1, approved_at = CURRENT_TIMESTAMP, note = $2 WHERE opname_id = $3",
      [actor.user_id, verifyNote, id]);
    await writeAuditLog(actor.user_id, 'opname_rejected: opname=' + id, ipAddress, client);
    return { opname_id: id, status: 'rejected' };
  });
}

// Batalkan sesi yang belum final (draft / menunggu persetujuan). Sesi dihapus;
// tidak ada penyesuaian stok karena belum pernah diterapkan.
async function cancelOpname(opnameId, actorId, ipAddress) {
  const id = validId(opnameId);
  return withTransaction(actorId, async (client, actor) => {
    const session = (await client.query('SELECT opname_id, status FROM stock_opname WHERE opname_id = $1 FOR UPDATE', [id])).rows[0];
    if (!session) fail('Sesi opname tidak ditemukan.', 404);
    if (!['draft', 'pending_approval'].includes(session.status))
      fail('Hanya sesi draft atau menunggu persetujuan yang dapat dibatalkan.', 409);
    await client.query('DELETE FROM stock_opname WHERE opname_id = $1', [id]);
    await writeAuditLog(actor.user_id, 'opname_cancel: opname=' + id, ipAddress, client);
    return { opname_id: id, cancelled: true };
  });
}

module.exports = {
  OPNAME_STATUS, getValuation, getStockCard,
  createOpname, listOpname, getOpname, inputPhysical, submitOpname, approveOpname, rejectOpname, cancelOpname
};
