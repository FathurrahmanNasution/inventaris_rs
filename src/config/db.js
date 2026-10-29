const { Pool } = require('pg');
require('dotenv').config();

if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === '') {
  throw new Error('[Database Error FATAL] DATABASE_URL tidak ditemukan di file .env! Harap setel koneksi Neon DB Anda.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL.trim(),
  ssl: {
    rejectUnauthorized: false
  }
});

pool.on('connect', () => {
  console.log('[Database] Sukses: Terhubung langsung ke Neon PostgreSQL Cloud.');
});

pool.on('error', (err) => {
  console.error('[Database Error FATAL] Kesalahan koneksi PostgreSQL:', err);
});

/**
 * Eksekusi query langsung ke database PostgreSQL
 * Melempar error murni jika terjadi kegagalan (Fail-Fast)
 */
const query = async (text, params = []) => {
  return await pool.query(text, params);
};

module.exports = {
  pool,
  query
};
