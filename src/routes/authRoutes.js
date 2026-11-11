const router = require('express').Router();
const controller = require('../controllers/authController');
const { authenticateToken } = require('../middlewares/authMiddleware');
// Tidak ada endpoint registrasi: akun staf dibuat Admin lewat POST /api/users.
router.post('/login', controller.login);
router.post('/logout', authenticateToken, controller.logout);
router.get('/me', authenticateToken, controller.getMe);
router.patch('/password', authenticateToken, controller.changePassword);
module.exports = router;
