/**
 * Vercel Cron — reconciliação Chatwoot ↔ CRM (hourly)
 *
 * Cobre o caso onde o webhook cw-webhook.js falhou silenciosamente
 * (cold start, gap de disponibilidade, falha de rede). Varre conversas
 * com atividade nas últimas RECONCILE_WINDOW_HOURS horas e corrige
 * last_inbound_at / last_outbound_at quando o CRM está atrás do Chatwoot.
 *
 * Idempotente — nunca sobrescreve timestamp mais recente, nem dispara
 * classificação ou notificação (apenas timestamps).
 *
 * Variáveis de ambiente:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   CHATWOOT_URL, CHATWOOT_TOKEN, CHATWOOT_ACCOUNT_ID
 *   CRON_SECRET (opcional)
 *   RECONCILE_WINDOW_HOURS (default 2 — janela varrida a cada execução)
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CW_URL = (process.env.CHATWOOT_URL || '').replace(/\/$/, '');
const CW_TOKEN = process.env.CHATWOOT_TOKEN;
const CW_ACCOUNT = process.env.CHATWOOT_ACCOUNT_ID;
const WINDOW_HOURS = parseInt(process.env.RECONCILE_WINDOW_HOURS || '2', 10);
const MAX_PAGES = 5;          // limite hard pra não estourar timeout (10s)
const PARALLEL = 15;

async function cwGet(path) {
  const r = await fetch(CW_URL + path, { headers: { api_access_token: CW_TOKEN } });
  if (!r.ok) throw new Error(`CW ${r.status}: ${path}`);
  return r.json();
}

async function listRecentConversations(sinceUnix) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const d = await cwGet(`/api/v1/accounts/${CW_ACCOUNT}/conversations?status=all&page=${page}&assignee_type=all`);
    const list = d.data?.payload || d.payload || [];
    if (!list.length) break;
    for (const c of list) if (c.last_activity_at >= sinceUnix) out.push(c);
    if (list.every(c => c.last_activity_at < sinceUnix)) break;
  }
  return out;
}

async function findLeadByPhone(digits) {
  const { data } = await supabase.rpc('find_lead_by_phone_strict', { search_digits: digits });
  return data?.[0] || null;
}

async function reconcileOne(conv, sinceUnix) {
  const phone = conv.meta?.sender?.phone_number || conv.contact?.phone_number || '';
  if (!phone) return { skip: 'no_phone' };
  const digits = phone.replace(/\D/g, '');
  if (!digits) return { skip: 'no_digits' };

  const lead = await findLeadByPhone(digits);
  if (!lead) return { skip: 'no_lead', phone };

  // Pre-check rápido: se CRM já tem timestamp >= last_activity, nada a fazer
  const cwActivity = conv.last_activity_at * 1000;
  const curIn = lead.last_inbound_at ? new Date(lead.last_inbound_at).getTime() : 0;
  const curOut = lead.last_outbound_at ? new Date(lead.last_outbound_at).getTime() : 0;
  if (Math.max(curIn, curOut) >= cwActivity) return { skip: 'already_synced', leadId: lead.id };

  // Busca mensagens da janela
  const msgs = (await cwGet(`/api/v1/accounts/${CW_ACCOUNT}/conversations/${conv.id}/messages`)).payload || [];
  const inWindow = msgs.filter(m => (m.message_type === 0 || m.message_type === 1) && m.created_at >= sinceUnix);
  if (!inWindow.length) return { skip: 'no_msgs_in_window', leadId: lead.id };

  const lastIn = inWindow.filter(m => m.message_type === 0).slice(-1)[0];
  const lastOut = inWindow.filter(m => m.message_type === 1).slice(-1)[0];
  const newIn = lastIn ? new Date(lastIn.created_at * 1000).toISOString() : null;
  const newOut = lastOut ? new Date(lastOut.created_at * 1000).toISOString() : null;

  const update = {};
  if (newIn && (!lead.last_inbound_at || new Date(lead.last_inbound_at).getTime() < new Date(newIn).getTime())) {
    update.last_inbound_at = newIn;
  }
  if (newOut && (!lead.last_outbound_at || new Date(lead.last_outbound_at).getTime() < new Date(newOut).getTime())) {
    update.last_outbound_at = newOut;
  }
  if (!lead.chatwoot_conversation_id) update.chatwoot_conversation_id = conv.id;
  if (!Object.keys(update).length) return { skip: 'crm_already_ahead', leadId: lead.id };

  const { error } = await supabase.from('crm_leads').update(update).eq('id', lead.id);
  if (error) return { error: error.message, leadId: lead.id };
  return { fixed: true, leadId: lead.id, applied: Object.keys(update) };
}

module.exports = async (req, res) => {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const expected = process.env.CRON_SECRET;
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!isVercelCron && expected && provided !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!CW_URL || !CW_TOKEN || !CW_ACCOUNT) {
    return res.status(500).json({ error: 'chatwoot env vars missing' });
  }

  const start = Date.now();
  const sinceUnix = Math.floor((Date.now() - WINDOW_HOURS * 3600 * 1000) / 1000);

  let convs;
  try {
    convs = await listRecentConversations(sinceUnix);
  } catch (e) {
    return res.status(200).json({ ok: false, stage: 'list_conversations', error: e.message });
  }

  const stats = { conversations: convs.length, fixed: 0, skipped: {}, errors: 0 };

  for (let i = 0; i < convs.length; i += PARALLEL) {
    const batch = convs.slice(i, i + PARALLEL);
    const results = await Promise.allSettled(batch.map(c => reconcileOne(c, sinceUnix)));
    for (const r of results) {
      if (r.status === 'rejected') { stats.errors++; continue; }
      const v = r.value;
      if (v.fixed) stats.fixed++;
      else if (v.error) stats.errors++;
      else stats.skipped[v.skip] = (stats.skipped[v.skip] || 0) + 1;
    }
  }

  stats.elapsed_ms = Date.now() - start;
  stats.window_hours = WINDOW_HOURS;
  stats.ts = new Date().toISOString();
  console.log('cron-reconcile:', JSON.stringify(stats));
  return res.status(200).json({ ok: true, ...stats });
};
