const { createClient } = require('@supabase/supabase-js');
// Never reuse a session-bearing client between HTTP requests.
module.exports = function createUserClient(token) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_PUBLISHABLE_KEY) {
    throw new Error('Missing Supabase URL or publishable key');
  }
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
};
