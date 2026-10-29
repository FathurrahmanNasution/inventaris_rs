require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const authRoutes = require('./src/routes/authRoutes');
const userRoutes = require('./src/routes/userRoutes');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware global
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Routing API
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);

const viewRoutes = require('./src/routes/viewRoutes');

// Routing Web Views (HTML Dasar)
app.use('/', viewRoutes);

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('[Server Error]', err.stack);
  res.status(500).json({
    success: false,
    message: 'Terjadi kesalahan internal pada server.',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Server Backend aktif di http://localhost:${PORT}`);
  console.log(`📡 Menghubungkan ke Neon Cloud PostgreSQL...`);
  console.log(`=======================================================`);
});

module.exports = app;
