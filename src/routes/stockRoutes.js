const router = require('express').Router();
const controller = require('../controllers/stockController');
const { authenticateToken, requireRole } = require('../middlewares/authMiddleware');
const { ROLES } = require('../services/stockService');
router.use(authenticateToken);
router.post('/in', requireRole(...ROLES.IN), controller.stockIn);
router.post('/out', requireRole(...ROLES.OUT), controller.stockOut);
router.get('/receipts', controller.recent);
router.get('/documents/:documentId', controller.receipt);
router.get('/history', controller.history);
// Read-only lookups owned by stock; master-data write APIs stay with their module.
router.get('/medicines', controller.medicines);
router.get('/medicines/:medicineCode/batches', controller.batches);
module.exports = router;
