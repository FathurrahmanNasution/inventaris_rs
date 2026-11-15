// Dashboard Visualisasi & Statistik Real-Time (REQ-DASH-001 s/d 004).
// Read-only: mengagregasi data dari modul monitoring dan laporan, ditambah
// tren pengeluaran, transaksi terakhir, dan komposisi stok per kategori.
const { query } = require('../config/db');
const monitoringService = require('./monitoringService');
const reportService = require('./reportService');

const TREND_MONTHS = 6;
const RECENT_LIMIT = 5;
const ALERT_LIMIT = 6;
const CATEGORY_LIMIT = 4;   // kategori terbesar ditampilkan, sisanya digabung "Lainnya"
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

// Daftar 6 bulan terakhir (termasuk bulan berjalan) dalam format 'YYYY-MM'.
function lastMonths(today, count = TREND_MONTHS) {
  const [year, month] = today.split('-').map(Number);
  const months = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(year, month - 1 - i, 1));
    months.push(d.toISOString().slice(0, 7));
  }
  return months;
}

// REQ-DASH-004: total pengeluaran (OUT) per bulan, bulan tanpa transaksi bernilai 0.
async function getMonthlyOut() {
  const today = (await query('SELECT CURRENT_DATE::text AS today')).rows[0].today;
  const months = lastMonths(today);
  const result = await query(
    "SELECT to_char(transaction_date, 'YYYY-MM') AS month, COALESCE(SUM(quantity), 0) AS qty " +
    "FROM stock_transactions WHERE transaction_type = 'OUT' AND transaction_date >= $1::date " +
    'GROUP BY 1 ORDER BY 1', [months[0] + '-01']);
  const totals = new Map(result.rows.map(row => [row.month, Number(row.qty)]));
  return months.map(key => ({ key, month: MONTH_NAMES[Number(key.slice(5)) - 1], qty: totals.get(key) || 0 }));
}

async function getRecentTransactions() {
  const result = await query(
    'SELECT t.transaction_id, t.created_at, t.reference_number, t.transaction_type, t.quantity, ' +
    'm.name AS medicine_name, m.unit ' +
    'FROM stock_transactions t JOIN medicines m ON m.medicine_code = t.medicine_code ' +
    'ORDER BY t.created_at DESC, t.transaction_id DESC LIMIT $1', [RECENT_LIMIT]);
  return result.rows.map(row => ({
    created_at: row.created_at, reference_number: row.reference_number, type: row.transaction_type,
    quantity: Number(row.quantity), medicine_name: row.medicine_name, unit: row.unit
  }));
}

// Komposisi stok fisik (jumlah unit) per kategori obat aktif, dalam persen.
async function getCategoryShare() {
  const result = await query(
    'SELECT m.category, COALESCE(SUM(b.current_qty), 0) AS qty ' +
    'FROM medicines m LEFT JOIN medicine_batches b ON b.medicine_code = m.medicine_code ' +
    "WHERE m.status = 'aktif' GROUP BY m.category ORDER BY qty DESC, m.category ASC");
  const rows = result.rows.map(row => ({ name: row.category, qty: Number(row.qty) })).filter(row => row.qty > 0);
  const total = rows.reduce((sum, row) => sum + row.qty, 0);
  if (!total) return [];
  const top = rows.slice(0, CATEGORY_LIMIT);
  const rest = rows.slice(CATEGORY_LIMIT).reduce((sum, row) => sum + row.qty, 0);
  if (rest) top.push({ name: 'Lainnya', qty: rest });
  return top.map(row => ({ name: row.name, qty: row.qty, percent: Math.round((row.qty / total) * 100) }));
}

function buildAlerts(critical, lowStock) {
  const expiry = critical.map(a => ({
    name: a.name, kind: 'expiry', level: 'red', batch_number: a.batch_number,
    detail: 'Batch ' + a.batch_number + ' | ' + (a.days_remaining < 0
      ? 'lewat ' + Math.abs(a.days_remaining) + ' hari' : a.days_remaining + ' hari lagi') + ' | sisa ' + a.current_qty + ' ' + a.unit
  }));
  const stock = lowStock.map(m => ({
    name: m.name, kind: 'stock', level: m.status === 'habis' ? 'red' : 'orange', medicine_code: m.medicine_code,
    detail: (m.status === 'habis' ? 'Stok habis' : 'Stok ' + m.total_stock + ' ' + m.unit) + ' | batas minimum ' + m.min_stock
  }));
  // Sisakan tempat untuk stok menipis agar tidak tertutup oleh alert kedaluwarsa.
  const stockTake = Math.min(stock.length, Math.max(ALERT_LIMIT - expiry.length, Math.floor(ALERT_LIMIT / 2)));
  return [...expiry.slice(0, ALERT_LIMIT - stockTake), ...stock.slice(0, stockTake)];
}

async function getDashboard() {
  const [valuation, expiry, lowStock, monthlyOut, recentTransactions, categoryShare] = await Promise.all([
    reportService.getValuation(), monitoringService.getExpiryAlerts('critical'), monitoringService.getLowStock(),
    getMonthlyOut(), getRecentTransactions(), getCategoryShare()
  ]);
  return {
    totalMedicines: valuation.item_count,          // REQ-DASH-001
    assetValue: valuation.grand_total,             // REQ-DASH-002
    lowStock: lowStock.length,                     // REQ-DASH-003
    nearExpiry: expiry.summary.critical,           // batch <= 30 hari (REQ-ADM-ALERT-001)
    monthlyOut,                                    // REQ-DASH-004
    alerts: buildAlerts(expiry.alerts, lowStock),
    recentTransactions,
    categoryShare
  };
}

module.exports = { getDashboard, lastMonths, TREND_MONTHS };
