const { Pool } = require('pg');
require('dotenv').config();

if (!process.env.DATABASE_URL || process.env.DATABASE_URL.trim() === '') {
  throw new Error('[Database Error FATAL] DATABASE_URL tidak ditemukan di file .env! Harap setel koneksi Neon DB Anda.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL.trim(),
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.on('error', (err) => {
  // pg removes failed idle clients. Never log raw errors containing connection details.
  console.error('[Database Error] Koneksi idle PostgreSQL terputus:', err.code || err.name);
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
