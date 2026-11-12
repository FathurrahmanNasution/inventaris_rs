const db = require('../config/db');

const today = async client => (await client.query("SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date::text AS today")).rows[0].today;
const actor = async (client, id) => (await client.query('SELECT user_id, username, role, status FROM users WHERE user_id = $1 FOR SHARE', [id])).rows[0];
const medicine = async (client, code) => (await client.query('SELECT medicine_code, name, unit, status FROM medicines WHERE medicine_code = $1 FOR UPDATE', [code])).rows[0];
async function batches(client, code, day, lock = false) {
  return (await client.query('SELECT batch_number, medicine_code, current_qty, expired_date::text FROM medicine_batches ' +
    'WHERE medicine_code = $1 AND current_qty > 0 AND expired_date > $2::date ' +
    'ORDER BY expired_date ASC, batch_number ASC' + (lock ? ' FOR UPDATE' : ''), [code, day])).rows;
}
async function createDocument(client, id, type, body, day, userId) {
  return (await client.query('INSERT INTO stock_documents (document_id, transaction_type, reference_number, transaction_date, supplier, destination, notes, user_id) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *, transaction_date::text',
  [id, type, body.reference_number, day, body.supplier || null, body.destination || null, body.notes, userId])).rows[0];
}
async function insertBatch(client, item, supplier) {
  await client.query('INSERT INTO medicine_batches (batch_number, medicine_code, current_qty, expired_date, supplier) VALUES ($1,$2,$3,$4,$5)',
    [item.batch_number, item.medicine_code, item.quantity, item.expired_date, supplier]);
}
async function deduct(client, batch, qty) {
  return (await client.query('UPDATE medicine_batches SET current_qty = current_qty - $1 WHERE batch_number = $2 AND current_qty >= $1 RETURNING current_qty', [qty, batch])).rows[0];
}
async function insertTransaction(client, doc, item, userId) {
  return (await client.query('INSERT INTO stock_transactions (medicine_code, batch_number, user_id, transaction_type, quantity, reference_number, transaction_date, document_id, unit_price) ' +
    'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING transaction_id, medicine_code, batch_number, transaction_type, quantity, reference_number, transaction_date::text, unit_price',
  [item.medicine_code, item.batch_number, userId, doc.transaction_type, item.quantity, doc.reference_number, doc.transaction_date, doc.document_id, item.unit_price ?? null])).rows[0];
}
async function receipt(id) {
  const doc = (await db.query('SELECT d.*, d.transaction_date::text, u.username FROM stock_documents d LEFT JOIN users u ON u.user_id = d.user_id WHERE d.document_id = $1', [id])).rows[0];
  if (!doc) return null;
  const items = (await db.query('SELECT t.transaction_id, t.medicine_code, m.name AS medicine_name, m.unit, t.batch_number, b.expired_date::text, t.quantity, t.unit_price ' +
    'FROM stock_transactions t JOIN medicines m ON m.medicine_code = t.medicine_code JOIN medicine_batches b ON b.batch_number = t.batch_number ' +
    'WHERE t.document_id = $1 ORDER BY t.transaction_id ASC', [id])).rows;
  return { ...doc, items };
}
async function recent(limit) {
  return (await db.query('SELECT t.document_id, t.transaction_id, t.transaction_date::text AS received_date, t.reference_number, b.supplier, m.name AS medicine_name, m.unit, t.batch_number, t.quantity ' +
    'FROM stock_transactions t JOIN medicine_batches b ON b.batch_number = t.batch_number JOIN medicines m ON m.medicine_code = t.medicine_code ' +
    "WHERE t.transaction_type = 'IN' ORDER BY t.transaction_date DESC, t.transaction_id DESC LIMIT $1", [limit])).rows;
}
async function medicines(limit) {
  return (await db.query('SELECT m.medicine_code, m.name, m.category, m.unit, m.price, m.min_stock, ' +
    "COALESCE(SUM(b.current_qty) FILTER (WHERE b.expired_date > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date), 0)::text AS total_stock " +
    "FROM medicines m LEFT JOIN medicine_batches b ON b.medicine_code = m.medicine_code WHERE m.status = 'aktif' " +
    'GROUP BY m.medicine_code ORDER BY m.name ASC, m.medicine_code ASC LIMIT $1', [limit])).rows;
}
module.exports = { today, actor, medicine, batches, createDocument, insertBatch, deduct, insertTransaction, receipt, recent, medicines };
