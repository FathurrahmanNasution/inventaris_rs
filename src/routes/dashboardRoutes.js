const router = require('express').Router();
const controller = require('../controllers/dashboardController');
const { authenticateToken } = require('../middlewares/authMiddleware');

// Ringkasan dashboard (baca saja) terbuka untuk semua peran terautentikasi.
router.get('/', authenticateToken, controller.summary);

module.exports = router;
