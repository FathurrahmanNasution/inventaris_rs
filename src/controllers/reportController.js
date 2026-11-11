const reportService = require('../services/reportService');

async function valuation(req, res) {
  res.json({ success: true, data: await reportService.getValuation() });
}
async function stockCard(req, res) {
  const data = await reportService.getStockCard({
    medicineCode: req.query.medicine_code, from: req.query.from, to: req.query.to });
  res.json({ success: true, data });
}
async function createOpname(req, res) {
  const data = await reportService.createOpname(
    { referenceNumber: req.body?.referenceNumber ?? req.body?.reference_number }, req.user.user_id, req.ip);
  res.status(201).json({ success: true, message: 'Sesi opname dibuat.', data });
}
async function listOpname(req, res) {
  res.json({ success: true, data: { sessions: await reportService.listOpname() } });
}
async function getOpname(req, res) {
  res.json({ success: true, data: await reportService.getOpname(req.params.opnameId) });
}
async function inputPhysical(req, res) {
  const data = await reportService.inputPhysical(req.params.opnameId, req.body || {}, req.user.user_id, req.ip);
  res.json({ success: true, message: 'Stok fisik tersimpan.', data });
}
async function submitOpname(req, res) {
  const data = await reportService.submitOpname(req.params.opnameId, req.user.user_id, req.ip);
  res.json({ success: true, message: 'Sesi opname diajukan untuk persetujuan.', data });
}
async function approveOpname(req, res) {
  const data = await reportService.approveOpname(req.params.opnameId, req.body || {}, req.user.user_id, req.ip);
  res.json({ success: true, message: 'Opname disetujui dan penyesuaian stok diterapkan.', data });
}
async function rejectOpname(req, res) {
  const data = await reportService.rejectOpname(req.params.opnameId, req.body || {}, req.user.user_id, req.ip);
  res.json({ success: true, message: 'Sesi opname ditolak.', data });
}
async function cancelOpname(req, res) {
  const data = await reportService.cancelOpname(req.params.opnameId, req.user.user_id, req.ip);
  res.json({ success: true, message: 'Sesi opname dibatalkan.', data });
}
module.exports = {
  valuation, stockCard, createOpname, listOpname, getOpname,
  inputPhysical, submitOpname, approveOpname, rejectOpname, cancelOpname
};
