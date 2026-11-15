// Entry point Vercel Function. Seluruh request (halaman dan /api/*) diarahkan ke sini
// oleh rewrite di vercel.json, lalu ditangani aplikasi Express yang sama dengan lokal.
// `npm start` tetap memakai server.js secara langsung.
module.exports = require('../server');
