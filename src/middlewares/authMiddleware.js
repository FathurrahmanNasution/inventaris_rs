const { verifyJwtToken, getSessionUser } = require('../services/authService');
async function authenticateToken(req, res, next) {
  const header = req.get('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : req.cookies?.token;
  const user = token && await getSessionUser(verifyJwtToken(token));
  res.set('Cache-Control', 'no-store');
  if (!user) {
    if (!req.originalUrl.startsWith('/api/') && req.method === 'GET' && req.accepts('html')) return res.redirect('/login');
    return res.status(401).json({ success: false, message: 'Sesi tidak valid atau telah berakhir. Silakan login kembali.' });
  }
  req.user = user;
  next();
}
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role))
      return res.status(403).json({ success: false, message: 'Akses khusus Administrator IT.' });
    next();
  };
}
// JSON-only writes and same-origin validation protect cookie-authenticated operations from CSRF.
function protectWrites(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  let foreignOrigin = false;
  try {
    const origin = req.get('origin');
    foreignOrigin = !!origin && new URL(origin).origin !== (process.env.APP_ORIGIN || req.protocol + '://' + req.get('host'));
  } catch { foreignOrigin = true; }
  if (foreignOrigin || req.get('sec-fetch-site') === 'cross-site')
    return res.status(403).json({ success: false, message: 'Permintaan harus berasal dari aplikasi ini.' });
  if (!req.is('application/json'))
    return res.status(415).json({ success: false, message: 'Gunakan Content-Type application/json.' });
  next();
}
module.exports = { authenticateToken, requireRole, protectWrites };
