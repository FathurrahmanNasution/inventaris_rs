const service = require('../services/medicineService');

async function list(req, res) {
  res.json({ success: true, data: await service.list(req.query) });
}

async function create(req, res) {
  res.status(201).json({ success: true, message: 'Obat berhasil disimpan.', data: await service.create(req.body) });
}

async function setStatus(req, res) {
  const data = await service.setStatus(req.params.code, req.body?.is_active);
  res.json({ success: true, message: 'Status obat berhasil diperbarui.', data });
}

async function categories(req, res) {
  res.json({ success: true, data: service.CATEGORIES.map(name => ({ name })) });
}

module.exports = { list, create, setStatus, categories };