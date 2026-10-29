/**
 * =============================================================================
 * SERVICE AUTENTIKASI MODULAR - SISTEM INVENTARIS STOK OBAT RS
 * =============================================================================
 * Berisi kumpulan fungsi murni dan modular untuk register, verifikasi kredensial,
 * hashing password, penerbitan JWT, serta pencatatan audit log.
 * Dirancang agar mudah dipanggil dan dikembangkan oleh anggota tim lainnya.
 * =============================================================================
 */

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../config/db');

// Role yang diizinkan sesuai spesifikasi SRS
const ALLOWED_ROLES = ['admin', 'gudang', 'pelayanan', 'kepala_farmasi'];
const USERNAME_PATTERN = /^[a-z0-9._-]{3,50}$/;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const loginFailures = new Map();

function getLoginAttemptKey(username, ipAddress) {
  return `${ipAddress || 'unknown'}:${username}`;
}

function isLoginLocked(username, ipAddress) {
  const attempt = loginFailures.get(getLoginAttemptKey(username, ipAddress));
  if (!attempt) return false;
  if (attempt.lockedUntil > Date.now()) return true;
  loginFailures.delete(getLoginAttemptKey(username, ipAddress));
  return false;
}

function recordLoginFailure(username, ipAddress) {
  const key = getLoginAttemptKey(username, ipAddress);
  const current = loginFailures.get(key) || { count: 0, lockedUntil: 0 };
  current.count += 1;
  if (current.count >= LOGIN_FAILURE_LIMIT) {
    current.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
  }
  loginFailures.set(key, current);
}

function clearLoginFailures(username, ipAddress) {
  loginFailures.delete(getLoginAttemptKey(username, ipAddress));
}

/**
 * 1. Mengambil data user berdasarkan username
 * @param {string} username 
 * @returns {Promise<Object|null>} data user atau null jika tidak ditemukan
 */
async function findUserByUsername(username) {
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username.trim().toLowerCase())) {
    return null;
  }
  const result = await query(
    'SELECT user_id, username, password_hash, role, status, created_at FROM users WHERE username = $1',
    [username.trim().toLowerCase()]
  );
  return result.rows.length > 0 ? result.rows[0] : null;
}

/**
 * 2. Mengambil data user berdasarkan user_id
 * @param {number} userId 
 * @returns {Promise<Object|null>}
 */
async function findUserById(userId) {
  if (!userId) return null;
  const result = await query(
    'SELECT user_id, username, role, status, created_at FROM users WHERE user_id = $1',
    [userId]
  );
  return result.rows.length > 0 ? result.rows[0] : null;
}

/**
 * 3. Hashing password menggunakan bcrypt
 * @param {string} plainPassword 
 * @returns {Promise<string>} password terenkripsi
 */
async function hashPassword(plainPassword) {
  const saltRounds = 10;
  return await bcrypt.hash(plainPassword, saltRounds);
}

/**
 * 4. Memverifikasi plain password terhadap hash yang tersimpan
 * @param {string} plainPassword 
 * @param {string} passwordHash 
 * @returns {Promise<boolean>}
 */
async function validatePassword(plainPassword, passwordHash) {
  if (!plainPassword || !passwordHash) return false;
  return await bcrypt.compare(plainPassword, passwordHash);
}

/**
 * 5. Memeriksa status akun (apakah aktif)
 * @param {Object} user 
 * @returns {{ isValid: boolean, message?: string }}
 */
function checkUserStatus(user) {
  if (!user) {
    return { isValid: false, message: 'Pengguna tidak ditemukan.' };
  }
  if (user.status !== 'aktif') {
    return { isValid: false, message: 'Akun Anda dinonaktifkan. Silakan hubungi Administrator IT.' };
  }
  return { isValid: true };
}

/**
 * 6. Menerbitkan JSON Web Token (JWT) dengan masa berlaku 8 jam
 * Sesuai REQ-AUTH-003 pada SRS
 * @param {Object} payload { user_id, username, role }
 * @returns {string} token JWT
 */
function createJwtToken(payload) {
  const secret = process.env.JWT_SECRET || 'default_jwt_secret_inventory_hospital';
  const expiresIn = process.env.JWT_EXPIRES_IN || '8h';
  return jwt.sign(
    {
      user_id: payload.user_id,
      username: payload.username,
      role: payload.role
    },
    secret,
    { expiresIn }
  );
}

/**
 * 7. Memverifikasi validitas token JWT
 * @param {string} token 
 * @returns {Object|null} decoded payload jika valid
 */
function verifyJwtToken(token) {
  try {
    const secret = process.env.JWT_SECRET || 'default_jwt_secret_inventory_hospital';
    return jwt.verify(token, secret);
  } catch (err) {
    return null;
  }
}

/**
 * 8. Mencatat peristiwa keamanan/transaksi ke tabel audit_logs
 * Sesuai REQ-AUTH-007 pada SRS
 * @param {number|null} userId 
 * @param {string} action 
 * @param {string} ipAddress 
 */
async function writeAuditLog(userId, action, ipAddress = null) {
  try {
    await query(
      'INSERT INTO audit_logs (user_id, action, ip_address) VALUES ($1, $2, $3)',
      [userId || null, action, ipAddress || '127.0.0.1']
    );
  } catch (error) {
    // Audit log tidak boleh memblokir transaksi utama jika terjadi kegagalan minor
    console.error('[Audit Log Warning] Gagal mencatat log aktivitas:', error.message);
  }
}

/**
 * 9. Fungsi Alur Pendaftaran Akun (Register)
 * @param {Object} param0 { username, password, confirmPassword, role }
 * @param {string} ipAddress
 * @returns {Promise<Object>} user yang baru terdaftar
 */
async function registerUser({ username, password, confirmPassword, role }, ipAddress = null) {
  // Validasi kelengkapan input
  if (!username || !password) {
    throw new Error('Username dan password wajib diisi.');
  }

  const cleanUsername = username.trim().toLowerCase();

  if (!USERNAME_PATTERN.test(cleanUsername)) {
    throw new Error('Username hanya boleh berisi 3-50 karakter: huruf kecil, angka, titik, garis bawah, atau tanda hubung.');
  }

  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Password minimal terdiri dari 8 karakter.');
  }

  if (confirmPassword && password !== confirmPassword) {
    throw new Error('Konfirmasi password tidak cocok.');
  }

  // Validasi role yang dipilih
  const assignedRole = role || 'pelayanan';
  if (!ALLOWED_ROLES.includes(assignedRole)) {
    throw new Error(`Role tidak valid. Pilihan role: ${ALLOWED_ROLES.join(', ')}`);
  }

  // Cek apakah username sudah dipakai
  const existingUser = await findUserByUsername(cleanUsername);
  if (existingUser) {
    throw new Error(`Username "${cleanUsername}" sudah terdaftar. Gunakan username lain.`);
  }

  // Enkripsi kata sandi
  const passwordHash = await hashPassword(password);

  // Simpan record pengguna baru ke Neon DB
  const insertResult = await query(
    `INSERT INTO users (username, password_hash, role, status) 
     VALUES ($1, $2, $3, 'aktif') 
     RETURNING user_id, username, role, status, created_at`,
    [cleanUsername, passwordHash, assignedRole]
  );

  const newUser = insertResult.rows[0];

  // Catat ke audit log
  await writeAuditLog(newUser.user_id, `register_user: ${cleanUsername} (${assignedRole})`, ipAddress);

  return newUser;
}

/**
 * 10. Fungsi Alur Masuk (Login)
 * Memanfaatkan fungsi-fungsi modular di atas secara berurutan
 * @param {Object} param0 { username, password }
 * @param {string} ipAddress
 * @returns {Promise<{ user: Object, token: string }>}
 */
async function loginUser({ username, password }, ipAddress = null) {
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    throw new Error('Username dan password wajib diisi.');
  }

  const cleanUsername = username.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(cleanUsername)) {
    throw new Error('Username atau kata sandi tidak valid.');
  }
  if (isLoginLocked(cleanUsername, ipAddress)) {
    throw new Error('Terlalu banyak percobaan login. Silakan coba lagi dalam 15 menit.');
  }

  // 1. Cari data user
  const user = await findUserByUsername(cleanUsername);
  if (!user) {
    recordLoginFailure(cleanUsername, ipAddress);
    await writeAuditLog(null, `login_failed: user_not_found (${cleanUsername})`, ipAddress);
    throw new Error('Username atau kata sandi tidak valid.');
  }

  // 2. Periksa status keaktifan user
  const statusCheck = checkUserStatus(user);
  if (!statusCheck.isValid) {
    recordLoginFailure(cleanUsername, ipAddress);
    await writeAuditLog(user.user_id, `login_rejected: account_inactive (${cleanUsername})`, ipAddress);
    throw new Error(statusCheck.message);
  }

  // 3. Validasi password hash
  const isMatch = await validatePassword(password, user.password_hash);
  if (!isMatch) {
    recordLoginFailure(cleanUsername, ipAddress);
    await writeAuditLog(user.user_id, `login_failed: wrong_password (${cleanUsername})`, ipAddress);
    throw new Error('Username atau kata sandi tidak valid.');
  }

  // 4. Terbitkan JWT Token
  clearLoginFailures(cleanUsername, ipAddress);
  const token = createJwtToken(user);

  // 5. Catat log keberhasilan login
  await writeAuditLog(user.user_id, `login_success: ${cleanUsername}`, ipAddress);

  return {
    user: {
      user_id: user.user_id,
      username: user.username,
      role: user.role,
      status: user.status
    },
    token
  };
}

module.exports = {
  ALLOWED_ROLES,
  findUserByUsername,
  findUserById,
  hashPassword,
  validatePassword,
  checkUserStatus,
  createJwtToken,
  verifyJwtToken,
  writeAuditLog,
  registerUser,
  loginUser
};
