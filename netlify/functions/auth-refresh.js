const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const ALLOWED_ORIGIN = process.env.SB_PROXY_ALLOWED_ORIGIN || '*';

function cors() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

exports.handler = async (event) => {
  const headers = cors();
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  let body; try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
  if (!body.refresh_token) return { statusCode: 400, headers, body: JSON.stringify({ error: 'refresh_token obrigatório' }) };
  if (!SUPABASE_URL || !SUPABASE_ANON) return { statusCode: 500, headers, body: JSON.stringify({ error: 'auth não configurado' }) };

  const r = await fetch(`${SUPABASE_URL.replace(/\/$/,'')}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: body.refresh_token }),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) {
    const msg = data?.msg || data?.error_description || data?.error || 'falha ao renovar';
    return { statusCode: r.status, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: msg }) };
  }
  return {
    statusCode: 200,
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: data.access_token, refresh_token: data.refresh_token, expires_at: data.expires_at }),
  };
};
