require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const { protectWrites } = require('./src/middlewares/authMiddleware');
require('./src/services/authService').jwtSecret();

const authRoutes = require('./src/routes/authRoutes');
const userRoutes = require('./src/routes/userRoutes');

const app = express();
const PORT = process.env.PORT || 3000;
const db = require('./src/config/db');

// Middleware global
app.disable('x-powered-by');
app.use('/api', protectWrites);
app.use(express.json({ limit: '16kb' }));
app.use(cookieParser());

// Routing API
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/audit-logs', require('./src/routes/auditRoutes'));
app.use('/api/monitoring', require('./src/routes/monitoringRoutes'));
app.use('/api/laporan', require('./src/routes/reportRoutes'));
app.use('/api/stock', require('./src/routes/stockRoutes'));

const viewRoutes = require('./src/routes/viewRoutes');

const path = require('path');

app.use('/images', express.static(path.join(__dirname, 'images')));

// Routing Web Views (HTML Dasar)
app.use('/', viewRoutes);

// Global Error Handler
app.use((err, req, res, next) => {
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error('[Server Error]', err.code || err.name);
  res.status(status).json({
    success: false,
    message: status === 500 ? 'Terjadi kesalahan internal pada server.' :
      err.type === 'entity.parse.failed' ? 'JSON tidak valid.' : err.message
  });
});

async function start() {
  const started = Date.now();
  console.log('Menghubungkan ke Neon Cloud PostgreSQL... (timeout koneksi 10s, query 15s)');
  try {
    // Reuse the pool; scope the read timeout to readiness so stock transaction
    // clients keep their existing commit/rollback behavior.
    await db.query({ text: 'SELECT 1', query_timeout: 15000 });
    console.log(`[Database] Siap: SELECT 1 berhasil (${Date.now() - started} ms).`);
    return await new Promise((resolve, reject) => {
      const server = app.listen(PORT, () => {
        console.log(`Server Backend aktif di http://localhost:${server.address().port}`);
        resolve(server);
      });
      server.once('error', reject);
    });
  } catch (error) {
    const code = error.code || error.cause?.code ||
      (/timeout|timed out/i.test(error.message) ? 'DB_TIMEOUT' : 'STARTUP_FAILED');
    console.error(`[Startup Error] ${code}: backend gagal dimulai setelah ${Date.now() - started} ms.`);
    await db.pool.end();
    throw error;
  }
}

if (require.main === module) start().catch(() => { process.exitCode = 1; });

module.exports = app;
module.exports.start = start;
