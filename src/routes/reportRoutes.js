const router = require('express').Router();
const controller = require('../controllers/reportController');
const { authenticateToken, requireRole } = require('../middlewares/authMiddleware');

const operational = requireRole('gudang', 'pelayanan', 'kepala_farmasi');
router.use(authenticateToken);

// Laporan (baca) terbuka untuk semua peran terautentikasi.
router.get('/valuation', controller.valuation);
router.get('/stock-card', controller.stockCard);

// Stock opname: aksi fisik oleh peran operasional (Admin IT dikecualikan, SoD).
router.get('/opname', controller.listOpname);
router.get('/opname/:opnameId', controller.getOpname);
router.post('/opname', operational, controller.createOpname);
router.patch('/opname/:opnameId/items', operational, controller.inputPhysical);
router.post('/opname/:opnameId/submit', operational, controller.submitOpname);
router.post('/opname/:opnameId/cancel', operational, controller.cancelOpname);

// Persetujuan/penolakan hanya Kepala Instalasi Farmasi (REQ-REP-003).
router.post('/opname/:opnameId/approve', requireRole('kepala_farmasi'), controller.approveOpname);
router.post('/opname/:opnameId/reject', requireRole('kepala_farmasi'), controller.rejectOpname);

module.exports = router;
