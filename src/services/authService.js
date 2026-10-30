const jwt = require('jsonwebtoken');
const { createHmac, timingSafeEqual } = require('crypto');
const { writeAuditLog } = require('./auditService');
const { ALLOWED_ROLES, PUBLIC_FIELDS, fail, cleanUsername, validId, findUserByUsername,
  findUserById, findUserWithPasswordById, hashPassword, validatePassword, registerUser,
  updateUser, changePassword } = require('./userService');

const SESSION_SECONDS = 8 * 60 * 60;
const failures = new Map();
const LOCK_MS = 15 * 60 * 1000;

function jwtSecret() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)
    throw new Error('JWT_SECRET wajib dikonfigurasi dengan minimal 32 karakter.');
  return process.env.JWT_SECRET;
}
function checkUserStatus(user) {
  return { isValid: !!user && user.status === 'aktif', message: 'Username atau kata sandi tidak valid.' };
}
// Bind sessions to the stored password without exposing the bcrypt hash in JWT claims.
function credentialTag(hash) { return createHmac('sha256', jwtSecret()).update(hash).digest('hex'); }
function createJwtToken(user) {
  return jwt.sign({ user_id: user.user_id, role: user.role, credential: credentialTag(user.password_hash) },
    jwtSecret(), { algorithm: 'HS256', expiresIn: SESSION_SECONDS });
}
function verifyJwtToken(token) {
  try { return jwt.verify(token, jwtSecret(), { algorithms: ['HS256'], maxAge: SESSION_SECONDS }); }
  catch { return null; }
}
async function getSessionUser(decoded) {
  if (!decoded || !Number.isInteger(decoded.user_id) || typeof decoded.credential !== 'string') return null;
  const user = await findUserWithPasswordById(decoded.user_id);
  if (!user || user.status !== 'aktif') return null;
  const actual = Buffer.from(credentialTag(user.password_hash));
  const supplied = Buffer.from(decoded.credential);
  if (actual.length !== supplied.length || !timingSafeEqual(actual, supplied)) return null;
  delete user.password_hash;
  return user;
}
function keys(username, ip) { return ['user:' + username, 'ip:' + (ip || 'unknown')]; }
function isLoginLocked(username, ip) {
  const now = Date.now();
  for (const [key, value] of failures) if (value.expiresAt <= now) failures.delete(key);
  return keys(username, ip).some(key => (failures.get(key)?.count || 0) >= 5);
}
function recordFailure(username, ip) {
  for (const key of keys(username, ip)) {
    const current = failures.get(key) || { count: 0, expiresAt: Date.now() + LOCK_MS };
    current.count++;
    if (current.count === 5) current.expiresAt = Date.now() + LOCK_MS;
    failures.set(key, current);
  }
}
async function loginUser({ username, password }, ipAddress = null) {
  const name = cleanUsername(username);
  if (typeof password !== 'string' || !password || Buffer.byteLength(password) > 72) fail('Username atau kata sandi tidak valid.', 401);
  if (isLoginLocked(name, ipAddress)) fail('Terlalu banyak percobaan login. Coba lagi dalam 15 menit.', 429);
  const user = await findUserByUsername(name);
  if (!checkUserStatus(user).isValid || !await validatePassword(password, user.password_hash)) {
    recordFailure(name, ipAddress);
    await writeAuditLog(user?.user_id, 'login_failed: username=' + name, ipAddress);
    fail('Username atau kata sandi tidak valid.', 401);
  }
  for (const key of keys(name, ipAddress)) failures.delete(key);
  const token = createJwtToken(user);
  await writeAuditLog(user.user_id, 'login_success', ipAddress);
  delete user.password_hash;
  return { user, token };
}
// Preserve existing service imports; account/audit implementations live in their own services.
module.exports = { ALLOWED_ROLES, PUBLIC_FIELDS, SESSION_SECONDS, jwtSecret,
  findUserByUsername, findUserById, hashPassword, validatePassword, checkUserStatus,
  createJwtToken, verifyJwtToken, getSessionUser, writeAuditLog, registerUser, updateUser,
  changePassword, loginUser, validId };
