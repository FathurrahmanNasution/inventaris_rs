const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { authenticateToken } = require('../middlewares/authMiddleware');

// Route registrasi pengguna baru
router.post('/register', authController.register);

// Route masuk / login
router.post('/login', authController.login);

// Route keluar / logout
router.post('/logout', authController.logout);

// Route cek profil user saat ini (perlu autentikasi)
router.get('/me', authenticateToken, authController.getMe);

module.exports = router;
