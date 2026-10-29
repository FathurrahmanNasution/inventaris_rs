const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { authenticateToken, requireRole } = require('../middlewares/authMiddleware');

/**
 * Endpoint khusus Admin IT untuk melihat daftar seluruh pengguna
 * GET /api/users
 * Memenuhi REQ-AUTH-005 dan REQ-AUTH-008
 */
router.get('/', authenticateToken, requireRole('admin'), async (req, res) => {
  try {
    const result = await query(
      'SELECT user_id, username, role, status, created_at FROM users ORDER BY user_id ASC'
    );
    return res.status(200).json({
      success: true,
      data: {
        users: result.rows
      }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

module.exports = router;
