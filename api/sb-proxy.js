const SUPABASE_URL    = process.env.SUPABASE_URL;
const SERVICE_KEY     = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET;
const ANON_KEY        = process.env.SUPABASE_ANON_KEY    || process.env.SUPABASE_KEY;
const ALLOWED_ORIGIN  = process.env.SB_PROXY_ALLOWED_ORIGIN || '*';

// Auth do request em andamento — setado no handler principal antes de chamar
// os HANDLERS[action] e resetado no finally. Em ambiente serverless cada
// invocação roda single-threaded então é seguro.
let _currentAuth = null;

function buildHeaders() {
  // Se chegou um JWT de usuário, usa ele (RLS do Supabase avalia por auth.uid()).
  // Senão, cai no service_role (bot, webhook, rotinas internas).
  if (_currentAuth) {
    if (!ANON_KEY) {
      const err = new Error('SUPABASE_ANON_KEY não configurado — necessário quando há JWT de usuário');
      err.statusCode = 500; throw err;
    }
    return { apikey: ANON_KEY, Authorization: `Bearer ${_currentAuth}` };
  }
  if (!SERVICE_KEY) {
    const err = new Error('SUPABASE_SERVICE_KEY não configurado');
    err.statusCode = 500; throw err;
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

// Chama a Admin API (/auth/v1/admin/...) sempre com service_role.
// Admin API não aceita JWT de usuário; reservado para handlers privilegiados.
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

// Verifica que o JWT atual pertence a um usuário com role=admin em crm_users.
// Se não houver JWT (service_role), libera — é chamada interna (bot/webhook).
async function requireAdmin() {
  if (!_currentAuth) return; // service_role / chamada interna
  // Consulta crm_users usando o próprio JWT (RLS permite select do próprio registro)
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
    // Tenta primeiro a view crm_leads_full (vem com `sinal` e
    // `dias_sem_movimento` da Fase "lead-signal"). Se a view ainda não
    // foi criada, cai pra crm_leads e o front calcula o sinal localmente.
    let table = 'crm_leads_full';
    while (true) {
      const to = from + size - 1;
      let batch;
      try {
        batch = await sbFetch(
          `/${table}?select=*&order=created_at.desc`,
          { headers: { 'Range-Unit': 'items', 'Range': `${from}-${to}`, 'Prefer': 'count=none' } }
        );
      } catch (e) {
        // Fallback: view não existe ainda → usa tabela crua
        if (table === 'crm_leads_full' && from === 0) {
          table = 'crm_leads';
          continue;
        }
        throw e;
      }
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
    // Strip de colunas computadas vindas da view crm_leads_full — não existem
    // na tabela crm_leads e o PostgREST estoura schema-cache se forem enviadas.
    const { funnel_stage: _fs, sinal: _sn, dias_sem_movimento: _dsm, status_manual: _sm, ...clean } = lead;
    if (clean.id) {
      const { id, ...rest } = clean;
      const data = await sbFetch(
        `/crm_leads?id=eq.${encodeURIComponent(id)}&select=*`,
        { method: 'PATCH', body: { ...rest, updated_at: now }, headers: { 'Prefer': 'return=representation' } }
      );
      return Array.isArray(data) ? data[0] : data;
    } else {
      const { id: _, ...rest } = clean;
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
  async list_stage_templates() {
    const data = await sbFetch('/crm_stage_templates?select=*&order=stage.asc');
    return Array.isArray(data) ? data : [];
  },
  async upsert_stage_template({ stage, template_name, template_body = null, language = 'pt_BR', category = 'MARKETING', enabled = true, auto_trigger = false, categoria_filter = null, priority = 100 } = {}) {
    if (!stage || !template_name) throw Object.assign(new Error('stage e template_name obrigatórios'), { statusCode: 400 });
    const row = {
      stage: String(stage),
      template_name: String(template_name),
      template_body: template_body == null ? null : String(template_body),
      language: String(language || 'pt_BR'),
      category: String(category || 'MARKETING'),
      enabled: !!enabled,
      auto_trigger: !!auto_trigger,
      categoria_filter: categoria_filter || null,
      priority: parseInt(priority, 10) || 100,
      updated_at: new Date().toISOString()
    };
    // Chave composta (stage, categoria_filter) — match com a UNIQUE
    // CONSTRAINT NULLS NOT DISTINCT criada em fix-stage-template-upsert.sql.
    const data = await sbFetch(
      `/crm_stage_templates?on_conflict=stage,categoria_filter&select=*`,
      { method: 'POST', body: row, headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' } }
    );
    return Array.isArray(data) ? data[0] : data;
  },
  async delete_stage_template({ stage } = {}) {
    if (!stage) throw Object.assign(new Error('stage obrigatório'), { statusCode: 400 });
    await sbFetch(`/crm_stage_templates?stage=eq.${encodeURIComponent(stage)}`, { method: 'DELETE' });
    return { ok: true };
  },

  // ── USUÁRIOS ──
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
    // Dispara notificação para o novo responsável (se houver). Usa service_role
    // bypass pra conseguir inserir em crm_notifications (policy INSERT é negada
    // por default pra usuários comuns).
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

  // ── REDISPATCH (segunda tentativa em leads em Silêncio) ──
  // Chama cw-dispatch.js usando o template vinculado à etapa atual do lead.
  // Registra atribuição com tag 'retry_silencio' pra você medir % retomada.
  async redispatch_lead({ lead_id } = {}) {
    if (lead_id == null) throw Object.assign(new Error('lead_id obrigatório'), { statusCode: 400 });

    // Lê o lead (RLS aplicado via JWT do caller)
    const leadRows = await sbFetch(`/crm_leads_full?id=eq.${encodeURIComponent(lead_id)}&select=*&limit=1`);
    const lead = Array.isArray(leadRows) ? leadRows[0] : null;
    if (!lead) throw Object.assign(new Error('lead não encontrado'), { statusCode: 404 });

    // Bypass RLS para o disparo (precisa ler tabelas internas)
    const prev = _currentAuth; _currentAuth = null;
    try {
      const { dispatchAfterClassify } = require('./cw-dispatch');
      // Categoria: usa a já classificada, ou null se ainda não tem
      const categoria = lead.categoria_ia || null;
      const result = await dispatchAfterClassify(lead, categoria, { manual: true });

      // Marca a atribuição como retry pra medir conversão de retomada
      if (result?.dispatched) {
        try {
          await sbFetch('/crm_attributions', {
            method: 'PATCH',
            body: { meta: { conversation_id: result.conversation_id, auto: false, retry_silencio: true } },
            headers: { 'Prefer': 'return=minimal' },
          });
        } catch { /* tolerável */ }
      }
      return result;
    } finally { _currentAuth = prev; }
  },

  // ── NOTIFICAÇÕES ──
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
    // PostgREST precisa de filtro; usamos read=eq.false para atingir só as não-lidas
    // do caller (RLS já limita user_id = auth.uid()).
    await sbFetch(`/crm_notifications?read=eq.false`, {
      method: 'PATCH', body: { read: true }, headers: { 'Prefer': 'return=minimal' },
    });
    return { ok: true };
  },

  // ── RELATÓRIO POR VENDEDOR (só admin) ──
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
        byUser.set(u.id, {
          id: u.id, name: u.name, email: u.email, role: u.role, active: u.active,
          total: 0, ativos: 0, convertidos: 0, perdidos: 0, reuniao: 0,
          // soma e contagem para média de dias na etapa atual
          _sumDays: 0, _cntDays: 0,
        });
      }
      const naoAtrib = {
        id: null, name: '— Sem responsável —', email: '', role: '', active: true,
        total: 0, ativos: 0, convertidos: 0, perdidos: 0, reuniao: 0,
        _sumDays: 0, _cntDays: 0,
      };
      const now = Date.now();
      for (const l of (leads || [])) {
        const bucket = (l.assigned_to && byUser.get(l.assigned_to)) || naoAtrib;
        bucket.total++;
        if (l.archived) continue;
        if (l.status === 'cliente') bucket.convertidos++;
        else if (l.status === 'ghost' || l.status === 'morto') bucket.perdidos++;
        else {
          bucket.ativos++;
          if (l.status === 'reuniao') bucket.reuniao++;
        }
        if (l.stage_entered_at) {
          const d = new Date(l.stage_entered_at + 'T00:00:00').getTime();
          if (!isNaN(d)) { bucket._sumDays += (now - d) / 86400000; bucket._cntDays++; }
        }
      }
      const rows = [...byUser.values(), naoAtrib]
        .filter(r => r.total > 0 || r.active)
        .map(r => ({
          ...r,
          taxa_conversao: (r.convertidos + r.perdidos) > 0
            ? Math.round((r.convertidos / (r.convertidos + r.perdidos)) * 100)
            : null,
          media_dias_etapa: r._cntDays ? Math.round(r._sumDays / r._cntDays) : null,
        }))
        .map(({ _sumDays, _cntDays, ...rest }) => rest);
      return rows;
    } finally { _currentAuth = prev; }
  },

  // ── ADMIN USERS (só admin) ──
  // Lista todos os usuários (incluindo inativos), p/ o painel admin.
  async list_users_all() {
    await requireAdmin();
    // Bypass RLS usando service_role: salva auth e faz fetch sem JWT
    const prev = _currentAuth; _currentAuth = null;
    try {
      const data = await sbFetch('/crm_users?select=id,email,name,role,active&order=name.asc');
      return Array.isArray(data) ? data : [];
    } finally { _currentAuth = prev; }
  },

  // Cria um usuário novo (Admin API + trigger alimenta crm_users).
  async create_user({ email, password, name, role = 'vendedor' } = {}) {
    await requireAdmin();
    if (!email || !password || !name) throw Object.assign(new Error('email, password e name obrigatórios'), { statusCode: 400 });
    if (!['admin','vendedor','reunioes'].includes(role)) throw Object.assign(new Error('role inválido'), { statusCode: 400 });
    const created = await sbAdmin('/auth/v1/admin/users', {
      method: 'POST',
      body: { email, password, email_confirm: true, user_metadata: { name, role } },
    });
    const uid = created?.id || created?.user?.id;
    // Upsert em crm_users caso o trigger não tenha rodado (ex.: instalado depois)
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

  // Ativa/desativa um usuário (não deleta; preserva leads atribuídos)
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

  // Atualiza o role de um usuário
  async set_user_role({ id, role } = {}) {
    await requireAdmin();
    if (!id) throw Object.assign(new Error('id obrigatório'), { statusCode: 400 });
    if (!['admin','vendedor','reunioes'].includes(role)) throw Object.assign(new Error('role inválido'), { statusCode: 400 });
    // Também atualiza user_metadata.role no Auth pra consistência
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  const { action, params = {} } = req.body || {};
  const fn = HANDLERS[action];
  if (!fn) return res.status(400).json({ error: `unknown action: ${action}` });

  // Extrai JWT (se houver) do Authorization header. Sem token = fallback
  // service_role (mantém bot/webhook/chamadas internas funcionando).
  const authHeader = req.headers['authorization'] || req.headers['Authorization'] || '';
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  _currentAuth = match ? match[1] : null;

  try {
    const data = await fn(params || {});
    return res.status(200).json({ data });
  } catch (err) {
    const status = err.statusCode || 500;
    return res.status(status).json({ error: err.message || 'proxy error' });
  } finally {
    _currentAuth = null;
  }
};
