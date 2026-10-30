const { query } = require('../config/db');

async function writeAuditLog(userId, action, ipAddress = null, client = { query }) {
  await client.query('INSERT INTO audit_logs (user_id, action, ip_address, created_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)',
    [userId || null, action, ipAddress]);
}
async function listAuditLogs({ search = '', page = '1' } = {}) {
  if (typeof search !== 'string' || search.length > 100 || typeof page !== 'string' ||
      !/^[1-9]\d*$/.test(page) || Number(page) > 100000) {
    const error = new Error('Filter log tidak valid.');
    error.status = 400;
    throw error;
  }
  const result = await query('SELECT a.log_id, a.user_id, u.username, a.action, a.ip_address, a.created_at ' +
    'FROM audit_logs a LEFT JOIN users u ON u.user_id = a.user_id ' +
    "WHERE ($1 = '' OR a.action ILIKE $2 OR u.username ILIKE $2 OR a.ip_address::text ILIKE $2) " +
    'ORDER BY a.created_at DESC, a.log_id DESC LIMIT 51 OFFSET $3',
    [search, '%' + search.replace(/[\\%_]/g, '\\$&') + '%', (Number(page) - 1) * 50]);
  return { logs: result.rows.slice(0, 50), page: Number(page), hasMore: result.rows.length > 50 };
}
module.exports = { writeAuditLog, listAuditLogs };
