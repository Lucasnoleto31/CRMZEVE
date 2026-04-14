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
async function buscarLeadPorTelefone(phone) {
  const digits  = phone.replace(/\D/g, '');
  const semPais = digits.startsWith('55') ? digits.slice(2) : digits;
  let searchDigits = semPais;
  if (semPais.length === 11 && semPais[2] === '9') {
    searchDigits = semPais.slice(0, 2) + semPais.slice(3);
  }
  const tail = searchDigits.slice(-8);
  console.log(`BUSCA: "${phone}" → tail="${tail}"`);

  try {
    const { data: rpc } = await supabase.rpc('find_lead_by_digits', { search_digits: tail });
    if (rpc?.length) return rpc[0];
  } catch {
    console.log('RPC indisponível, usando ilike');
  }

  const { data } = await supabase
    .from('crm_leads')
    .select('id, name, status, status_ia, categoria_ia')
    .ilike('phone', `%${tail}%`)
    .limit(1);
  return data?.[0] || null;
}

// ── Handler principal ─────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const payload = req.body || {};

    if (payload.message_type === 'outgoing') {
      return res.status(200).json({ ok: true, skip: 'outgoing' });
    }

    const content = payload.content || payload.message?.content || '';
    const phone   = payload.conversation?.meta?.sender?.phone_number
                 || payload.sender?.phone_number
                 || payload.contact?.phone_number
                 || '';

    console.log(`WEBHOOK: "${content}" | phone: ${phone}`);

    if (!content || !phone) {
      return res.status(200).json({ ok: true, skip: 'no content or phone' });
    }

    const lead = await buscarLeadPorTelefone(phone);
    if (!lead) {
      console.log(`Lead não encontrado: ${phone}`);
      return res.status(200).json({ ok: true, skip: 'lead not found' });
    }

    // Se já tem categoria, não sobrescreve
    if (lead.categoria_ia) {
      return res.status(200).json({ ok: true, skip: 'already classified', categoria: lead.categoria_ia });
    }

    const now      = new Date().toISOString();
    const categoria = await classificar(content);

    if (!categoria) {
      await supabase.from('crm_leads')
        .update({ status_ia: 'Respondeu', updated_at: now })
        .eq('id', lead.id);
      console.log(`⏳ Não classificado: "${content}"`);
      return res.status(200).json({ ok: true, skip: 'unclassified' });
    }

    await supabase.from('crm_leads').update({
      categoria_ia: categoria,
      status_ia:    'Respondeu',
      status:       lead.status === 'IA Disparou' ? 'Qualificado' : lead.status,
      updated_at:   now,
    }).eq('id', lead.id);

    console.log(`✅ #${lead.id} (${lead.name}) classificado: ${categoria}`);
    return res.status(200).json({ ok: true, lead_id: lead.id, categoria });

  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
