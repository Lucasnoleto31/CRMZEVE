// Renova access_token usando refresh_token salvo no cliente.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const ALLOWED_ORIGIN = process.env.SB_PROXY_ALLOWED_ORIGIN || '*';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method Not Allowed' });

  const { refresh_token } = req.body || {};
  if (!refresh_token) return res.status(400).json({ error: 'refresh_token obrigatório' });
  if (!SUPABASE_URL || !SUPABASE_ANON) return res.status(500).json({ error: 'auth não configurado' });

  const r = await fetch(`${SUPABASE_URL.replace(/\/$/,'')}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token }),
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) {
    const msg = data?.msg || data?.error_description || data?.error || 'falha ao renovar';
    return res.status(r.status).json({ error: msg });
  }
  return res.status(200).json({
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_at:    data.expires_at,
  });
};
