const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const serveView = (fileName, fallbackTitle) => (req, res) => {
  const filePath = path.join(__dirname, '../../views', fileName);
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }
  return res.status(200).send(`
    <!DOCTYPE html>
    <html lang="id">
    <head>
      <meta charset="UTF-8">
      <title>${fallbackTitle || 'Halaman Sedang Dikembangkan'}</title>
      <style>
        body { font-family: Arial, sans-serif; background: #f8fafc; color: #1e293b; margin: 50px 20px; text-align: center; }
        .card { max-width: 500px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.06); }
        h2 { color: #0284c7; margin-top: 0; }
        p { color: #64748b; line-height: 1.5; }
        a { display: inline-block; margin-top: 15px; color: #0284c7; text-decoration: none; font-weight: bold; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>🚧 ${fallbackTitle || 'Halaman Sedang Dikembangkan'}</h2>
        <p>Halaman ini telah disiapkan untuk dikembangkan lebih lanjut oleh rekan tim pengembang.</p>
        <p style="font-size: 13px; color: #94a3b8;">Backend API tetap aktif dan siap menerima request di <code>/api/auth/login</code> dan <code>/api/users</code>.</p>
        <a href="/">&larr; Kembali ke Beranda</a>
      </div>
    </body>
    </html>
  `);
};

// 1. Homepage (Tetap dipertahankan)
router.get('/', serveView('home.html', 'Homepage'));

// 2. Register Page (Tetap dipertahankan)
router.get('/register', serveView('register.html', 'Halaman Register'));

// 3. Login Page
router.get('/login', serveView('login.html', 'Halaman Login'));

// 4. Dashboard Page (Tetap dipertahankan)
router.get('/dashboard', serveView('dashboard.html', 'Halaman Dashboard'));

// 5. Admin Page (Placeholder handover untuk tim frontend admin)
router.get('/admin', serveView('admin.html', 'Halaman Admin'));
router.get('/admin/users', serveView('admin.html', 'Halaman Admin'));

module.exports = router;
