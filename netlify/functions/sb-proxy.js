const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET || process.env.SUPABASE_KEY;

const ALLOWED_ORIGIN = process.env.SB_PROXY_ALLOWED_ORIGIN || '*';

function cors() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin'
  };
}

async function sbFetch(path, { method = 'GET', body, headers = {} } = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    const err = new Error('Supabase env vars not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY)');
    err.statusCode = 500;
    throw err;
  }
  const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) {
    const err = new Error(typeof data === 'object' ? (data.message || JSON.stringify(data)) : String(data));
    err.statusCode = res.status;
    throw err;
  }
  return data;
}

const HANDLERS = {
  async ping() {
    await sbFetch('/crm_leads?select=id&limit=1');
    return { ok: true };
  },

  async list_leads({ page_size = 1000 } = {}) {
    const size = Math.min(Math.max(parseInt(page_size, 10) || 1000, 1), 1000);
    const all = [];
    let from = 0;
    while (true) {
      const to = from + size - 1;
      const batch = await sbFetch(
        `/crm_leads?select=*&order=created_at.desc`,
        { headers: { 'Range-Unit': 'items', 'Range': `${from}-${to}`, 'Prefer': 'count=none' } }
      );
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < size) break;
      from += size;
    }
    return all;
  },

  async upsert_lead({ lead } = {}) {
    if (!lead || typeof lead !== 'object') throw Object.assign(new Error('lead obrigatório'), { statusCode: 400 });
    const now = new Date().toISOString();
    if (lead.id) {
      const { id, ...rest } = lead;
      const data = await sbFetch(
        `/crm_leads?id=eq.${encodeURIComponent(id)}&select=*`,
        { method: 'PATCH', body: { ...rest, updated_at: now }, headers: { 'Prefer': 'return=representation' } }
      );
      return Array.isArray(data) ? data[0] : data;
    } else {
      const { id: _, ...rest } = lead;
      const data = await sbFetch(
        `/crm_leads?select=*`,
        { method: 'POST', body: { ...rest, created_at: now, updated_at: now }, headers: { 'Prefer': 'return=representation' } }
      );
      return Array.isArray(data) ? data[0] : data;
    }
  },

  async delete_lead({ id } = {}) {
    if (id == null) throw Object.assign(new Error('id obrigatório'), { statusCode: 400 });
    await sbFetch(`/crm_leads?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    return { ok: true };
  },

  async delete_leads({ ids } = {}) {
    if (!Array.isArray(ids) || ids.length === 0) throw Object.assign(new Error('ids obrigatório'), { statusCode: 400 });
    const inList = ids.map(v => encodeURIComponent(v)).join(',');
    await sbFetch(`/crm_leads?id=in.(${inList})`, { method: 'DELETE' });
    return { ok: true };
  },

  async get_activity({ lead_id } = {}) {
    if (lead_id == null) throw Object.assign(new Error('lead_id obrigatório'), { statusCode: 400 });
    const data = await sbFetch(`/crm_activity?select=*&lead_id=eq.${encodeURIComponent(lead_id)}&order=created_at.desc`);
    return Array.isArray(data) ? data : [];
  },

  async get_recent_activity({ limit = 40 } = {}) {
    const n = Math.min(Math.max(parseInt(limit, 10) || 40, 1), 500);
    const data = await sbFetch(`/crm_activity?select=*&order=created_at.desc&limit=${n}`);
    return Array.isArray(data) ? data : [];
  },

  async log_activity({ lead_id, action, detail = null, responsible = null } = {}) {
    if (lead_id == null || !action) throw Object.assign(new Error('lead_id e action obrigatórios'), { statusCode: 400 });
    const entry = {
      lead_id,
      action: String(action),
      detail: detail == null ? null : String(detail),
      responsible: responsible == null ? '—' : String(responsible),
      created_at: new Date().toISOString()
    };
    await sbFetch('/crm_activity', { method: 'POST', body: entry, headers: { 'Prefer': 'return=minimal' } });
    return { ok: true };
  }
};

exports.handler = async (event) => {
  const headers = cors();

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { action, params = {} } = payload;
  const fn = HANDLERS[action];
  if (!fn) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `unknown action: ${action}` }) };
  }

  try {
    const data = await fn(params || {});
    return {
      statusCode: 200,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data })
    };
  } catch (err) {
    const status = err.statusCode || 500;
    return {
      statusCode: status,
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message || 'proxy error' })
    };
  }
};
