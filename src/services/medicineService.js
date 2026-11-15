const { query } = require('../config/db');

const CATEGORIES = [
  'Antibiotik', 'Analgesik', 'Antihipertensi', 'Antidiabetes',
  'Antasida', 'Analgesik Injeksi', 'Lainnya'
];
const UNITS = ['Tablet', 'Kapsul', 'Botol/Sirup', 'Ampul', 'Vial', 'Strip', 'Box'];
const FILTERS = ['aman', 'menipis', 'kritis', 'nonaktif', 'expiring', 'low'];
const MAX_LIMIT = 100;

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function requiredText(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength)
    fail(`${label} wajib diisi dan maksimal ${maxLength} karakter.`);
  return value.trim();
}

function nonNegativeNumber(value, label, integer = false) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isFinite(number) || number < 0 || (integer && !Number.isInteger(number)))
    fail(`${label} harus berupa angka ${integer ? 'bulat ' : ''}nol atau lebih.`);
  return number;
}

function pageNumber(value, fallback, label) {
  if (value === undefined || value === '') return fallback;
  if (!/^[1-9]\d*$/.test(String(value)) || Number(value) > 100000) fail(`${label} tidak valid.`);
  return Number(value);
}

function searchPattern(value) {
  return '%' + value.trim().replace(/[\\%_]/g, '\\$&') + '%';
}

async function list({ search = '', category = '', filter = '', active, page = '1', limit = '20' } = {}) {
  if (typeof search !== 'string' || search.length > 100) fail('Pencarian tidak valid.');
  if (typeof category !== 'string' || category.length > 100) fail('Kategori tidak valid.');
  if (filter && !FILTERS.includes(filter)) fail('Filter obat tidak valid.');

  const currentPage = pageNumber(page, 1, 'Halaman');
  const pageSize = pageNumber(limit, 20, 'Batas data');
  if (pageSize > MAX_LIMIT) fail(`Batas data maksimal ${MAX_LIMIT}.`);

  const params = [];
  const conditions = [];
  if (search.trim()) {
    params.push(searchPattern(search));
    conditions.push(`(medicine_code ILIKE $${params.length} ESCAPE '\\' OR name ILIKE $${params.length} ESCAPE '\\')`);
  }
  if (category) {
    params.push(category);
    conditions.push(`category = $${params.length}`);
  }
  if (active === '1') conditions.push('is_active');

  if (filter === 'nonaktif') conditions.push('NOT is_active');
  if (filter === 'expiring') conditions.push('is_active AND days IS NOT NULL AND days <= 30');
  if (filter === 'low') conditions.push('is_active AND total_stock <= min_stock');
  if (filter === 'aman') conditions.push('is_active AND total_stock > min_stock');
  if (filter === 'menipis') conditions.push('is_active AND total_stock > min_stock * 0.5 AND total_stock <= min_stock');
  if (filter === 'kritis') conditions.push('is_active AND (total_stock <= 0 OR total_stock <= min_stock * 0.5)');

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  params.push(pageSize, (currentPage - 1) * pageSize);
  const result = await query(
    `WITH inventory AS (
       SELECT m.medicine_code, m.name, m.category, m.unit, m.price, m.min_stock,
              (m.status = 'aktif') AS is_active,
              COALESCE(SUM(b.current_qty), 0)::int AS total_stock,
              MIN(b.expired_date - CURRENT_DATE) FILTER (WHERE b.current_qty > 0) AS days
       FROM medicines m
       LEFT JOIN medicine_batches b ON b.medicine_code = m.medicine_code
       GROUP BY m.medicine_code, m.name, m.category, m.unit, m.price, m.min_stock, m.status
     )
     SELECT medicine_code, name, category, unit, price, min_stock, total_stock, is_active, days,
            COUNT(*) OVER()::int AS total
     FROM inventory
     ${where}
     ORDER BY name ASC, medicine_code ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return {
    data: result.rows.map(row => ({
      medicine_code: row.medicine_code,
      name: row.name,
      category: row.category,
      unit: row.unit,
      price: Number(row.price),
      min_stock: Number(row.min_stock),
      total_stock: Number(row.total_stock),
      is_active: row.is_active,
      days: row.days === null ? null : Number(row.days)
    })),
    total: result.rows.length ? Number(result.rows[0].total) : 0
  };
}

async function create(body = {}) {
  const medicineCode = requiredText(body.medicine_code, 'Kode obat', 50).toUpperCase();
  const name = requiredText(body.name, 'Nama obat', 255);
  const category = requiredText(body.category, 'Kategori', 100);
  const unit = requiredText(body.unit, 'Satuan', 50);
  if (!CATEGORIES.includes(category)) fail('Kategori obat tidak tersedia.');
  if (!UNITS.includes(unit)) fail('Satuan obat tidak tersedia.');
  const minStock = nonNegativeNumber(body.min_stock, 'Batas minimum stok', true);
  const price = nonNegativeNumber(body.price, 'Harga satuan');
  try {
    const result = await query(
      'INSERT INTO medicines (medicine_code, name, category, unit, price, min_stock, status) ' +
      "VALUES ($1, $2, $3, $4, $5, $6, 'aktif') " +
      'RETURNING medicine_code, name, category, unit, price, min_stock, status',
      [medicineCode, name, category, unit, price, minStock]
    );
    const row = result.rows[0];
    return {
      medicine_code: row.medicine_code, name: row.name, category: row.category,
      unit: row.unit, price: Number(row.price), min_stock: Number(row.min_stock),
      total_stock: 0, is_active: true, days: null
    };
  } catch (error) {
    if (error.code === '23505') fail('Kode obat sudah digunakan.', 409);
    throw error;
  }
}

async function setStatus(code, isActive) {
  const medicineCode = requiredText(code, 'Kode obat', 50);
  if (typeof isActive !== 'boolean') fail('Status aktif harus berupa boolean.');
  const result = await query(
    "UPDATE medicines SET status = CASE WHEN $1 THEN 'aktif' ELSE 'nonaktif' END " +
    'WHERE medicine_code = $2 RETURNING medicine_code, status',
    [isActive, medicineCode]
  );
  if (!result.rows.length) fail('Obat tidak ditemukan.', 404);
  return { medicine_code: result.rows[0].medicine_code, is_active: result.rows[0].status === 'aktif' };
}

module.exports = {
  CATEGORIES,
  UNITS,
  list,
  create,
  setStatus
};