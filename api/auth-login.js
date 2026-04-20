// Mesmo handler de netlify/functions/auth-login.js, mas no formato
// (req, res) usado na pasta /api. Deploy em Vercel usa esta versão;
// Netlify usa a outra.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET;
const ALLOWED_ORIGIN = process.env.SB_PROXY_ALLOWED_ORIGIN || '*';

async function sbAuth(path, body) {
  if (!SUPABASE_URL || !SUPABASE_ANON) throw Object.assign(new Error('auth não configurado'), { statusCode: 500 });
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/,'')}${path}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data?.msg || data?.error_description || data?.error || text.slice(0, 200);
    throw Object.assign(new Error(msg), { statusCode: res.status });
  }
  return data;
}

async function fetchProfile(userId) {
  if (!SERVICE_KEY) return null;
  const res = await fetch(
    `${SUPABASE_URL.replace(/\/$/,'')}/rest/v1/crm_users?id=eq.${userId}&select=id,email,name,role,active`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } }
  );
  if (!res.ok) return null;
  const arr = await res.json();
  return Array.isArray(arr) ? arr[0] : null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method Not Allowed' });

  const { email, password } = req.body || {};
  const em = (email || '').trim().toLowerCase();
  if (!em || !password) return res.status(400).json({ error: 'email e password obrigatórios' });

  try {
    const auth = await sbAuth('/auth/v1/token?grant_type=password', { email: em, password });
    const profile = await fetchProfile(auth.user.id);
    if (profile && profile.active === false) {
      return res.status(403).json({ error: 'Usuário inativo — contate o admin.' });
    }
    return res.status(200).json({
      access_token:  auth.access_token,
      refresh_token: auth.refresh_token,
      expires_at:    auth.expires_at,
      user: {
        id:    auth.user.id,
        email: auth.user.email,
        name:  profile?.name || auth.user.user_metadata?.name || '',
        role:  profile?.role || auth.user.user_metadata?.role || 'vendedor',
      },
    });
  } catch (e) {
    const status = e.statusCode || 500;
    const msg = /invalid login|invalid email or password/i.test(e.message)
      ? 'E-mail ou senha incorretos'
      : e.message;
    return res.status(status).json({ error: msg });
  }
};
