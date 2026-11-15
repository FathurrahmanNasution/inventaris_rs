const router = require('express').Router();
const controller = require('../controllers/medicineController');
const { authenticateToken } = require('../middlewares/authMiddleware');

router.get('/', authenticateToken, controller.categories);

module.exports = router;