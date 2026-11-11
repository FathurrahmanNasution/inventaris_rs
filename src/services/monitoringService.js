// Monitoring Stok Minimum & Kedaluwarsa (REQ-ADM-ALERT-001 s/d 003).
// Read-only: memindai medicine_batches + medicines dan mengklasifikasikan status
// warna (merah/kuning/hijau) tanpa menulis data operasional.
const { query } = require('../config/db');
const { writeAuditLog } = require('./auditService');

const EXPIRY_CRITICAL_DAYS = 30;   // <= 30 hari  -> Kritis (Merah)
const EXPIRY_WARNING_DAYS = 90;    // 31-90 hari  -> Perhatian (Kuning), > 90 -> Aman (Hijau)
const ALERT_FILTERS = ['all', 'critical', 'warning'];
const ACTION_TYPES = { retur: 'retur', distribusi: 'distribusi' };

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}
// Klasifikasi status batch berdasarkan sisa hari menuju kedaluwarsa.
function classifyExpiry(days) {
  if (days <= EXPIRY_CRITICAL_DAYS) return 'critical';
  if (days <= EXPIRY_WARNING_DAYS) return 'warning';
  return 'safe';
}

// Ambil semua batch bersisa stok beserta sisa hari (dihitung di PostgreSQL agar
// konsisten dengan tanggal server). Hanya batch <= 90 hari yang menjadi alert.
async function getExpiryAlerts(filter = 'all') {
  const key = ALERT_FILTERS.includes(filter) ? filter : 'all';
  const result = await query(
    'SELECT b.batch_number, b.medicine_code, b.current_qty, b.expired_date, b.supplier, ' +
    'm.name, m.unit, (b.expired_date - CURRENT_DATE) AS days_remaining ' +
    'FROM medicine_batches b JOIN medicines m ON m.medicine_code = b.medicine_code ' +
    'WHERE b.current_qty > 0 ORDER BY b.expired_date ASC, b.batch_number ASC');

  const alerts = [];
  for (const row of result.rows) {
    const days = Number(row.days_remaining);
    const status = classifyExpiry(days);
    if (status === 'safe') continue;                       // > 90 hari bukan alert
    alerts.push({
      medicine_code: row.medicine_code, name: row.name, batch_number: row.batch_number,
      supplier: row.supplier, unit: row.unit, current_qty: Number(row.current_qty),
      expired_date: row.expired_date, days_remaining: days, status
    });
  }
  const summary = {
    all: alerts.length,
    critical: alerts.filter(a => a.status === 'critical').length,
    warning: alerts.filter(a => a.status === 'warning').length
  };
  const filtered = key === 'all' ? alerts : alerts.filter(a => a.status === key);
  return { alerts: filtered, summary, filter: key };
}

// Obat yang total stok (semua batch) berada pada atau di bawah ambang minimum.
async function getLowStock() {
  const result = await query(
    'SELECT m.medicine_code, m.name, m.unit, m.min_stock, ' +
    'COALESCE(SUM(b.current_qty), 0) AS total_stock ' +
    'FROM medicines m LEFT JOIN medicine_batches b ON b.medicine_code = m.medicine_code ' +
    "WHERE m.status = 'aktif' " +
    'GROUP BY m.medicine_code, m.name, m.unit, m.min_stock ' +
    'HAVING COALESCE(SUM(b.current_qty), 0) <= m.min_stock ' +
    'ORDER BY (COALESCE(SUM(b.current_qty), 0) - m.min_stock) ASC, m.name ASC');
  return result.rows.map(row => ({
    medicine_code: row.medicine_code, name: row.name, unit: row.unit,
    total_stock: Number(row.total_stock), min_stock: Number(row.min_stock),
    status: Number(row.total_stock) === 0 ? 'habis' : 'menipis'
  }));
}

// Ringkasan angka untuk kartu dashboard/monitoring.
async function getSummary() {
  const [expiry, lowStock] = await Promise.all([getExpiryAlerts('all'), getLowStock()]);
  return {
    expiring_critical: expiry.summary.critical,
    expiring_warning: expiry.summary.warning,
    expiring_total: expiry.summary.all,
    low_stock: lowStock.length,
    out_of_stock: lowStock.filter(m => m.status === 'habis').length
  };
}

// Tindak lanjut alert (Ajukan Retur / Distribusi Cepat). Tidak ada tabel retur
// khusus dalam lingkup ini, sehingga aksi dicatat ke audit trail sebagai jejak.
async function recordAction({ batchNumber, action }, actorId, ipAddress) {
  if (typeof batchNumber !== 'string' || !/^.{1,100}$/.test(batchNumber.trim()))
    fail('Nomor batch tidak valid.');
  if (!ACTION_TYPES[action]) fail('Jenis tindakan tidak valid (retur atau distribusi).');
  const batch = batchNumber.trim();
  const found = await query('SELECT batch_number FROM medicine_batches WHERE batch_number = $1', [batch]);
  if (!found.rows.length) fail('Batch tidak ditemukan.', 404);
  const logAction = ('monitoring_' + action + ': batch=' + batch).slice(0, 100); // batas audit_logs.action
  await writeAuditLog(actorId, logAction, ipAddress);
  return { batch_number: batch, action };
}

module.exports = {
  EXPIRY_CRITICAL_DAYS, EXPIRY_WARNING_DAYS, ALERT_FILTERS, classifyExpiry,
  getExpiryAlerts, getLowStock, getSummary, recordAction
};
