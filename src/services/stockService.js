const { randomUUID } = require('crypto');
const { pool, query } = require('../config/db');
const repository = require('../repositories/stockRepository');
const validation = require('../validations/stockValidation');
const { writeAuditLog } = require('./auditService');
const { fail } = validation;
const ROLES = { IN: ['gudang', 'kepala_farmasi'], OUT: ['pelayanan', 'kepala_farmasi'] };

async function transact(type, payload, userId, ip) {
  const body = validation.validate(payload, type);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const actor = await repository.actor(client, userId);
    if (!actor || actor.status !== 'aktif') fail('Sesi tidak lagi aktif.', 401);
    if (!ROLES[type].includes(actor.role)) fail('Peran Anda tidak diizinkan melakukan transaksi ini.', 403);
    // Lock medicine rows in a stable order: concurrent IN/OUT serialize per medicine.
    const medicines = new Map();
    for (const code of [...new Set(body.items.map(i => i.medicine_code))].sort()) {
      const medicine = await repository.medicine(client, code);
      if (!medicine) fail('Obat tidak ditemukan: ' + code, 404);
      if (medicine.status !== 'aktif') fail('Obat tidak aktif: ' + code, 409);
      medicines.set(code, medicine);
    }
    const day = await repository.today(client);
    const transactionDay = type === 'IN' ? body.received_date : day;
    if (transactionDay > day) fail('Tanggal terima tidak boleh di masa depan.');
    if (type === 'IN' && body.items.some(i => i.expired_date <= day || i.expired_date <= transactionDay))
      fail('Tanggal kedaluwarsa harus setelah hari ini dan tanggal transaksi.');
    const doc = await repository.createDocument(client, randomUUID(), type, body, transactionDay, userId);
    const entries = [];
    for (const item of body.items) {
      const medicine = medicines.get(item.medicine_code);
      if (type === 'IN') {
        await repository.insertBatch(client, item, body.supplier);
        const tx = await repository.insertTransaction(client, doc, item, userId);
        entries.push({ ...tx, expired_date: item.expired_date, medicine_name: medicine.name, unit: medicine.unit });
      } else {
        const batches = await repository.batches(client, item.medicine_code, day, true);
        const total = batches.reduce((sum, b) => sum + Number(b.current_qty), 0);
        if (total < item.quantity) fail('Stok layak keluar tidak mencukupi untuk ' + item.medicine_code + '. Tersedia: ' + total + '.', 409);
        let remaining = item.quantity;
        for (const batch of batches) {
          if (!remaining) break;
          const quantity = Math.min(remaining, Number(batch.current_qty));
          if (!await repository.deduct(client, batch.batch_number, quantity)) fail('Stok berubah, silakan ulangi transaksi.', 409);
          const tx = await repository.insertTransaction(client, doc, { medicine_code: item.medicine_code, batch_number: batch.batch_number, quantity }, userId);
          entries.push({ ...tx, expired_date: batch.expired_date, medicine_name: medicine.name, unit: medicine.unit });
          remaining -= quantity;
        }
      }
    }
    await writeAuditLog(userId, 'stock_' + type.toLowerCase() + ': document=' + doc.document_id + ' entries=' + entries.length, ip, client);
    await client.query('COMMIT');
    return { ...doc, username: actor.username, items: entries };
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505' && error.constraint === 'medicine_batches_pkey') fail('Nomor batch sudah digunakan. Nomor batch harus unik secara global.', 409);
    if (['40P01', '40001'].includes(error.code)) fail('Transaksi bersamaan terdeteksi. Silakan ulangi.', 409);
    throw error;
  } finally { client.release(); }
}
async function getReceipt(id) {
  const result = await repository.receipt(validation.documentId(id));
  if (!result) fail('Bukti transaksi tidak ditemukan.', 404);
  return result;
}
async function getBatches(code) {
  const medicineCode = validation.text(code, 'Kode obat', 50);
  const exists = (await query('SELECT medicine_code FROM medicines WHERE medicine_code = $1', [medicineCode])).rows[0];
  if (!exists) fail('Obat tidak ditemukan.', 404);
  return repository.batches({ query }, medicineCode, await repository.today({ query }));
}
module.exports = { ROLES, stockIn: (body, userId, ip) => transact('IN', body, userId, ip),
  stockOut: (body, userId, ip) => transact('OUT', body, userId, ip), getReceipt, getBatches,
  recent: value => repository.recent(validation.limit(value, 5, 100)),
  medicines: value => repository.medicines(validation.limit(value, 500)) };
