const dashboardService = require('../services/dashboardService');

async function summary(req, res) {
  const data = await dashboardService.getDashboard();
  res.json({ success: true, data });
}
module.exports = { summary };
