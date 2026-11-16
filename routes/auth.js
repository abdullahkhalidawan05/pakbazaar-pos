const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { rateLimit } = require('express-rate-limit');
const { requireAuth, requireRole } = require('../middleware/auth');
const createUserClient = require('../user-client');

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

    const shopClient = createUserClient(data.session.access_token);
    const { data: profile, error: profileError } = await shopClient
      .from('staff_profiles')
      .select('id, name, role, is_active, shop_id')
      .eq('id', data.user.id)
      .maybeSingle();

    if (profileError) {
      throw profileError;
    }

    if (!profile || !profile.is_active || profile.role !== 'Admin' || !profile.shop_id) {
      return res.status(403).json({
        error: 'This account does not have an active shop. Contact the system owner.'
      });
    }

    return res.json({
      message: 'Login successful',
      access_token: data.session.access_token,
      expires_at: data.session.expires_at,
      user: {
        id: profile.id,
        name: profile.name,
        role: profile.role,
        shop_id: profile.shop_id
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
// Signed-in users may change only their own password.
// Account-based throttling is best effort per server instance; Supabase also rate-limits Auth.
const passwordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: req => req.user.id,
  message: { error: 'Too many password-change attempts. Try again in 15 minutes.' }
});

router.post('/change-password', requireAuth, passwordLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const body = req.body || {};
  const allowed = ['current_password', 'new_password', 'confirm_password'];
  if (typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !allowed.includes(key)) ||
      typeof body.current_password !== 'string' || !body.current_password || body.current_password.length > 1024 ||
      typeof body.new_password !== 'string' || body.new_password.length < 12 || body.new_password.length > 128 ||
      typeof body.confirm_password !== 'string') {
    return res.status(400).json({ error: 'Enter your current password and a new password of 12 to 128 characters.' });
  }
  if (body.new_password !== body.confirm_password) return res.status(400).json({ error: 'The new passwords do not match.' });
  if (body.new_password === body.current_password) return res.status(400).json({ error: 'Choose a password different from your current password.' });

  let passwordClient;
  let changed = false;
  try {
    const token = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: identity, error: identityError } = await req.db.auth.getUser(token);
    if (identityError || !identity?.user || identity.user.id !== req.user.id) {
      return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    }
    if (!identity.user.email) return res.status(400).json({ error: 'This account does not have an email/password login.' });

    passwordClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });
    const { data: verified, error: verifyError } = await passwordClient.auth.signInWithPassword({
      email: identity.user.email,
      password: body.current_password
    });
    if (verifyError) {
      if (verifyError.status === 429 || verifyError.code === 'over_request_rate_limit') {
        return res.status(429).json({ error: 'Too many attempts. Please wait before trying again.' });
      }
      if (verifyError.code === 'invalid_credentials' || verifyError.status === 400) {
        return res.status(400).json({ error: 'Your current password is incorrect.' });
      }
      return res.status(503).json({ error: 'Unable to verify your current password. Try again shortly.' });
    }
    if (!verified?.user || !verified.session || verified.user.id !== req.user.id) {
      return res.status(403).json({ error: 'Unable to confirm ownership of this account.' });
    }

    // Pass current_password too, so Supabase's own current-password policy is respected.
    // The fresh session also satisfies the standard recent-login requirement.
    const { data: updated, error: updateError } = await passwordClient.auth.updateUser({
      password: body.new_password,
      current_password: body.current_password
    });
    if (updateError) {
      if (updateError.code === 'weak_password') return res.status(400).json({ error: updateError.message || 'Choose a stronger password.' });
      if (updateError.code === 'same_password') return res.status(400).json({ error: 'Choose a different new password.' });
      if (['reauthentication_needed', 'reauthentication_not_valid', 'insufficient_aal'].includes(updateError.code)) {
        return res.status(403).json({ error: 'Additional account verification is required. Sign in again and retry.' });
      }
      if (updateError.status === 429) return res.status(429).json({ error: 'Too many attempts. Please wait before trying again.' });
      console.error('Password update rejected:', updateError.code || 'unknown');
      return res.status(503).json({ error: 'Unable to change the password. Try again shortly.' });
    }
    // A successful provider response is the commit point. Do not report a failed
    // password update merely because subsequent session cleanup fails.
    changed = true;
    if (updated?.user?.id !== req.user.id) console.error('Password change returned an unexpected user identity');
    try {
      const { error } = await passwordClient.auth.signOut({ scope: 'global' });
      if (error) console.error('Password changed; session cleanup failed:', error.code || 'unknown');
    } catch {
      console.error('Password changed; session cleanup unavailable');
    }
    return res.json({ message: 'Password changed successfully. Sign in again with your new password.', sign_in_required: true });
  } catch {
    // Never log the request body, credentials, tokens or provider error objects.
    console.error('Password change request failed');
    return res.status(503).json({ error: 'Unable to change the password. Try again shortly.' });
  } finally {
    if (passwordClient && !changed) {
      try { await passwordClient.auth.signOut({ scope: 'local' }); } catch { /* best-effort temporary-session cleanup */ }
    }
  }
});
