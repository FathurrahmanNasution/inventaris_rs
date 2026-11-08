const router = require('express').Router();
const controller = require('../controllers/monitoringController');
const { authenticateToken, requireRole } = require('../middlewares/authMiddleware');

router.use(authenticateToken);
// Pembacaan monitoring terbuka untuk semua peran terautentikasi.
router.get('/expiry', controller.expiryAlerts);
router.get('/low-stock', controller.lowStock);
router.get('/summary', controller.summary);
// Tindak lanjut (retur/distribusi) adalah aksi operasional, bukan untuk Admin IT (SoD).
router.post('/action', requireRole('gudang', 'pelayanan', 'kepala_farmasi'), controller.action);

module.exports = router;
