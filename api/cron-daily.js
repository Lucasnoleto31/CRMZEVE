/**
 * Vercel Cron — manutenção diária do CRM (03:00 BRT / 06:00 UTC)
 *
 * Tarefas:
 *   1. Recalcular `score` de todos os leads ativos (cache que alimenta
 *      a pill "🔥 Quentes" e a ordenação do Hoje sem custo no client).
 *   2. Detectar leads em "Perdido" há 30/60/90 dias e gerar notificação
 *      pro admin sugerir reativação. NÃO move status nem dispara mensagem
 *      — só sugere na bandeja para o humano decidir.
 *   3. Detectar inconsistências (lead em "IA Disparou" sem `last_outbound_at`
 *      há 24h, lead "Qualificado" sem assigned_to, etc.) e alertar admin.
 *
 * Disparo automático de mensagens fica na Fase 5 (cw-dispatch.js + gate).
 *
 * Variáveis de ambiente:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   CRON_SECRET (opcional — se setado, exige header `Authorization: Bearer <secret>`)
 *
 * Vercel Cron passa header `x-vercel-cron: 1` automaticamente.
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Score: replica a lógica do front (calcScore em index.html) ────
const STATUS_BASE = {
  'Lead Novo':         5,
  'IA Disparou':      10,
  'Qualificado':      20,
  'AIKON em Ação':    35,
  'Reunião Agendada': 50,
  'Em Abertura':      70,
};
const SLA_DAYS = {
  'Lead Novo': 1, 'IA Disparou': 1, 'Qualificado': 1,
  'AIKON em Ação': 2, 'Reunião Agendada': 3, 'Em Abertura': 7,
};
const PRIO_BONUS = { Urgente: 15, Alto: 8, 'Médio': 3, Baixo: 0 };

function diffDays(iso) {
  if (!iso) return 0;
  const now = new Date();
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const past = new Date(iso);
  return Math.max(0, Math.round((t - past) / 86400000));
}

function calcScore(l) {
  if (l.status === 'Convertido') return 100;
  if (l.status === 'Perdido')    return 0;
  let s = STATUS_BASE[l.status] || 0;
  if (l.stage_entered_at) {
    const d = diffDays(l.stage_entered_at);
    const sla = SLA_DAYS[l.status] || 5;
    s -= Math.min(Math.floor(d / sla) * 10, 35);
  }
  if (l.next_action) s += 8;
  if (l.next_action_date) {
    const today = new Date().toISOString().slice(0, 10);
    s += l.next_action_date >= today ? 5 : -5;
  }
  s += PRIO_BONUS[l.priority] || 0;
  const cap = parseFloat(l.capital) || 0;
  if (cap >= 200000) s += 12; else if (cap >= 100000) s += 8; else if (cap >= 50000) s += 4;
  if (l.level === 'Profissional' || l.level === 'Avançado') s += 5;
  return Math.max(0, Math.min(99, s));
}

// ── Tarefas ───────────────────────────────────────────────────
async function recomputeScores() {
  const { data: leads, error } = await supabase
    .from('crm_leads')
    .select('id, status, stage_entered_at, next_action, next_action_date, priority, capital, level, archived, score')
    .eq('archived', false)
    .not('status', 'in', '("Convertido","Perdido")');
  if (error) throw error;

  let updated = 0;
  const now = new Date().toISOString();
  // Faz em lotes de 500 pra não estourar limite do Supabase
  const BATCH = 500;
  for (let i = 0; i < (leads || []).length; i += BATCH) {
    const slice = leads.slice(i, i + BATCH);
    const updates = slice
      .map(l => ({ id: l.id, newScore: calcScore(l), oldScore: l.score || 0 }))
      .filter(x => x.newScore !== x.oldScore);

    for (const u of updates) {
      const { error: ue } = await supabase
        .from('crm_leads')
        .update({ score: u.newScore, score_updated_at: now })
        .eq('id', u.id);
      if (!ue) updated++;
    }
  }
  return { total: leads?.length || 0, updated };
}

async function suggestReactivations() {
  const today = new Date();
  const targets = [30, 60, 90];
  let suggested = 0;

  // Busca admins
  const { data: admins } = await supabase
    .from('crm_users').select('id').eq('role', 'admin').eq('active', true);
  if (!admins?.length) return { suggested: 0, skip: 'no admins' };

  for (const days of targets) {
    const cutoffStart = new Date(today.getTime() - (days + 1) * 86400000).toISOString().slice(0, 10);
    const cutoffEnd   = new Date(today.getTime() - days * 86400000).toISOString().slice(0, 10);

    const { data: leads } = await supabase
      .from('crm_leads')
      .select('id, name, stage_entered_at, status')
      .eq('status', 'Perdido')
      .eq('archived', false)
      .gte('stage_entered_at', cutoffStart)
      .lt('stage_entered_at', cutoffEnd);

    for (const l of leads || []) {
      // Evita duplicar notificação no mesmo dia
      const { data: existing } = await supabase
        .from('crm_notifications')
        .select('id')
        .eq('lead_id', l.id)
        .eq('type', 'reactivation_suggested')
        .gte('created_at', new Date(today.getTime() - 86400000).toISOString())
        .limit(1);
      if (existing?.length) continue;

      for (const a of admins) {
        await supabase.from('crm_notifications').insert({
          user_id: a.id,
          lead_id: l.id,
          type: 'reactivation_suggested',
          message: `${l.name || 'Lead'} está perdido há ${days}d — vale tentar reativar?`,
        });
      }
      suggested++;
    }
  }
  return { suggested };
}

async function detectInconsistencies() {
  const issues = [];

  // 1) Lead "IA Disparou" sem last_outbound_at há 24h+
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: stuck1 } = await supabase
    .from('crm_leads')
    .select('id, name, assigned_to, last_outbound_at, stage_entered_at')
    .eq('status', 'IA Disparou')
    .eq('archived', false)
    .or(`last_outbound_at.is.null,last_outbound_at.lt.${since}`)
    .lt('stage_entered_at', new Date(Date.now() - 86400000).toISOString().slice(0, 10))
    .limit(50);

  for (const l of stuck1 || []) {
    issues.push({
      lead_id: l.id,
      user_id: l.assigned_to,
      message: `${l.name} parou em "IA Disparou" sem disparo recente — re-enviar?`,
    });
  }

  // 2) Lead "Qualificado" sem dono
  const { data: orphans } = await supabase
    .from('crm_leads')
    .select('id, name')
    .eq('status', 'Qualificado')
    .eq('archived', false)
    .is('assigned_to', null)
    .limit(50);

  // Se há órfãos, manda pro admin
  if (orphans?.length) {
    const { data: admins } = await supabase
      .from('crm_users').select('id').eq('role', 'admin').eq('active', true);
    for (const o of orphans) {
      for (const a of admins || []) {
        issues.push({
          lead_id: o.id,
          user_id: a.id,
          message: `⚠️ ${o.name} foi qualificado mas está sem responsável`,
        });
      }
    }
  }

  // Insere notificações (de-dup por dia/lead/type via upsert simples)
  let inserted = 0;
  for (const i of issues) {
    if (!i.user_id) continue;
    const { data: existing } = await supabase
      .from('crm_notifications')
      .select('id')
      .eq('lead_id', i.lead_id)
      .eq('user_id', i.user_id)
      .eq('type', 'inconsistency')
      .gte('created_at', new Date(Date.now() - 86400000).toISOString())
      .limit(1);
    if (existing?.length) continue;
    await supabase.from('crm_notifications').insert({
      user_id: i.user_id,
      lead_id: i.lead_id,
      type: 'inconsistency',
      message: i.message,
    });
    inserted++;
  }
  return { detected: issues.length, inserted };
}

// ── Handler ───────────────────────────────────────────────────
module.exports = async (req, res) => {
  // Autenticação: aceita header da Vercel OU bearer secret
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const expected = process.env.CRON_SECRET;
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!isVercelCron && expected && provided !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const start = Date.now();
  const result = { ok: true, ts: new Date().toISOString() };

  try {
    result.scores = await recomputeScores();
  } catch (e) { result.scores = { error: e.message }; }

  try {
    result.reactivations = await suggestReactivations();
  } catch (e) { result.reactivations = { error: e.message }; }

  try {
    result.inconsistencies = await detectInconsistencies();
  } catch (e) { result.inconsistencies = { error: e.message }; }

  result.elapsed_ms = Date.now() - start;
  console.log('cron-daily:', JSON.stringify(result));
  return res.status(200).json(result);
};
