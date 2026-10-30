require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const { protectWrites } = require('./src/middlewares/authMiddleware');
require('./src/services/authService').jwtSecret();

const authRoutes = require('./src/routes/authRoutes');
const userRoutes = require('./src/routes/userRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware global
app.disable('x-powered-by');
app.use('/api', protectWrites);
app.use(express.json({ limit: '16kb' }));
app.use(cookieParser());

// Routing API
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/audit-logs', require('./src/routes/auditRoutes'));

const viewRoutes = require('./src/routes/viewRoutes');

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

if (require.main === module) app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Server Backend aktif di http://localhost:${PORT}`);
  console.log(`📡 Menghubungkan ke Neon Cloud PostgreSQL...`);
  console.log(`=======================================================`);
});

module.exports = app;
