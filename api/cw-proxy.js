module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { cw_url, cw_account, cw_token, cw_path, cw_method, cw_body } = req.body || {};

  if (!cw_url || !cw_account || !cw_token || !cw_path) {
    return res.status(400).json({ error: 'Missing required params' });
  }

  const targetUrl = `${cw_url.replace(/\/$/, '')}/api/v1/accounts/${cw_account}${cw_path}`;
  const method = cw_method || 'GET';

  try {
    const fetchOpts = {
      method,
      headers: {
        'api_access_token': cw_token,
        'Content-Type': 'application/json'
      }
    };
    if (cw_body && method !== 'GET') {
      fetchOpts.body = JSON.stringify(cw_body);
    }

    const upstream = await fetch(targetUrl, fetchOpts);
    const text = await upstream.text();

    // Em erro, devolve o URL chamado para facilitar debug
    if (!upstream.ok) {
      let body;
      try { body = JSON.parse(text); } catch { body = { raw: text }; }
      return res.status(upstream.status).json({ ...body, _debug_url: targetUrl });
    }

    return res.status(upstream.status).setHeader('Content-Type', 'application/json').send(text);
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
};
