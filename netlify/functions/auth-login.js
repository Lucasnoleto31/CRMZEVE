// Login via Supabase Auth + anexação do role vindo de crm_users.
// Retorna: { access_token, refresh_token, expires_at, user:{id,email,name,role} }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET;
const ALLOWED_ORIGIN = process.env.SB_PROXY_ALLOWED_ORIGIN || '*';

function cors() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

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

exports.handler = async (event) => {
  const headers = cors();
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const email    = (body.email || '').trim().toLowerCase();
  const password = body.password || '';
  if (!email || !password) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'email e password obrigatórios' }) };
  }

  try {
    const auth = await sbAuth('/auth/v1/token?grant_type=password', { email, password });
    const profile = await fetchProfile(auth.user.id);
    if (profile && profile.active === false) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Usuário inativo — contate o admin.' }) };
    }
    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token:  auth.access_token,
        refresh_token: auth.refresh_token,
        expires_at:    auth.expires_at,
        user: {
          id:    auth.user.id,
          email: auth.user.email,
          name:  profile?.name || auth.user.user_metadata?.name || '',
          role:  profile?.role || auth.user.user_metadata?.role || 'vendedor',
        },
      }),
    };
  } catch (e) {
    const status = e.statusCode || 500;
    const msg = /invalid login|invalid email or password/i.test(e.message)
      ? 'E-mail ou senha incorretos'
      : e.message;
    return { statusCode: status, headers, body: JSON.stringify({ error: msg }) };
  }
};
