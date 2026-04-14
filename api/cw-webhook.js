/**
 * Vercel Serverless Function — Chatwoot Webhook
 *
 * Recebe mensagens do Chatwoot, classifica a resposta do lead
 * e atualiza categoria_ia + status no Supabase automaticamente.
 *
 * Configurar no Chatwoot:
 *   Settings → Integrations → Webhooks → Add new webhook
 *   URL: https://SEU-DOMINIO.vercel.app/api/cw-webhook
 *   Eventos: message_created
 *
 * Variáveis de ambiente no Vercel:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   ANTHROPIC_API_KEY (opcional — só para classificação por texto livre)
 *   CW_WEBHOOK_SECRET (opcional — para validar origem do webhook)
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Mapeamento simples: número → categoria ────────────────────
const MAPA_NUMEROS = {
  '1': 'Começando',
  '2': 'Aumentar Lotes',
  '3': 'Inconsistente',
};

// Palavras-chave para classificação sem LLM
const MAPA_KEYWORDS = {
  'Começando':      ['começ', 'iniciante', 'começan', 'novo', 'aprender', 'ainda não', 'nunca operei', 'quero entrar', 'primeira vez'],
  'Aumentar Lotes': ['aumentar', 'crescer', 'escalar', 'maior lote', 'mais lote', 'operando', 'quero crescer', 'já opero', 'já opera'],
  'Inconsistente':  ['inconsistent', 'às vezes', 'irregular', 'resultado ruim', 'resultado varia', 'não sei', 'perco', 'às vezes ganho', 'bagunça', 'descontrolad'],
};

function classificarPorKeyword(texto) {
  const t = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const [cat, palavras] of Object.entries(MAPA_KEYWORDS)) {
    if (palavras.some(p => t.includes(p.normalize('NFD').replace(/[\u0300-\u036f]/g, '')))) {
      return cat;
    }
  }
  return null;
}

async function classificarComClaude(texto) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        system: `Você classifica traders em 3 categorias. Responda SOMENTE com uma das opções:
- Começando
- Aumentar Lotes
- Inconsistente

Começando: ainda não opera ou está no início.
Aumentar Lotes: já opera e quer escalar/crescer.
Inconsistente: opera mas resultado varia ou é ruim.`,
        messages: [{ role: 'user', content: texto }],
      }),
    });

    const data = await res.json();
    const resposta = data?.content?.[0]?.text?.trim();
    if (MAPA_NUMEROS['1'] === resposta || MAPA_NUMEROS['2'] === resposta || MAPA_NUMEROS['3'] === resposta) return resposta;
    if (resposta?.includes('Começando'))      return 'Começando';
    if (resposta?.includes('Aumentar Lotes')) return 'Aumentar Lotes';
    if (resposta?.includes('Inconsistente'))  return 'Inconsistente';
    return null;
  } catch {
    return null;
  }
}

async function classificar(texto) {
  const t = texto.trim();

  // 1. Resposta numérica direta
  const num = t.replace(/[^\d]/g, '');
  if (MAPA_NUMEROS[num]) return MAPA_NUMEROS[num];

  // 2. Emoji com número (1️⃣ 2️⃣ 3️⃣)
  if (t.includes('1️⃣') || t.startsWith('1 ') || t === '1') return 'Começando';
  if (t.includes('2️⃣') || t.startsWith('2 ') || t === '2') return 'Aumentar Lotes';
  if (t.includes('3️⃣') || t.startsWith('3 ') || t === '3') return 'Inconsistente';

  // 3. Keyword matching
  const kw = classificarPorKeyword(t);
  if (kw) return kw;

  // 4. Claude (se configurado)
  if (t.length > 3) return await classificarComClaude(t);

  return null;
}

async function buscarLeadPorTelefone(phone) {
  const digits = phone.replace(/\D/g, '');
  // Remove código do país (55) se presente
  const semPais = digits.startsWith('55') ? digits.slice(2) : digits;

  // Tentativa 1: número completo (com ou sem 9)
  const { data: d1 } = await supabase
    .from('crm_leads')
    .select('id, name, categoria_ia, status, status_ia')
    .ilike('phone', `%${semPais.slice(-10)}%`)
    .limit(1);
  if (d1?.length) return d1[0];

  // Tentativa 2: remove o 9 do celular (11 dígitos → 10)
  // Ex: 62984555387 → 6284555387
  if (semPais.length === 11 && semPais[2] === '9') {
    const sem9 = semPais.slice(0, 2) + semPais.slice(3);
    const { data: d2 } = await supabase
      .from('crm_leads')
      .select('id, name, categoria_ia, status, status_ia')
      .ilike('phone', `%${sem9}%`)
      .limit(1);
    if (d2?.length) return d2[0];
  }

  // Tentativa 3: últimos 8 dígitos (fallback para números antigos)
  const { data: d3 } = await supabase
    .from('crm_leads')
    .select('id, name, categoria_ia, status, status_ia')
    .ilike('phone', `%${semPais.slice(-8)}%`)
    .limit(1);
  return d3?.[0] || null;
}

// ── Handler principal ─────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const payload = req.body || {};

    // Log completo para diagnóstico
    console.log('WEBHOOK RECEBIDO:', JSON.stringify({
      event:        payload.event,
      message_type: payload.message_type,
      content:      payload.content,
      sender_phone: payload.sender?.phone_number,
      conv_sender:  payload.conversation?.meta?.sender?.phone_number,
    }));

    // Ignora mensagens de saída (enviadas pelo bot/agente)
    if (payload.message_type === 'outgoing') {
      return res.status(200).json({ ok: true, skip: 'outgoing message' });
    }

    const content = payload.content || payload.message?.content || '';
    const phone   = payload.conversation?.meta?.sender?.phone_number
                 || payload.sender?.phone_number
                 || payload.contact?.phone_number
                 || '';

    console.log(`CONTENT: "${content}" | PHONE: "${phone}"`);

    if (!content || !phone) {
      return res.status(200).json({ ok: true, skip: 'no content or phone', payload_keys: Object.keys(payload) });
    }

    console.log(`📩 Webhook: "${content}" | telefone: ${phone}`);

    // Busca lead no Supabase
    const lead = await buscarLeadPorTelefone(phone);
    if (!lead) {
      console.log(`⚠️  Lead não encontrado para telefone: ${phone}`);
      return res.status(200).json({ ok: true, skip: 'lead not found' });
    }

    // Se já tem categoria, não sobrescreve
    if (lead.categoria_ia) {
      return res.status(200).json({ ok: true, skip: 'already classified', categoria: lead.categoria_ia });
    }

    // Classifica
    const categoria = await classificar(content);
    if (!categoria) {
      // Marca que respondeu mas não classificou ainda
      await supabase.from('crm_leads').update({
        status_ia:   'Respondeu',
        updated_at:  new Date().toISOString(),
      }).eq('id', lead.id);

      console.log(`⏳ Resposta não classificada: "${content}"`);
      return res.status(200).json({ ok: true, skip: 'unclassified', content });
    }

    // Atualiza CRM
    const updates = {
      categoria_ia: categoria,
      status_ia:    'Respondeu',
      status:       lead.status === 'IA Disparou' ? 'Qualificado' : lead.status,
      updated_at:   new Date().toISOString(),
    };

    const { error } = await supabase
      .from('crm_leads')
      .update(updates)
      .eq('id', lead.id);

    if (error) throw error;

    console.log(`✅ Lead #${lead.id} (${lead.name}) classificado: ${categoria}`);
    return res.status(200).json({ ok: true, lead_id: lead.id, categoria });

  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
