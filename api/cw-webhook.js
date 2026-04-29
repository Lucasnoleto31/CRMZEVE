/**
 * Vercel Serverless Function — Chatwoot Webhook
 *
 * Recebe mensagens do Chatwoot, classifica a resposta do lead
 * e atualiza categoria_ia + status no Supabase automaticamente.
 *
 * Variáveis de ambiente:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   ANTHROPIC_API_KEY (opcional — classificação por texto livre)
 */

const { createClient } = require('@supabase/supabase-js');
const { dispatchAfterClassify } = require('./cw-dispatch');

// Detecta se a SUPABASE_SERVICE_KEY configurada é, de fato, a service_role.
// Se alguém colocou a anon key por engano, RLS vai bloquear os updates e o
// webhook falha silenciosamente — melhor gritar cedo no log.
function inspectKeyRole(jwt) {
  if (!jwt) return 'MISSING';
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString('utf8'));
    return payload.role || 'unknown';
  } catch { return 'invalid_jwt'; }
}
const SB_KEY_ROLE = inspectKeyRole(process.env.SUPABASE_SERVICE_KEY);
if (SB_KEY_ROLE !== 'service_role') {
  console.error(`⚠️  cw-webhook: SUPABASE_SERVICE_KEY tem role="${SB_KEY_ROLE}" — esperado "service_role". RLS bloqueará updates.`);
} else {
  console.log('cw-webhook: usando service_role (OK)');
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Classificação ─────────────────────────────────────────────
const MAPA_NUMEROS = { '1': 'Começando', '2': 'Aumentar Lotes', '3': 'Inconsistente' };

const MAPA_KEYWORDS = {
  'Começando':      ['começ', 'iniciante', 'novo', 'aprender', 'ainda não', 'nunca operei', 'primeira vez'],
  'Aumentar Lotes': ['aumentar', 'crescer', 'escalar', 'maior lote', 'mais lote', 'já opero', 'já opera'],
  'Inconsistente':  ['inconsistent', 'às vezes', 'irregular', 'resultado ruim', 'não sei', 'perco', 'bagunça'],
};

function norm(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function classificarPorKeyword(texto) {
  const t = norm(texto);
  for (const [cat, palavras] of Object.entries(MAPA_KEYWORDS)) {
    if (palavras.some(p => t.includes(norm(p)))) return cat;
  }
  return null;
}

async function classificarComClaude(texto) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        system: `Classifique traders. Responda SOMENTE com uma das opções:
- Começando
- Aumentar Lotes
- Inconsistente`,
        messages: [{ role: 'user', content: texto }],
      }),
    });
    const data = await res.json();
    const r = data?.content?.[0]?.text?.trim();
    if (r?.includes('Começando'))      return 'Começando';
    if (r?.includes('Aumentar Lotes')) return 'Aumentar Lotes';
    if (r?.includes('Inconsistente'))  return 'Inconsistente';
    return null;
  } catch { return null; }
}

async function classificar(texto) {
  const t = texto.trim();
  const num = t.replace(/[^\d]/g, '');
  if (MAPA_NUMEROS[num]) return MAPA_NUMEROS[num];
  if (t.includes('1️⃣') || t === '1') return 'Começando';
  if (t.includes('2️⃣') || t === '2') return 'Aumentar Lotes';
  if (t.includes('3️⃣') || t === '3') return 'Inconsistente';
  const kw = classificarPorKeyword(t);
  if (kw) return kw;
  if (t.length > 3) return await classificarComClaude(t);
  return null;
}

// ── Busca lead por telefone (ignora formatação) ───────────────
// Usa find_lead_by_phone_strict (Fase 1): tenta últimos 11/10/9 dígitos
// nessa ordem; só retorna match dos últimos 9 se for único — evita
// colisão silenciosa entre dois leads com final igual.
async function buscarLeadPorTelefone(phone) {
  const digits = phone.replace(/\D/g, '');
  console.log(`BUSCA: "${phone}" → digits="${digits}"`);

  // RPC nova (find_lead_by_phone_strict) — preferida
  try {
    const { data: rpc } = await supabase.rpc('find_lead_by_phone_strict', { search_digits: digits });
    if (rpc?.length) return rpc[0];
  } catch (e) {
    console.log(`RPC strict falhou (${e.message}), tentando legacy`);
  }

  // Fallback legacy (find_lead_by_digits) — para deploys onde a Fase 1
  // ainda não rodou. Pode ser removido após confirmação.
  try {
    const tail = digits.length >= 8 ? digits.slice(-8) : digits;
    const { data: rpc } = await supabase.rpc('find_lead_by_digits', { search_digits: tail });
    if (rpc?.length) return rpc[0];
  } catch { /* segue para ilike */ }

  // Último recurso: ilike com últimos 9 dígitos
  const tail9 = digits.slice(-9);
  const { data } = await supabase
    .from('crm_leads')
    .select('*')
    .ilike('phone', `%${tail9}%`)
    .limit(2);
  // Só retorna se for inequívoco
  return data?.length === 1 ? data[0] : null;
}

// ── Cria notificação in-app para o vendedor responsável ───────
// O CRM tem polling em crm_notifications (Fase 3 adiciona push). Inserir
// aqui já habilita o badge mesmo antes da Fase 3 estar deployada.
async function notify(userId, leadId, type, message) {
  if (!userId) return;
  try {
    await supabase.from('crm_notifications').insert({
      user_id: userId,
      lead_id: leadId,
      type,
      message,
    });
  } catch (e) {
    console.error('notify falhou:', e.message);
  }
}

// ── Registra atribuição (qual disparo/mensagem rendeu o quê) ──
async function attribute(leadId, outcome, extras = {}) {
  try {
    await supabase.from('crm_attributions').insert({
      lead_id: leadId,
      outcome,
      template_name:    extras.template_name || null,
      channel:          extras.channel || 'whatsapp',
      category_at_time: extras.category || null,
      cost_brl:         extras.cost_brl || 0,
      meta:             extras.meta || null,
    });
  } catch (e) {
    console.error('attribute falhou:', e.message);
  }
}

// ── Handler principal ─────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const payload = req.body || {};

    // Mensagem saindo: registra last_outbound_at para gating de anti-spam
    // (Fase 5 usa esse campo). Não classifica nem notifica.
    if (payload.message_type === 'outgoing') {
      const phone = payload.conversation?.meta?.sender?.phone_number
                 || payload.sender?.phone_number
                 || payload.contact?.phone_number || '';
      const convId = payload.conversation?.id || null;
      if (phone) {
        const lead = await buscarLeadPorTelefone(phone);
        if (lead) {
          await supabase.from('crm_leads').update({
            last_outbound_at: new Date().toISOString(),
            chatwoot_conversation_id: convId || lead.chatwoot_conversation_id,
          }).eq('id', lead.id);
        }
      }
      return res.status(200).json({ ok: true, skip: 'outgoing', tracked: true });
    }

    const content = payload.content || payload.message?.content || '';
    const phone   = payload.conversation?.meta?.sender?.phone_number
                 || payload.sender?.phone_number
                 || payload.contact?.phone_number
                 || '';
    const convId  = payload.conversation?.id || null;

    console.log(`WEBHOOK: "${content}" | phone: ${phone} | conv: ${convId}`);

    if (!content || !phone) {
      return res.status(200).json({ ok: true, skip: 'no content or phone' });
    }

    const lead = await buscarLeadPorTelefone(phone);
    if (!lead) {
      console.log(`Lead não encontrado: ${phone}`);
      return res.status(200).json({ ok: true, skip: 'lead not found' });
    }

    const now = new Date().toISOString();

    // Sempre registra: lead respondeu agora (mesmo se já classificado).
    // Isso alimenta SLA "respondeu há quanto tempo?" e ordenação de Hoje.
    const baseUpdate = {
      last_inbound_at: now,
      updated_at:      now,
    };
    if (convId && !lead.chatwoot_conversation_id) {
      baseUpdate.chatwoot_conversation_id = convId;
    }

    // Se já tem categoria, só atualiza last_inbound + notifica novamente
    // (vendedor precisa saber que o lead voltou a falar).
    if (lead.categoria_ia) {
      await supabase.from('crm_leads').update(baseUpdate).eq('id', lead.id);
      await notify(
        lead.assigned_to,
        lead.id,
        'lead_replied',
        `${lead.name || 'Lead'} respondeu de novo no WhatsApp`
      );
      await attribute(lead.id, 'responded', { category: lead.categoria_ia });
      return res.status(200).json({ ok: true, skip: 'already classified', categoria: lead.categoria_ia });
    }

    const categoria = await classificar(content);

    if (!categoria) {
      // Respondeu algo não-classificável (ex.: "obrigado"). Marca status_ia
      // e notifica o vendedor pra ele ler e seguir manualmente.
      await supabase.from('crm_leads').update({
        ...baseUpdate,
        status_ia: 'Respondeu',
      }).eq('id', lead.id);
      await notify(
        lead.assigned_to,
        lead.id,
        'lead_replied_unclassified',
        `${lead.name || 'Lead'} respondeu mas não foi classificado — leia a mensagem`
      );
      await attribute(lead.id, 'responded', { meta: { unclassified: true, content: content.slice(0, 200) } });
      console.log(`⏳ Não classificado: "${content}"`);
      return res.status(200).json({ ok: true, skip: 'unclassified' });
    }

    // Classificou: muda status para Qualificado se vinha de IA Disparou,
    // grava categoria + last_inbound, e notifica o vendedor (URGENTE).
    const newStatus = lead.status === 'IA Disparou' ? 'Qualificado' : lead.status;
    const stageChanged = newStatus !== lead.status;

    await supabase.from('crm_leads').update({
      ...baseUpdate,
      categoria_ia:      categoria,
      status_ia:         'Respondeu',
      status:            newStatus,
      stage_entered_at:  stageChanged ? now.slice(0, 10) : lead.stage_entered_at,
    }).eq('id', lead.id);

    await notify(
      lead.assigned_to,
      lead.id,
      'lead_qualified',
      `🔥 ${lead.name || 'Lead'} qualificado como "${categoria}" — abra agora`
    );
    await attribute(lead.id, 'qualified', { category: categoria });

    // Disparo automático AIKON (gate AIKON_AUTO_DISPATCH=true em env)
    // Lê o lead já atualizado pra checar last_outbound_at corretamente
    const { data: freshLead } = await supabase
      .from('crm_leads').select('*').eq('id', lead.id).single();
    if (freshLead) {
      const result = await dispatchAfterClassify(freshLead, categoria).catch(e => ({ skipped: 'crash', error: e.message }));
      console.log(`AIKON dispatch #${lead.id}:`, JSON.stringify(result));
    }

    // Log de atividade (timeline do drawer)
    try {
      await supabase.from('crm_activity').insert({
        lead_id: lead.id,
        action: 'Qualificação alterada',
        detail: `IA classificou como ${categoria}`,
        responsible: 'IA (webhook)',
      });
      if (stageChanged) {
        await supabase.from('crm_activity').insert({
          lead_id: lead.id,
          action: 'Status alterado',
          detail: `${lead.status} → ${newStatus} (auto)`,
          responsible: 'IA (webhook)',
        });
      }
    } catch (e) { console.error('activity log:', e.message); }

    console.log(`✅ #${lead.id} (${lead.name}) classificado: ${categoria}`);
    return res.status(200).json({ ok: true, lead_id: lead.id, categoria, status: newStatus });

  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
