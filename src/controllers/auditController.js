const auditService = require('../services/auditService');

async function listAuditLogs(req, res) {
  const data = await auditService.listAuditLogs(req.query);
  res.json({ success: true, data });
}
module.exports = { listAuditLogs };
