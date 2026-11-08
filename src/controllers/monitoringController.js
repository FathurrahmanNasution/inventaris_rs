const monitoringService = require('../services/monitoringService');

async function expiryAlerts(req, res) {
  const data = await monitoringService.getExpiryAlerts(req.query.filter);
  res.json({ success: true, data });
}
async function lowStock(req, res) {
  const items = await monitoringService.getLowStock();
  res.json({ success: true, data: { items, count: items.length } });
}
async function summary(req, res) {
  const data = await monitoringService.getSummary();
  res.json({ success: true, data });
}
async function action(req, res) {
  const { batchNumber, batch_number, action } = req.body || {};
  const result = await monitoringService.recordAction(
    { batchNumber: batchNumber ?? batch_number, action }, req.user.user_id, req.ip);
  res.json({ success: true, message: 'Tindakan monitoring berhasil dicatat.', data: result });
}
module.exports = { expiryAlerts, lowStock, summary, action };
