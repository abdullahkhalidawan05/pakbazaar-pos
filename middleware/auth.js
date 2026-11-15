const createUserClient = require('../user-client');
async function requireAuth(req, res, next) {
  res.set('Cache-Control', 'no-store');
  const match = (req.get('Authorization') || '').match(/^Bearer\s+(\S+)$/i);
  if (!match) return res.status(401).json({ error: 'Please log in to continue' });
  try {
    const db = createUserClient(match[1]);
    const { data: { user }, error: authError } = await db.auth.getUser(match[1]);
    if (authError || !user) return res.status(401).json({ error: 'Invalid or expired login. Please log in again.' });
    const { data: profile, error } = await db.from('staff_profiles')
      .select('id,name,role,is_active,shop_id').eq('id', user.id).maybeSingle();
    if (error) throw error;
    if (!profile || !profile.is_active || profile.role !== 'Admin' || !profile.shop_id) {
      return res.status(403).json({ error: 'This account does not have an active shop. Contact the system owner.' });
    }
    const { data: shop, error: shopError } = await db.from('shops')
      .select('id,name,is_active').eq('id', profile.shop_id).maybeSingle();
    if (shopError) throw shopError;
    if (!shop || !shop.is_active) return res.status(403).json({ error: 'Shop access is disabled' });
    req.db = db;
    req.user = { id: profile.id, name: profile.name, role: profile.role, shop_id: shop.id, shop_name: shop.name };
    return next();
  } catch (error) {
    console.error('Shop authentication failed:', error.message);
    return res.status(503).json({ error: 'Unable to verify shop access. Check the database setup.' });
  }
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Please log in to continue' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'You do not have permission for this action' });
    return next();
  };
}
module.exports = { requireAuth, requireRole };
