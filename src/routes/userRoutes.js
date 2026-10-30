const router = require('express').Router();
const controller = require('../controllers/userController');
const { authenticateToken, requireRole } = require('../middlewares/authMiddleware');
router.use(authenticateToken, requireRole('admin'));
router.get('/', controller.listUsers);
router.post('/', controller.createUser);
router.patch('/:userId', controller.updateUser);
router.post('/:userId/reset-password', controller.resetPassword);
module.exports = router;
