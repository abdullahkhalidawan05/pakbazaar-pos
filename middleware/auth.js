const supabase = require('../supabase');

async function requireAuth(req, res, next) {
  const authorization = req.get('Authorization') || '';
  const match = authorization.match(/^Bearer\s+(\S+)$/i);

  if (!match) {
    return res.status(401).json({
      error: 'Please log in to continue'
    });
  }

  try {
    const token = match[1];

    const {
      data: { user },
      error: authError
    } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return res.status(401).json({
        error: 'Invalid or expired login. Please log in again.'
      });
    }

    const { data: profile, error: profileError } = await supabase
      .from('staff_profiles')
      .select('id, name, role, is_active')
      .eq('id', user.id)
      .maybeSingle();

    if (profileError) {
      throw profileError;
    }

    if (!profile || !profile.is_active) {
      return res.status(403).json({
        error: 'Your staff account does not have access'
      });
    }

    req.user = {
      id: profile.id,
      name: profile.name,
      role: profile.role
    };

    next();
  } catch (error) {
    console.error('Authentication check failed:', error.message);

    return res.status(503).json({
      error: 'Unable to verify access. Try again shortly.'
    });
  }
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Please log in to continue'
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'You do not have permission for this action'
      });
    }

    next();
  };
}

module.exports = { requireAuth, requireRole };