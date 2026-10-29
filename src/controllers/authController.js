const authService = require('../services/authService');

/**
 * Controller untuk menangani request Register
 * POST /api/auth/register
 */
async function register(req, res) {
  try {
    const { username, password, confirmPassword, role } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;

    const newUser = await authService.registerUser(
      { username, password, confirmPassword, role },
      ipAddress
    );

    return res.status(201).json({
      success: true,
      message: 'Registrasi pengguna berhasil diselesaikan.',
      data: {
        user: newUser
      }
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message
    });
  }
}

/**
 * Controller untuk menangani request Login
 * POST /api/auth/login
 */
async function login(req, res) {
  try {
    const { username, password } = req.body;
    const ipAddress = req.ip || req.connection.remoteAddress;

    const { user, token } = await authService.loginUser(
      { username, password },
      ipAddress
    );

    // Simpan token di cookie HttpOnly agar tidak dapat dibaca JavaScript.
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 8 * 60 * 60 * 1000, // 8 jam
      sameSite: 'lax',
      path: '/'
    });

    return res.status(200).json({
      success: true,
      message: 'Login berhasil.',
      data: {
        user
      }
    });
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: error.message
    });
  }
}

/**
 * Controller untuk menangani Logout
 * POST /api/auth/logout
 */
async function logout(req, res) {
  res.clearCookie('token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/'
  });
  return res.status(200).json({
    success: true,
    message: 'Logout berhasil. Sesi telah diakhiri.'
  });
}

/**
 * Controller untuk mendapatkan profil pengguna saat ini
 * GET /api/auth/me
 */
async function getMe(req, res) {
  try {
    const user = await authService.findUserById(req.user.user_id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'Pengguna tidak ditemukan.'
      });
    }

    return res.status(200).json({
      success: true,
      data: { user }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
}

module.exports = {
  register,
  login,
  logout,
  getMe
};
