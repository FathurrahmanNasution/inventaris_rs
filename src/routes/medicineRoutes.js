const router = require('express').Router();
const controller = require('../controllers/medicineController');
const { authenticateToken, requireRole } = require('../middlewares/authMiddleware');

router.use(authenticateToken);
router.get('/', controller.list);
router.post('/', requireRole('kepala_farmasi'), controller.create);
router.patch('/:code/status', requireRole('kepala_farmasi'), controller.setStatus);

module.exports = router;