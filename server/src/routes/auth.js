import express from 'express';
import rateLimit from 'express-rate-limit';
import { supabaseAuth } from '../lib/supabase.js';
import { requireAuth } from '../middleware/authMiddleware.js';
import { generateToken } from '../utils/generateToken.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many registration attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const VALID_ROLES = new Set(['interviewer', 'supervisor']);

function normalizeRegistrationInput(body) {
  return {
    name: String(body?.name || '').trim(),
    email: String(body?.email || '').trim().toLowerCase(),
    password: String(body?.password || ''),
    confirmPassword: body?.confirmPassword == null ? null : String(body.confirmPassword),
    role: String(body?.role || '').trim().toLowerCase(),
  };
}

function validateRegistration({ name, email, password, confirmPassword, role }) {
  if (!name || !email || !password || !role) {
    return 'Name, email, password, and role are required';
  }
  if (name.length < 2 || name.length > 100) {
    return 'Name must be between 2 and 100 characters';
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return 'Please enter a valid email address';
  }
  if (password.length < 8) {
    return 'Password must be at least 8 characters';
  }
  if (confirmPassword != null && password !== confirmPassword) {
    return 'Passwords do not match';
  }
  if (!VALID_ROLES.has(role)) {
    return 'Invalid role';
  }
  return null;
}

function mapSupabaseSignupError(error) {
  const message = String(error?.message || '').toLowerCase();
  if (message.includes('already') || message.includes('registered') || message.includes('exists')) {
    return { status: 409, error: 'An account with this email already exists' };
  }
  if (message.includes('password')) {
    return { status: 400, error: 'Password does not meet security requirements' };
  }
  if (message.includes('email')) {
    return { status: 400, error: 'Please enter a valid email address' };
  }
  return { status: 400, error: 'Registration failed. Please check your details and try again.' };
}

function buildAuthResponse({ supabaseUser, role, name }) {
  const token = generateToken({
    userId: supabaseUser.id,
    email: supabaseUser.email,
    role,
    name,
  });

  return {
    success: true,
    token,
    user: {
      id: supabaseUser.id,
      email: supabaseUser.email,
      role,
      name,
    },
  };
}

router.post('/register', registerLimiter, async (req, res) => {
  const input = normalizeRegistrationInput(req.body);
  const validationError = validateRegistration(input);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  try {
    const { data, error } = await supabaseAuth.auth.signUp({
      email: input.email,
      password: input.password,
      options: {
        data: {
          role: input.role,
          name: input.name,
        },
      },
    });

    if (error) {
      const mapped = mapSupabaseSignupError(error);
      logger.warn('registration failed', { reason: error.name || 'supabase_error' });
      return res.status(mapped.status).json({ error: mapped.error });
    }

    const supabaseUser = data?.user;
    if (!supabaseUser?.id || !supabaseUser?.email) {
      logger.warn('registration failed - missing user');
      return res.status(502).json({ error: 'Registration service unavailable' });
    }

    if (Array.isArray(supabaseUser.identities) && supabaseUser.identities.length === 0) {
      logger.warn('registration rejected - duplicate email');
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    logger.info('registration successful', { role: input.role });
    return res.status(201).json(buildAuthResponse({
      supabaseUser,
      role: input.role,
      name: input.name,
    }));
  } catch (err) {
    logger.error('registration error', { reason: err.message });
    return res.status(500).json({ error: 'Registration service unavailable' });
  }
});

router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const normalizedEmail = String(email).trim().toLowerCase();
    const { data, error } = await supabaseAuth.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    });

    if (error || !data?.user) {
      logger.warn('login failed');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const supabaseUser = data.user;
    const role = supabaseUser.user_metadata?.role;
    const name = supabaseUser.user_metadata?.name;

    if (!role || !['interviewer', 'supervisor'].includes(role)) {
      logger.warn('login rejected - no valid role');
      return res.status(403).json({ error: 'Access denied. Your account does not have platform access.' });
    }

    const resolvedName = name || normalizedEmail.split('@')[0];

    logger.info('login successful', { role });

    return res.json(buildAuthResponse({ supabaseUser, role, name: resolvedName }));
  } catch (err) {
    logger.error('login error', { reason: err.message });
    return res.status(500).json({ error: 'Authentication service unavailable' });
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json(req.user);
});

export default router;
