/**
 * Vercel Cron — manutenção diária do CRM (03:00 BRT / 06:00 UTC)
 *
 * Tarefas:
 *   1. Auto-Ghost: promover leads em status='novo' que receberam disparo
 *      há > 24h e nunca responderam → status='ghost' (loss_category='sem_resposta').
 *   2. Recalcular `score` de todos os leads ativos (cache que alimenta
 *      a pill "🔥 Quentes" e a ordenação do Hoje sem custo no client).
 *   3. Detectar leads em Ghost há 30/60/90 dias e gerar notificação
 *      pro admin sugerir reativação. NÃO move status nem dispara mensagem
 *      — só sugere na bandeja para o humano decidir.
 *   4. Detectar inconsistências (lead que respondeu mas está sem responsável).
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
// Identificadores ASCII após refactor de etapas dinâmicas.
const STATUS_BASE = {
  novo:         5,
  aguardando:  10,
  silencio:    10,
  ativo:       20,
  esfriando:   15,
  atendimento: 35,
  reuniao:     50,
  abrindo:     70,
};
const SLA_DAYS = {
  novo: 1, aguardando: 1, silencio: 3, ativo: 1, esfriando: 3,
  atendimento: 2, reuniao: 3, abrindo: 7,
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
  // Usa funnel_stage (computado pela view) se disponível, senão status manual.
  const stage = l.funnel_stage || l.status;
  if (stage === 'cliente') return 100;
  if (stage === 'ghost' || stage === 'morto') return 0;
  let s = STATUS_BASE[stage] || STATUS_BASE[l.status] || 0;
  if (l.stage_entered_at) {
    const d = diffDays(l.stage_entered_at);
    const sla = SLA_DAYS[stage] || SLA_DAYS[l.status] || 5;
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

// Promove pra Ghost qualquer lead em status='novo' que recebeu disparo
// há > 24h e nunca respondeu. Etapas manuais (atendimento, reuniao, etc.)
// não são tocadas — vendedor já decidiu o estado. loss_category='sem_resposta'
// preserva a semântica "sumiu" vs "recusou".
async function autoGhostStaleLeads() {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const today  = new Date().toISOString().slice(0, 10);
  const now    = new Date().toISOString();

  const { data: stale, error } = await supabase
    .from('crm_leads')
    .select('id, name')
    .eq('status', 'novo')
    .eq('archived', false)
    .is('last_inbound_at', null)
    .not('last_outbound_at', 'is', null)
    .lt('last_outbound_at', cutoff)
    .limit(500);

  if (error) throw error;
  if (!stale?.length) return { promoted: 0 };

  let promoted = 0;
  for (const l of stale) {
    const { error: ue } = await supabase
      .from('crm_leads')
      .update({
        status: 'ghost',
        loss_category: 'sem_resposta',
        stage_entered_at: today,
        updated_at: now,
      })
      .eq('id', l.id);
    if (ue) continue;
    promoted++;
    // Histórico — falha silenciosa não bloqueia a promoção
    await supabase.from('crm_activity').insert({
      lead_id: l.id,
      action: 'Auto-Ghost',
      detail: '24h sem resposta — promovido automaticamente',
      responsible: 'sistema',
    }).then(() => {}, () => {});
  }
  return { promoted, candidates: stale.length };
}

async function recomputeScores() {
  const { data: leads, error } = await supabase
    .from('crm_leads')
    .select('id, status, stage_entered_at, next_action, next_action_date, priority, capital, level, archived, score')
    .eq('archived', false)
    .not('status', 'in', '("cliente","ghost","morto")');
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

    // Reativação só faz sentido pra Ghost (sumiram), não Morto (recusaram)
    const { data: leads } = await supabase
      .from('crm_leads')
      .select('id, name, stage_entered_at, status')
      .eq('status', 'ghost')
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
          message: `${l.name || 'Lead'} está em Ghost há ${days}d — vale tentar reativar?`,
        });
      }
      suggested++;
    }
  }
  return { suggested };
}

async function detectInconsistencies() {
  const issues = [];

  // (Antes havia um alerta para leads em Silêncio há > 24h. Agora esses leads
  // são automaticamente promovidos a Ghost por autoGhostStaleLeads — alerta
  // virou redundante e foi removido.)

  // 1) Lead que respondeu (last_inbound_at recente) e ainda está sem dono
  const recent = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  const { data: orphans } = await supabase
    .from('crm_leads')
    .select('id, name')
    .eq('status', 'novo')
    .eq('archived', false)
    .gte('last_inbound_at', recent)
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
          message: `⚠️ ${o.name} respondeu mas está sem responsável atribuído`,
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

  // Auto-ghost ANTES de recomputar scores — score deve refletir o status novo.
  try {
    result.auto_ghost = await autoGhostStaleLeads();
  } catch (e) { result.auto_ghost = { error: e.message }; }

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
