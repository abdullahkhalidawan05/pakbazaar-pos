const createUserClient = require('../user-client');
async function requireAuth(req, res, next) {
  res.set('Cache-Control', 'no-store');
  const match = (req.get('Authorization') || '').match(/^Bearer\s+(\S+)$/i);
  if (!match) return res.status(401).json({ error: 'Please log in to continue' });
  try {
    const db = createUserClient(match[1]);
    // Both services independently validate the same JWT. RLS restricts the profile
    // read to the current shop owner; no unverified user ID is taken from the body.
    // Nothing is used until getUser has verified identity and the IDs match below.
    const [identity, profileResult] = await Promise.all([
      db.auth.getUser(match[1]),
      db.from('staff_profiles')
        .select('id,name,role,is_active,shop_id,shop:shops!staff_profiles_shop_id_fkey(id,name,is_active,owner_id)')
        .maybeSingle()
    ]);
    const user = identity.data?.user;
    if (identity.error || !user) return res.status(401).json({ error: 'Invalid or expired login. Please log in again.' });
    const { data: profile, error } = profileResult;
    if (error) throw error;
    if (!profile || profile.id !== user.id || !profile.is_active || profile.role !== 'Admin' || !profile.shop_id) {
      return res.status(403).json({ error: 'This account does not have an active shop. Contact the system owner.' });
    }
    const shop = profile.shop;
    if (!shop || shop.id !== profile.shop_id || shop.owner_id !== user.id || !shop.is_active) {
      return res.status(403).json({ error: 'Shop access is disabled' });
    }
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
