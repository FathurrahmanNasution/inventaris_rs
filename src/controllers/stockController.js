const service = require('../services/stockService');
const report = require('../services/reportService');

const stockIn = async (req, res) => res.status(201).json({ success: true, message: 'Penerimaan tersimpan.', data: await service.stockIn(req.body, req.user.user_id, req.ip) });
const stockOut = async (req, res) => res.status(201).json({ success: true, message: 'Pengeluaran tersimpan.', data: await service.stockOut(req.body, req.user.user_id, req.ip) });
const receipt = async (req, res) => res.json({ success: true, data: await service.getReceipt(req.params.documentId) });
const recent = async (req, res) => res.json({ success: true, data: await service.recent(req.query.limit) });
const medicines = async (req, res) => res.json({ success: true, data: { data: await service.medicines(req.query.limit) } });
const batches = async (req, res) => res.json({ success: true, data: await service.getBatches(req.params.medicineCode) });
const history = async (req, res) => res.json({ success: true, data: await report.getStockCard({ medicineCode: req.query.medicine_code, from: req.query.from, to: req.query.to }) });
module.exports = { stockIn, stockOut, receipt, recent, medicines, batches, history };
