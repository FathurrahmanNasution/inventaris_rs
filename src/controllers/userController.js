const userService = require('../services/userService');

async function listUsers(req, res) {
  const users = await userService.listUsers();
  res.json({ success: true, data: { users } });
}
async function createUser(req, res) {
  const user = await userService.registerUser(req.body || {}, req.ip, req.user.user_id);
  res.status(201).json({ success: true, message: 'Pengguna berhasil ditambahkan.', data: { user } });
}
async function updateUser(req, res) {
  const user = await userService.updateUser(req.params.userId, req.body || {}, req.user.user_id, req.ip);
  res.json({ success: true, message: 'Pengguna berhasil diperbarui.', data: { user } });
}
async function resetPassword(req, res) {
  await userService.changePassword(req.params.userId, req.body?.newPassword, req.user.user_id, req.ip);
  res.json({ success: true, message: 'Kata sandi direset. Sesi lama pengguna tidak berlaku lagi.' });
}
module.exports = { listUsers, createUser, updateUser, resetPassword };
