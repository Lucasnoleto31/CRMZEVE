exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };
  }

  let params;
  try {
    params = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { cw_url, cw_account, cw_token, cw_path, cw_method, cw_body } = params;

  if (!cw_url || !cw_account || !cw_token || !cw_path) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing required params' }) };
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

    const res = await fetch(targetUrl, fetchOpts);
    const text = await res.text();

    return {
      statusCode: res.status,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: text
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
