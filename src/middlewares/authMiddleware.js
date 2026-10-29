const { verifyJwtToken } = require('../services/authService');

/**
 * Middleware untuk memverifikasi autentikasi JWT token
 * Mendukung pembacaan token dari Authorization Header (Bearer token)
 * maupun dari HTTP cookie (memudahkan pengetesan via browser).
 */
function authenticateToken(req, res, next) {
  let token = null;

  // 1. Ambil dari header Authorization
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }

  // 2. Fallback: ambil dari cookies jika ada
  if (!token && req.cookies && req.cookies.token) {
    token = req.cookies.token;
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Akses ditolak. Token autentikasi tidak ditemukan.'
    });
  }

  const decoded = verifyJwtToken(token);
  if (!decoded) {
    return res.status(403).json({
      success: false,
      message: 'Token tidak valid atau telah kedaluwarsa. Silakan login kembali.'
    });
  }

  req.user = decoded;
  next();
}

/**
 * Middleware untuk otorisasi berbasis peran (Role-Based Access Control)
 * Sesuai REQ-AUTH-005 pada SRS
 * @param  {...string} allowedRoles daftar role yang diperbolehkan
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Pengguna belum terautentikasi.'
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Akses ditolak. Fitur ini memerlukan salah satu hak akses: [${allowedRoles.join(', ')}]. Peran Anda saat ini: "${req.user.role}".`
      });
    }

    next();
  };
}

module.exports = {
  authenticateToken,
  requireRole
};
