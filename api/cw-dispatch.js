/**
 * Disparo automático de template AIKON após classificação do lead.
 *
 * Chamado pelo cw-webhook.js depois que a IA classifica a categoria
 * e move o lead para "Qualificado". Aplica gates de segurança e só
 * dispara quando todos passam.
 *
 * GATES (em ordem — primeiro a falhar aborta o disparo):
 *   1. AIKON_AUTO_DISPATCH=true em Vercel env (kill switch global)
 *   2. Janela de horário: 08:00-21:00 BRT (não acorda lead à 1h da manhã)
 *   3. last_outbound_at do lead < 30min atrás → cooldown
 *   4. crm_daily_outbound do vendedor >= 50 → quota estourada
 *   5. Template existe + ativo em crm_stage_templates p/ a categoria
 *   6. Configuração Chatwoot completa (URL/token/account/inbox)
 *
 * Em caso de sucesso:
 *   - Envia template via Chatwoot Cloud API
 *   - Insere crm_attributions(outcome='sent', cost_brl=0.55)
 *   - Atualiza last_outbound_at do lead
 *   - Incrementa quota diária do vendedor
 *   - Log estruturado
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Configuração Chatwoot vem do env (mais seguro que localStorage do cliente)
const CW = {
  url:     (process.env.CHATWOOT_API || '').replace(/\/$/, ''),
  account: process.env.CHATWOOT_ACCOUNT_ID || '1',
  token:   process.env.CHATWOOT_TOKEN || '',
  inbox:   process.env.CHATWOOT_INBOX_ID || '',
};

const COST_TEMPLATE_BRL = parseFloat(process.env.AIKON_COST_PER_TEMPLATE || '0.55');
const DAILY_CAP         = parseInt(process.env.AIKON_DAILY_CAP || '50', 10);
const COOLDOWN_MIN      = parseInt(process.env.AIKON_COOLDOWN_MIN || '30', 10);

// Janela de disparo (BRT). 08:00-21:00 padrão. Override por env.
const HOUR_MIN = parseInt(process.env.AIKON_HOUR_MIN || '8', 10);
const HOUR_MAX = parseInt(process.env.AIKON_HOUR_MAX || '21', 10);

function isWithinDispatchWindow(now = new Date()) {
  // Converte para BRT (UTC-3). Usa toLocaleString para evitar lib externa.
  const brt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const h = brt.getHours();
  return h >= HOUR_MIN && h < HOUR_MAX;
}

async function fetchChatwoot(path, opts = {}) {
  const url = `${CW.url}/api/v1/accounts/${CW.account}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: { api_access_token: CW.token, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) {
    throw Object.assign(new Error(`chatwoot ${res.status}: ${body?.message || JSON.stringify(body).slice(0,200)}`), { status: res.status, body });
  }
  return body;
}

async function ensureContactAndConversation(lead) {
  // Se o lead já tem conversa Chatwoot mapeada, reusa
  if (lead.chatwoot_conversation_id) {
    return { conversationId: lead.chatwoot_conversation_id, reused: true };
  }
  // Procura contato pelo telefone
  const phone = (lead.phone || '').replace(/\D/g, '');
  if (!phone) throw new Error('lead sem telefone');

  const search = await fetchChatwoot(`/contacts/search?q=${encodeURIComponent(phone)}`);
  let contact = (search?.payload || []).find(c => (c.phone_number || '').replace(/\D/g,'').endsWith(phone.slice(-9)));

  if (!contact) {
    const e164 = phone.startsWith('55') ? `+${phone}` : `+55${phone}`;
    const created = await fetchChatwoot('/contacts', {
      method: 'POST',
      body: JSON.stringify({ name: lead.name || 'Lead', phone_number: e164, inbox_id: parseInt(CW.inbox) }),
    });
    contact = created?.payload?.contact || created;
  }

  // Procura conversa existente nessa inbox
  const convs = await fetchChatwoot(`/contacts/${contact.id}/conversations`);
  let conv = (convs?.payload || []).find(c => String(c.inbox_id) === String(CW.inbox));
  if (!conv) {
    conv = await fetchChatwoot('/conversations', {
      method: 'POST',
      body: JSON.stringify({ contact_id: contact.id, inbox_id: parseInt(CW.inbox) }),
    });
  }
  return { conversationId: conv.id, reused: false };
}

async function sendTemplate(conversationId, template, leadName) {
  const body = (template.template_body || '').replace(/\{\{1\}\}/g, leadName || 'tudo bem?');
  await fetchChatwoot(`/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      message_type: 'outgoing',
      content: body,
      private: false,
      template_params: {
        name:     template.template_name,
        category: template.category || 'MARKETING',
        language: template.language || 'pt_BR',
        processed_params: { 1: leadName || '' },
      },
    }),
  });
}

async function pickTemplate(stage, categoria) {
  // Busca template específico da categoria, fallback pra genérico (categoria_filter null)
  const { data } = await supabase
    .from('crm_stage_templates')
    .select('*')
    .eq('stage', stage)
    .eq('enabled', true)
    .or(`categoria_filter.eq.${categoria},categoria_filter.is.null`)
    .order('categoria_filter', { ascending: false, nullsFirst: false }) // específicos primeiro
    .order('priority', { ascending: true })
    .limit(1);
  return data?.[0] || null;
}

/**
 * Função principal — chamada pelo webhook (auto) ou via redispatch_lead (manual).
 *
 * @param {object} lead       linha de crm_leads (ou crm_leads_full)
 * @param {string|null} categoria  categoria_ia atual
 * @param {object} opts
 * @param {boolean} opts.manual   true = vendedor clicou (pula AUTO_DISPATCH);
 *                                 cooldown ainda aplica pra evitar duplo-click
 *
 * Retorna { skipped: 'reason' } ou { dispatched: true, template_name, conversation_id }.
 */
async function dispatchAfterClassify(lead, categoria, opts = {}) {
  const manual = !!opts.manual;

  // GATE 1: kill switch global (não aplica em disparo manual)
  if (!manual && process.env.AIKON_AUTO_DISPATCH !== 'true') {
    return { skipped: 'auto_dispatch_disabled' };
  }

  // GATE 2: janela de horário (aplica sempre — não enviar à 1h da manhã)
  if (!isWithinDispatchWindow()) {
    return { skipped: 'outside_hours' };
  }

  // GATE 3: cooldown anti-spam (last_outbound_at < 30min)
  // Aplica também em manual: evita o vendedor clicar 2x em 5 segundos.
  if (lead.last_outbound_at) {
    const ageMs = Date.now() - new Date(lead.last_outbound_at).getTime();
    if (ageMs < COOLDOWN_MIN * 60 * 1000) {
      return { skipped: 'cooldown', age_min: Math.round(ageMs / 60000) };
    }
  }

  // GATE 4: quota diária do vendedor
  if (lead.assigned_to) {
    const { data: q } = await supabase
      .from('crm_daily_outbound')
      .select('count')
      .eq('user_id', lead.assigned_to)
      .eq('day', new Date().toISOString().slice(0,10))
      .maybeSingle();
    if ((q?.count || 0) >= DAILY_CAP) {
      return { skipped: 'daily_cap', count: q?.count };
    }
  }

  // GATE 5: template ativo para (stage, categoria).
  // stage default 'ativo' (lead respondeu — substitui antigo 'Qualificado').
  // Pode ser sobrescrito (ex: cron de reativação passa stage='ghost').
  const stage = opts.stage || 'ativo';
  const tpl = await pickTemplate(stage, categoria);
  if (!tpl) return { skipped: 'no_template', stage, categoria };

  // GATE 6: config Chatwoot
  if (!CW.url || !CW.token || !CW.inbox) {
    return { skipped: 'chatwoot_not_configured' };
  }

  // Tudo verde — dispara
  try {
    const { conversationId } = await ensureContactAndConversation(lead);
    await sendTemplate(conversationId, tpl, lead.name);

    const now = new Date().toISOString();
    await supabase.from('crm_leads').update({
      last_outbound_at: now,
      chatwoot_conversation_id: conversationId,
    }).eq('id', lead.id);

    await supabase.from('crm_attributions').insert({
      lead_id: lead.id,
      template_name:    tpl.template_name,
      template_id:      tpl.id,
      channel:          'whatsapp',
      category_at_time: categoria,
      outcome:          'sent',
      cost_brl:         COST_TEMPLATE_BRL,
      meta:             { conversation_id: conversationId, auto: true },
    });

    if (lead.assigned_to) {
      await supabase.rpc('bump_daily_outbound', { p_user: lead.assigned_to });
    }

    await supabase.from('crm_stage_templates')
      .update({ last_dispatched_at: now })
      .eq('id', tpl.id);

    await supabase.from('crm_activity').insert({
      lead_id: lead.id,
      action: 'Template disparado',
      detail: opts.reactivation
        ? `Reativação ${opts.reactivationDays || ''}d: ${tpl.template_name}`.trim()
        : `Auto: ${tpl.template_name} (${categoria})`,
      responsible: opts.reactivation ? 'Cron (reativação)' : 'AIKON (auto)',
    });

    return { dispatched: true, template_name: tpl.template_name, conversation_id: conversationId };
  } catch (e) {
    // Falha registrada como atribuição failed
    await supabase.from('crm_attributions').insert({
      lead_id: lead.id,
      template_name: tpl.template_name,
      template_id: tpl.id,
      channel: 'whatsapp',
      category_at_time: categoria,
      outcome: 'failed',
      cost_brl: 0,
      meta: { error: e.message, status: e.status },
    });
    console.error('cw-dispatch error:', e.message);
    return { skipped: 'send_failed', error: e.message };
  }
}

module.exports = { dispatchAfterClassify };
