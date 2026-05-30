import { createClient } from '@supabase/supabase-js';

// Admin client — uses SERVICE KEY (server-side only, never exposed to browser)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Verify the caller is a logged-in OWNER ──────────
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  // Validate the token + check the caller's role
  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !userData?.user) return res.status(401).json({ error: 'Invalid session' });

  const { data: callerProfile } = await supabaseAdmin
    .from('admins')
    .select('role, active')
    .eq('id', userData.user.id)
    .single();

  if (!callerProfile || callerProfile.role !== 'owner' || !callerProfile.active) {
    return res.status(403).json({ error: 'Only an active owner can manage admins' });
  }

  const { action } = req.body;

  try {
    // ── CREATE ADMIN ──────────────────────────────────
    if (action === 'create') {
      const { email, password, full_name, role } = req.body;
      if (!email || !password || !full_name) {
        return res.status(400).json({ error: 'email, password and full_name are required' });
      }
      if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }
      const newRole = role === 'owner' ? 'owner' : 'agent';

      // Create the auth user (auto-confirmed so they can log in immediately)
      const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true
      });
      if (createErr) return res.status(400).json({ error: createErr.message });

      // Insert into admins table
      const { error: insErr } = await supabaseAdmin.from('admins').insert([{
        id: created.user.id,
        email,
        full_name,
        role: newRole,
        active: true
      }]);
      if (insErr) {
        // Roll back the auth user if profile insert fails
        await supabaseAdmin.auth.admin.deleteUser(created.user.id);
        return res.status(400).json({ error: insErr.message });
      }
      return res.status(200).json({ success: true, id: created.user.id });
    }

    // ── UPDATE ADMIN (role / active) ──────────────────
    if (action === 'update') {
      const { id, role, active } = req.body;
      if (!id) return res.status(400).json({ error: 'id required' });

      // Prevent owner from deactivating / demoting themselves (avoid lockout)
      if (id === userData.user.id && (active === false || role === 'agent')) {
        return res.status(400).json({ error: "You can't demote or deactivate yourself" });
      }

      const patch = {};
      if (role !== undefined) patch.role = role === 'owner' ? 'owner' : 'agent';
      if (active !== undefined) patch.active = !!active;

      const { error: updErr } = await supabaseAdmin.from('admins').update(patch).eq('id', id);
      if (updErr) return res.status(400).json({ error: updErr.message });
      return res.status(200).json({ success: true });
    }

    // ── DELETE ADMIN ──────────────────────────────────
    if (action === 'delete') {
      const { id } = req.body;
      if (!id) return res.status(400).json({ error: 'id required' });
      if (id === userData.user.id) {
        return res.status(400).json({ error: "You can't delete yourself" });
      }
      // Remove from admins table, then delete the auth user
      await supabaseAdmin.from('admins').delete().eq('id', id);
      await supabaseAdmin.auth.admin.deleteUser(id);
      return res.status(200).json({ success: true });
    }

    // ── RESET PASSWORD ────────────────────────────────
    if (action === 'reset_password') {
      const { id, password } = req.body;
      if (!id || !password) return res.status(400).json({ error: 'id and password required' });
      if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
      const { error: pwErr } = await supabaseAdmin.auth.admin.updateUserById(id, { password });
      if (pwErr) return res.status(400).json({ error: pwErr.message });
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('create-admin error:', e);
    return res.status(500).json({ error: e.message });
  }
}
