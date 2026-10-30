const bcrypt = require('bcryptjs');
const { query, pool } = require('../config/db');
const { writeAuditLog } = require('./auditService');

const ALLOWED_ROLES = ['admin', 'gudang', 'pelayanan', 'kepala_farmasi'];
const PUBLIC_FIELDS = 'user_id, username, role, status, created_at';

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}
function cleanUsername(value) {
  if (typeof value !== 'string' || !/^[a-z0-9._-]{3,50}$/.test(value.trim().toLowerCase()))
    fail('Username: 3-50 karakter berupa huruf kecil, angka, titik, garis bawah, atau tanda hubung.');
  return value.trim().toLowerCase();
}
function validateNewPassword(value) {
  if (typeof value !== 'string' || value.length < 8 || Buffer.byteLength(value) > 72 ||
      !/[a-zA-Z]/.test(value) || !/[0-9]/.test(value))
    fail('Kata sandi minimal 8 karakter, berisi huruf dan angka, dan maksimal 72 byte.');
}
function validId(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647)
    fail('ID pengguna tidak valid.');
  return Number(value);
}
async function findUserByUsername(username) {
  const name = cleanUsername(username);
  const result = await query('SELECT ' + PUBLIC_FIELDS + ', password_hash FROM users WHERE username = $1', [name]);
  return result.rows[0] || null;
}
async function findUserById(userId) {
  const result = await query('SELECT ' + PUBLIC_FIELDS + ' FROM users WHERE user_id = $1', [userId]);
  return result.rows[0] || null;
}
async function hashPassword(password) { return bcrypt.hash(password, 10); }
async function validatePassword(password, hash) {
  return typeof password === 'string' && !!hash && bcrypt.compare(password, hash);
}
async function findUserWithPasswordById(userId) {
  const result = await query('SELECT ' + PUBLIC_FIELDS + ', password_hash FROM users WHERE user_id = $1', [userId]);
  return result.rows[0] || null;
}
async function listUsers() {
  const result = await query('SELECT ' + PUBLIC_FIELDS + ' FROM users ORDER BY user_id ASC');
  return result.rows;
}
// Serialize low-volume account edits so the last-admin check and audit write are atomic.
async function accountTransaction(actorId, ipAddress, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
    const actor = (await client.query('SELECT user_id, role, status FROM users WHERE user_id = $1', [actorId])).rows[0];
    if (!actor || actor.status !== 'aktif') fail('Sesi tidak lagi aktif.', 401);
    const result = await work(client, actor);
    await writeAuditLog(actorId, result.action, ipAddress, client);
    await client.query('COMMIT');
    return result.user;
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') fail('Username sudah digunakan.', 409);
    throw error;
  } finally { client.release(); }
}
function assertAdmin(actor) { if (actor.role !== 'admin') fail('Akses khusus Administrator IT.', 403); }
async function registerUser({ username, password, confirmPassword, role }, ipAddress, actorId) {
  const name = cleanUsername(username);
  validateNewPassword(password);
  if (confirmPassword !== undefined && confirmPassword !== password) fail('Konfirmasi kata sandi tidak cocok.');
  if (!ALLOWED_ROLES.includes(role)) fail('Peran tidak valid.');
  const hash = await hashPassword(password);
  return accountTransaction(actorId, ipAddress, async (client, actor) => {
    assertAdmin(actor);
    const result = await client.query('INSERT INTO users (username, password_hash, role, status) VALUES ($1, $2, $3, \'aktif\') RETURNING ' + PUBLIC_FIELDS, [name, hash, role]);
    return { user: result.rows[0], action: 'create_user: target=' + result.rows[0].user_id + ' role=' + role };
  });
}
async function updateUser(userId, { username, role, status }, actorId, ipAddress) {
  const id = validId(userId);
  const name = cleanUsername(username);
  if (!ALLOWED_ROLES.includes(role) || !['aktif', 'nonaktif'].includes(status)) fail('Peran atau status tidak valid.');
  return accountTransaction(actorId, ipAddress, async (client, actor) => {
    assertAdmin(actor);
    const old = (await client.query('SELECT ' + PUBLIC_FIELDS + ' FROM users WHERE user_id = $1', [id])).rows[0];
    if (!old) fail('Pengguna tidak ditemukan.', 404);
    if (id === actorId && (role !== 'admin' || status !== 'aktif')) fail('Anda tidak dapat menonaktifkan atau menurunkan peran akun sendiri.');
    if (old.role === 'admin' && old.status === 'aktif' && (role !== 'admin' || status !== 'aktif')) {
      const others = await client.query("SELECT user_id FROM users WHERE role = 'admin' AND status = 'aktif' AND user_id <> $1", [id]);
      if (!others.rows.length) fail('Minimal satu Administrator IT aktif harus tersedia.');
    }
    const result = await client.query('UPDATE users SET username = $1, role = $2, status = $3 WHERE user_id = $4 RETURNING ' + PUBLIC_FIELDS, [name, role, status, id]);
    const fields = ['username', 'role', 'status'].filter(key => old[key] !== result.rows[0][key]);
    return { user: result.rows[0], action: 'update_user: target=' + id + ' fields=' + (fields.join(',') || 'none') };
  });
}
async function changePassword(userId, newPassword, actorId, ipAddress, oldPassword) {
  const id = validId(userId);
  validateNewPassword(newPassword);
  const ownChange = oldPassword !== undefined;
  if (ownChange && (id !== actorId || typeof oldPassword !== 'string')) fail('Kata sandi lama wajib diisi.');
  if (!ownChange && id === actorId) fail('Gunakan menu Ganti Kata Sandi untuk akun sendiri.');
  const hash = await hashPassword(newPassword);
  return accountTransaction(actorId, ipAddress, async (client, actor) => {
    if (!ownChange) assertAdmin(actor);
    const user = (await client.query('SELECT user_id, password_hash FROM users WHERE user_id = $1', [id])).rows[0];
    if (!user) fail('Pengguna tidak ditemukan.', 404);
    if (ownChange && !await validatePassword(oldPassword, user.password_hash)) fail('Kata sandi lama tidak sesuai.');
    await client.query('UPDATE users SET password_hash = $1 WHERE user_id = $2', [hash, id]);
    return { action: (ownChange ? 'change_password' : 'reset_password') + ': target=' + id };
  });
}
module.exports = { ALLOWED_ROLES, PUBLIC_FIELDS, fail, cleanUsername, validId,
  findUserByUsername, findUserById, findUserWithPasswordById, hashPassword, validatePassword,
  listUsers, registerUser, updateUser, changePassword };
