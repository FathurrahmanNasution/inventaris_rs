const router = require('express').Router();
const controller = require('../controllers/auditController');
const { authenticateToken, requireRole } = require('../middlewares/authMiddleware');
router.use(authenticateToken, requireRole('admin'));
router.get('/', controller.listAuditLogs);
module.exports = router;
