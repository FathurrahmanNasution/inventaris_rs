const authService = require('../services/authService');
const userService = require('../services/userService');
const auditService = require('../services/auditService');
const cookieOptions = () => ({ httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' });
async function login(req, res) {
  const { user, token } = await authService.loginUser(req.body || {}, req.ip);
  // "Ingat saya" tidak dicentang (remember: false) -> cookie sesi browser, hilang saat browser ditutup.
  // JWT tetap kedaluwarsa maksimal 8 jam (REQ-AUTH-003) pada kedua pilihan.
  const remember = req.body?.remember !== false;
  res.cookie('token', token, remember ? { ...cookieOptions(), maxAge: authService.SESSION_SECONDS * 1000 } : cookieOptions());
  res.json({ success: true, message: 'Login berhasil.', data: { user } });
}
async function logout(req, res) {
  await auditService.writeAuditLog(req.user.user_id, 'logout', req.ip);
  res.clearCookie('token', cookieOptions());
  res.json({ success: true, message: 'Logout berhasil.' });
}
async function getMe(req, res) { res.json({ success: true, data: { user: req.user } }); }
async function changePassword(req, res) {
  const { oldPassword, newPassword } = req.body || {};
  if (typeof oldPassword !== 'string' || !oldPassword)
    return res.status(400).json({ success: false, message: 'Kata sandi lama wajib diisi.' });
  await userService.changePassword(req.user.user_id, newPassword, req.user.user_id, req.ip, oldPassword);
  res.clearCookie('token', cookieOptions());
  res.json({ success: true, message: 'Kata sandi berhasil diubah. Silakan login kembali.' });
}
module.exports = { login, logout, getMe, changePassword };
