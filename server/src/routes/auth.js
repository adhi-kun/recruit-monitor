import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { findUserByEmail, createUser, validatePassword } from '../db/database.js';

const router = Router();

// ── Rate Limiters ────────────────────────────────────────────────────

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max: 10,                      // 10 attempts per window per IP
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,                       // 5 registrations per window per IP
  message: { error: 'Too many registration attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── POST /auth/register ──────────────────────────────────────────────

router.post('/register', registerLimiter, async (req, res) => {
  try {
    const { name, email, password, confirmPassword, role } = req.body;

    // Basic presence checks
    if (!name || !email || !password || !role) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    // Confirm password match
    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    // Password policy check (server-side enforcement)
    const passwordError = validatePassword(password);
    if (passwordError) {
      return res.status(400).json({ error: passwordError });
    }

    // Create user (handles email validation, normalization, duplicate check, hashing)
    const user = await createUser({ name, email, password, role });

    // Auto-login: issue JWT with the same payload shape
    const token = jwt.sign(
      {
        userId: user.userId,
        email: user.email,
        role: user.role,
        name: user.name,
      },
      config.jwtSecret,
      { expiresIn: '8h' }
    );

    res.status(201).json({
      token,
      user: {
        userId: user.userId,
        email: user.email,
        role: user.role,
        name: user.name,
      },
    });
  } catch (err) {
    // Handle structured errors from createUser
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /auth/login ─────────────────────────────────────────────────

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // findUserByEmail normalizes the email internally
    const user = findUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: user.role,
        name: user.name,
      },
      config.jwtSecret,
      { expiresIn: '8h' }
    );

    res.json({
      token,
      user: {
        userId: user.id,
        email: user.email,
        role: user.role,
        name: user.name,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /auth/me ─────────────────────────────────────────────────────

router.get('/me', requireAuth, (req, res) => {
  res.json(req.user);
});

export default router;
