const SUPABASE_URL    = process.env.SUPABASE_URL;
const SERVICE_KEY     = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET;
const ANON_KEY        = process.env.SUPABASE_ANON_KEY    || process.env.SUPABASE_KEY;
const ALLOWED_ORIGIN  = process.env.SB_PROXY_ALLOWED_ORIGIN || '*';

function cors() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin'
  };
}

// JWT do request atual (setado no handler antes de HANDLERS[action], limpo no finally).
let _currentAuth = null;

function buildHeaders() {
  if (_currentAuth) {
    if (!ANON_KEY) {
      const err = new Error('SUPABASE_ANON_KEY não configurado'); err.statusCode = 500; throw err;
    }
    return { apikey: ANON_KEY, Authorization: `Bearer ${_currentAuth}` };
  }
  if (!SERVICE_KEY) {
    const err = new Error('SUPABASE_SERVICE_KEY não configurado'); err.statusCode = 500; throw err;
  }
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
}

async function sbFetch(path, { method = 'GET', body, headers = {} } = {}) {
  if (!SUPABASE_URL) {
    const err = new Error('SUPABASE_URL não configurado'); err.statusCode = 500; throw err;
  }
  const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1${path}`;
  const res = await fetch(url, {
    method,
    headers: { ...buildHeaders(), 'Content-Type': 'application/json', ...headers },
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

async function sbAdmin(path, { method = 'GET', body } = {}) {
  if (!SUPABASE_URL) { const e = new Error('SUPABASE_URL não configurado'); e.statusCode = 500; throw e; }
  if (!SERVICE_KEY)  { const e = new Error('SUPABASE_SERVICE_KEY não configurado'); e.statusCode = 500; throw e; }
  const url = `${SUPABASE_URL.replace(/\/$/, '')}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) {
    const msg = typeof data === 'object' ? (data.msg || data.message || data.error_description || JSON.stringify(data)) : String(data);
    const err = new Error(msg); err.statusCode = res.status; throw err;
  }
  return data;
}

async function requireAdmin() {
  if (!_currentAuth) return;
  const rows = await sbFetch('/crm_users?select=role&limit=1');
  const role = Array.isArray(rows) && rows[0] ? rows[0].role : null;
  if (role !== 'admin') {
    const e = new Error('Acesso negado — apenas admin'); e.statusCode = 403; throw e;
  }
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
  },

  // ── MAPEAMENTO ETAPA ↔ TEMPLATE ──
  async list_stage_templates() {
    const data = await sbFetch('/crm_stage_templates?select=*&order=stage.asc');
    return Array.isArray(data) ? data : [];
  },
  async upsert_stage_template({ stage, template_name, template_body = null, language = 'pt_BR', category = 'MARKETING', enabled = true, auto_trigger = false } = {}) {
    if (!stage || !template_name) throw Object.assign(new Error('stage e template_name obrigatórios'), { statusCode: 400 });
    const row = {
      stage: String(stage),
      template_name: String(template_name),
      template_body: template_body == null ? null : String(template_body),
      language: String(language || 'pt_BR'),
      category: String(category || 'MARKETING'),
      enabled: !!enabled,
      auto_trigger: !!auto_trigger,
      updated_at: new Date().toISOString()
    };
    const data = await sbFetch(
      `/crm_stage_templates?on_conflict=stage&select=*`,
      { method: 'POST', body: row, headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' } }
    );
    return Array.isArray(data) ? data[0] : data;
  },
  async delete_stage_template({ stage } = {}) {
    if (!stage) throw Object.assign(new Error('stage obrigatório'), { statusCode: 400 });
    await sbFetch(`/crm_stage_templates?stage=eq.${encodeURIComponent(stage)}`, { method: 'DELETE' });
    return { ok: true };
  },
  async list_users() {
    const data = await sbFetch('/crm_users?select=id,email,name,role,active&active=eq.true&order=name.asc');
    return Array.isArray(data) ? data : [];
  },
  async assign_lead({ lead_id, assigned_to } = {}) {
    if (lead_id == null) throw Object.assign(new Error('lead_id obrigatório'), { statusCode: 400 });
    const data = await sbFetch(
      `/crm_leads?id=eq.${encodeURIComponent(lead_id)}&select=*`,
      { method: 'PATCH', body: { assigned_to: assigned_to || null, updated_at: new Date().toISOString() }, headers: { 'Prefer': 'return=representation' } }
    );
    const lead = Array.isArray(data) ? data[0] : data;
    if (assigned_to && lead) {
      const prev = _currentAuth; _currentAuth = null;
      try {
        await sbFetch('/crm_notifications', {
          method: 'POST',
          body: {
            user_id: assigned_to,
            lead_id: lead.id,
            type: 'assignment',
            message: `Novo lead atribuído: ${lead.name || 'sem nome'}`,
          },
          headers: { 'Prefer': 'return=minimal' },
        });
      } catch (e) { console.warn('notify assignee:', e.message); }
      finally { _currentAuth = prev; }
    }
    return lead;
  },

  async list_my_notifications({ limit = 30 } = {}) {
    const n = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
    const data = await sbFetch(`/crm_notifications?select=*&order=created_at.desc&limit=${n}`);
    return Array.isArray(data) ? data : [];
  },
  async mark_notification_read({ id } = {}) {
    if (id == null) throw Object.assign(new Error('id obrigatório'), { statusCode: 400 });
    await sbFetch(`/crm_notifications?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH', body: { read: true }, headers: { 'Prefer': 'return=minimal' },
    });
    return { ok: true };
  },
  async mark_all_notifications_read() {
    await sbFetch(`/crm_notifications?read=eq.false`, {
      method: 'PATCH', body: { read: true }, headers: { 'Prefer': 'return=minimal' },
    });
    return { ok: true };
  },

  async report_by_user() {
    await requireAdmin();
    const prev = _currentAuth; _currentAuth = null;
    try {
      const [users, leads] = await Promise.all([
        sbFetch('/crm_users?select=id,name,email,role,active&order=name.asc'),
        sbFetch('/crm_leads?select=id,status,assigned_to,stage_entered_at,created_at,archived'),
      ]);
      const byUser = new Map();
      for (const u of (users || [])) {
        byUser.set(u.id, { id: u.id, name: u.name, email: u.email, role: u.role, active: u.active, total:0, ativos:0, convertidos:0, perdidos:0, reuniao:0, _sumDays:0, _cntDays:0 });
      }
      const naoAtrib = { id: null, name: '— Sem responsável —', email: '', role:'', active:true, total:0, ativos:0, convertidos:0, perdidos:0, reuniao:0, _sumDays:0, _cntDays:0 };
      const now = Date.now();
      for (const l of (leads || [])) {
        const bucket = (l.assigned_to && byUser.get(l.assigned_to)) || naoAtrib;
        bucket.total++;
        if (l.archived) continue;
        if (l.status === 'Convertido') bucket.convertidos++;
        else if (l.status === 'Perdido') bucket.perdidos++;
        else { bucket.ativos++; if (l.status === 'Reunião Agendada') bucket.reuniao++; }
        if (l.stage_entered_at) {
          const d = new Date(l.stage_entered_at + 'T00:00:00').getTime();
          if (!isNaN(d)) { bucket._sumDays += (now - d) / 86400000; bucket._cntDays++; }
        }
      }
      return [...byUser.values(), naoAtrib]
        .filter(r => r.total > 0 || r.active)
        .map(r => ({
          ...r,
          taxa_conversao: (r.convertidos + r.perdidos) > 0 ? Math.round((r.convertidos / (r.convertidos + r.perdidos)) * 100) : null,
          media_dias_etapa: r._cntDays ? Math.round(r._sumDays / r._cntDays) : null,
        }))
        .map(({ _sumDays, _cntDays, ...rest }) => rest);
    } finally { _currentAuth = prev; }
  },

  // ── ADMIN USERS ──
  async list_users_all() {
    await requireAdmin();
    const prev = _currentAuth; _currentAuth = null;
    try {
      const data = await sbFetch('/crm_users?select=id,email,name,role,active&order=name.asc');
      return Array.isArray(data) ? data : [];
    } finally { _currentAuth = prev; }
  },
  async create_user({ email, password, name, role = 'vendedor' } = {}) {
    await requireAdmin();
    if (!email || !password || !name) throw Object.assign(new Error('email, password e name obrigatórios'), { statusCode: 400 });
    if (!['admin','vendedor','reunioes'].includes(role)) throw Object.assign(new Error('role inválido'), { statusCode: 400 });
    const created = await sbAdmin('/auth/v1/admin/users', {
      method: 'POST',
      body: { email, password, email_confirm: true, user_metadata: { name, role } },
    });
    const uid = created?.id || created?.user?.id;
    if (uid) {
      const prev = _currentAuth; _currentAuth = null;
      try {
        await sbFetch('/crm_users?on_conflict=id', {
          method: 'POST',
          body: { id: uid, email, name, role, active: true },
          headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        });
      } finally { _currentAuth = prev; }
    }
    return { id: uid, email, name, role, active: true };
  },
  async set_user_active({ id, active } = {}) {
    await requireAdmin();
    if (!id) throw Object.assign(new Error('id obrigatório'), { statusCode: 400 });
    const prev = _currentAuth; _currentAuth = null;
    try {
      const data = await sbFetch(
        `/crm_users?id=eq.${encodeURIComponent(id)}&select=id,email,name,role,active`,
        { method: 'PATCH', body: { active: !!active }, headers: { 'Prefer': 'return=representation' } }
      );
      return Array.isArray(data) ? data[0] : data;
    } finally { _currentAuth = prev; }
  },
  async set_user_role({ id, role } = {}) {
    await requireAdmin();
    if (!id) throw Object.assign(new Error('id obrigatório'), { statusCode: 400 });
    if (!['admin','vendedor','reunioes'].includes(role)) throw Object.assign(new Error('role inválido'), { statusCode: 400 });
    try { await sbAdmin(`/auth/v1/admin/users/${id}`, { method: 'PUT', body: { user_metadata: { role } } }); }
    catch (e) { console.warn('update metadata:', e.message); }
    const prev = _currentAuth; _currentAuth = null;
    try {
      const data = await sbFetch(
        `/crm_users?id=eq.${encodeURIComponent(id)}&select=id,email,name,role,active`,
        { method: 'PATCH', body: { role }, headers: { 'Prefer': 'return=representation' } }
      );
      return Array.isArray(data) ? data[0] : data;
    } finally { _currentAuth = prev; }
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

  // Extrai JWT (se houver) do Authorization header. Sem token = service_role.
  const authHeader = (event.headers && (event.headers['authorization'] || event.headers['Authorization'])) || '';
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  _currentAuth = match ? match[1] : null;

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
  } finally {
    _currentAuth = null;
  }
};
