const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { rateLimit } = require('express-rate-limit');
const { requireAuth, requireRole } = require('../middleware/auth');
const supabase = require('../supabase');

const router = express.Router();

if (!process.env.SUPABASE_PUBLISHABLE_KEY) {
  throw new Error('Missing SUPABASE_PUBLISHABLE_KEY in .env');
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {
    error: 'Too many login attempts. Try again in 15 minutes.'
  }
});

router.post('/login', loginLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');

  const { email, password } = req.body || {};

  if (
    typeof email !== 'string' ||
    typeof password !== 'string' ||
    !email.trim() ||
    !password ||
    email.length > 254 ||
    password.length > 1024
  ) {
    return res.status(400).json({
      error: 'A valid email and password are required'
    });
  }

  try {
    // A separate client for each login prevents shared user sessions.
    const authClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_PUBLISHABLE_KEY,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false
        }
      }
    );

    const { data, error } =
      await authClient.auth.signInWithPassword({
        email: email.trim(),
        password
      });

    if (error || !data.user || !data.session) {
      return res.status(401).json({
        error: 'Invalid email or password'
      });
    }

    const { data: profile, error: profileError } = await supabase
      .from('staff_profiles')
      .select('id, name, role, is_active')
      .eq('id', data.user.id)
      .maybeSingle();

    if (profileError) {
      throw profileError;
    }

    if (!profile || !profile.is_active) {
      return res.status(403).json({
        error: 'Staff access is not enabled for this account'
      });
    }

    return res.json({
      message: 'Login successful',
      access_token: data.session.access_token,
      expires_at: data.session.expires_at,
      user: {
        id: profile.id,
        name: profile.name,
        role: profile.role
      }
    });
  } catch (error) {
    console.error('Login failed:', error.message);

    return res.status(500).json({
      error: 'Unable to complete login'
    });
  }
});

module.exports = router;
router.get('/me', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');

  res.json({
    user: req.user
  });
});

router.get(
  '/admin-check',
  requireAuth,
  requireRole('Admin'),
  (req, res) => {
    res.set('Cache-Control', 'no-store');

    res.json({
      message: 'Admin access confirmed'
    });
  }
);