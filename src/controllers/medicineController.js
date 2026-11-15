const service = require('../services/medicineService');

async function list(req, res) {
  res.json({ success: true, data: await service.list(req.query) });
}

async function create(req, res) {
  const data = await service.create(req.body, req.user.user_id, req.ip);
  res.status(201).json({ success: true, message: 'Obat berhasil disimpan.', data });
}

async function setStatus(req, res) {
  const data = await service.setStatus(req.params.code, req.body?.is_active, req.user.user_id, req.ip);
  res.json({ success: true, message: 'Status obat berhasil diperbarui.', data });
}

async function categories(req, res) {
  res.json({ success: true, data: (await service.categories()).map(name => ({ name })) });
}

module.exports = { list, create, setStatus, categories };
