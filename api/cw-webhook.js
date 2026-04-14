/**
 * Vercel Serverless Function — Chatwoot Webhook + AIKON
 *
 * Fluxo:
 *  1. Lead responde 1/2/3 → classifica categoria_ia
 *  2. AIKON envia Mensagem 1 para a categoria
 *  3. Conversa segue o script até proposta de reunião
 *  4. Lead aceita → recebe link Calendly + status vira Reunião Marcada
 *
 * Variáveis de ambiente (Vercel):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY
 *   ANTHROPIC_API_KEY        — classificação texto livre (opcional)
 *   CHATWOOT_URL             — ex: https://app.chatwoot.com
 *   CHATWOOT_ACCOUNT_ID
 *   CHATWOOT_TOKEN           — api_access_token do agente/bot
 *   CALENDLY_URL             — link de agendamento (ex: https://calendly.com/zeve/reuniao)
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Classificação inicial (1/2/3 ou texto livre) ──────────────
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

// ── Detecção de subtipo (dor do lead) ────────────────────────
function detectarSubtipo(texto, categoria) {
  const t = norm(texto);
  if (categoria === 'Aumentar Lotes') {
    if (['capital', 'dinheiro', 'banca', 'grana', 'caro', 'custo', 'recurso'].some(w => t.includes(w))) return 'capital';
    if (['medo', 'trava', 'ansio', 'nervo', 'emocio', 'psicolo', 'insegu'].some(w => t.includes(w)))    return 'psicologico';
    return 'estrategia';
  }
  if (categoria === 'Inconsistente') {
    if (['execu', 'saio', 'stop', 'ordem', 'botao', 'tarde', 'cedo', 'respeito'].some(w => t.includes(w))) return 'execucao';
    if (['emocio', 'medo', 'ganci', 'ansio', 'psicolo', 'senti'].some(w => t.includes(w)))                 return 'emocional';
    return 'estrategia';
  }
  if (categoria === 'Começando') {
    if (['assessor', 'robo', 'profiss', 'direto', 'rapido', 'result'].some(w => t.includes(w))) return 'assessoria';
    return 'treinamento';
  }
  return 'padrao';
}

function aceitouReuniao(texto) {
  const t = norm(texto);
  return ['sim', 'pode', 'vamos', 'quero', 'ok', 'topo', 'agend', 'quando', 'horario', 'claro', 'com certeza', 'perfeito', 'show'].some(w => t.includes(w));
}

// ── Scripts AIKON ─────────────────────────────────────────────
function aikonMsg(categoria, stage, params = {}) {
  const { nome = 'trader', subtipo } = params;
  const calendly = process.env.CALENDLY_URL || '';

  const SCRIPTS = {
    'Aumentar Lotes': {
      msg1: `Oi ${nome}! Aqui é o AIKON, da Zeve.\n\nVi que você já opera — parabéns, isso já coloca você à frente de 90% das pessoas que chegam aqui.\n\nMe conta uma coisa: qual é o principal freio que te impede de operar com lotes maiores hoje?\n\nCapital, confiança na estratégia ou algo diferente?`,
      msg2_capital:     `Faz sentido. É a limitação mais comum pra quem já sabe operar.\n\nA boa notícia: a Genial tem um modelo de assessoria onde você opera com capital deles, numa conta profissional, com a estrutura que você não conseguiria montar sozinho.\n\nSem precisar botar mais dinheiro próprio em risco.\n\nVocê tem uns 20 minutinhos essa semana pra eu te mostrar como funciona na prática?`,
      msg2_psicologico: `Isso é mais comum do que parece — o trader que sabe operar mas trava na hora de apertar o botão com lote maior.\n\nParte disso é gestão de risco mal estruturada. Quando você tem regras claras de banca e um robô executando sem emoção, esse travamento diminui bastante.\n\nPosso te mostrar como a gente resolve isso na prática. Tem 20 min essa semana?`,
      msg2_estrategia:  `Entendi. Ter resultado bom num mês e ruim no outro é mais frustrante do que não ter resultado nenhum — porque você sabe que o potencial tá lá.\n\nAqui na Zeve a gente trabalha exatamente esse ponto: criar consistência antes de escalar. Porque aumentar lote sem consistência só amplifica o problema.\n\nConsigo te mostrar o modelo que a gente usa com nossos assessorados. Tem 20 min essa semana?`,
      calendly:         `Ótimo! Aqui está o link pra você escolher o melhor horário:\n\n${calendly}\n\nAté lá! 👊`,
    },
    'Inconsistente': {
      msg1: `Oi ${nome}! AIKON aqui, da Zeve.\n\nVocê opera há quanto tempo, mais ou menos?\n\nPergunto porque quero entender seu contexto antes de qualquer coisa — não adianta eu te falar de solução sem saber o problema real.`,
      msg2: `Legal. E quando os resultados não vêm como você esperava, o que você percebe que acontece?\n\nÉ mais execução (sai tarde, não respeita stop), estratégia (setup não funciona em todos os cenários) ou gestão emocional (fica na mão quando deveria sair)?`,
      msg3_execucao:  `Execução é provavelmente o problema mais caro do trader — porque você pode ter o setup certo e ainda assim perder por sair na hora errada.\n\nO Robô Artur resolve exatamente isso: ele executa sem emoção, no momento exato, com a gestão de risco que você configurou.\n\nVocê já pensou em automatizar parte da sua operação?`,
      msg3_emocional: `Gestão emocional é o calcanhar de Aquiles de 80% dos traders — inclusive dos bons.\n\nA solução mais eficiente que a gente encontrou não é controle emocional — é remover a emoção da equação. O robô não tem medo, não tem ganância, não sai antes da hora.\n\nVocê já considerou automatizar as entradas e saídas?`,
      msg3_estrategia:`Quando a estratégia funciona em alguns meses e não em outros, geralmente é sinal de que ela não está adaptada ao regime de mercado.\n\nNa Zeve, a gente trabalha com estratégias que têm edge documentado — não é achismo, é estatística.\n\nVale a pena você conhecer como a gente estrutura isso. Tem 20 min essa semana?`,
      proposta:       `${nome}, pelo que você me descreveu, acho que consigo te mostrar exatamente onde está o gap.\n\nA gente faz uma análise rápida da sua operação atual e eu te mostro o que seria diferente com a estrutura da Zeve.\n\nSem compromisso — é uma conversa de diagnóstico. Tem 20 minutinhos essa semana?`,
      calendly:       `Ótimo! Aqui está o link pra você escolher o melhor horário:\n\n${calendly}\n\nAté lá! 👊`,
    },
    'Começando': {
      msg1: `Oi ${nome}! AIKON aqui, da Zeve.\n\nMe conta: você está no começo da jornada no mercado financeiro ou já fez alguma operação?\n\nPergunto pra entender por onde faz sentido a gente começar a conversa.`,
      msg2: `Entendido!\n\nE o que te trouxe até aqui? O que te fez começar a se interessar por trading?\n\n(Pergunto porque o caminho certo é diferente pra cada objetivo — renda extra, aposentadoria, saída do emprego...)`,
      msg3: `${nome}, baseado no que você me contou, acho que o melhor primeiro passo pra você não é abrir conta e sair operando — é entender como funciona o mercado sem correr risco desnecessário.\n\nA Zeve tem um ecossistema pensado exatamente pra isso: você aprende a lógica, depois entra com estrutura, não no escuro.\n\nVocê prefere começar pelo treinamento ou prefere já conhecer como funciona a assessoria profissional?`,
      msg4_treinamento: `Ótimo ponto de partida.\n\nO treinamento da Zeve não é teórico — é prático, com operações reais sendo mostradas ao vivo.\n\nVocê participa junto, entende a lógica, e quando se sentir pronto, já tem a estrutura pra operar com mais segurança.\n\nTem 20 minutinhos essa semana pra eu te mostrar como funciona o programa?`,
      msg4_assessoria:  `Também é uma opção válida — especialmente se você quer resultado mais rápido sem precisar virar especialista.\n\nA assessoria coloca você numa conta profissional com estratégia já validada. Você não precisa saber analisar gráfico pra começar.\n\nVale a pena conhecer. Tem 20 min essa semana?`,
      calendly:         `Ótimo! Aqui está o link pra você escolher o melhor horário:\n\n${calendly}\n\nAté lá! 👊`,
    },
  };

  const s = SCRIPTS[categoria];
  if (!s) return null;

  if (stage === 'msg1') return s.msg1;
  if (stage === 'msg2') {
    if (categoria === 'Aumentar Lotes') return s[`msg2_${subtipo}`] || s.msg2_estrategia;
    return s.msg2;
  }
  if (stage === 'msg3') {
    if (categoria === 'Inconsistente') return s[`msg3_${subtipo}`] || s.msg3_estrategia;
    return s.msg3;
  }
  if (stage === 'msg4') {
    if (categoria === 'Começando') return s[`msg4_${subtipo}`] || s.msg4_treinamento;
    if (categoria === 'Inconsistente') return s.proposta;
  }
  if (stage === 'calendly') return s.calendly;
  return null;
}

// ── Envio de mensagem via Chatwoot ────────────────────────────
async function enviarMensagemChatwoot(conversationId, message) {
  const url   = process.env.CHATWOOT_URL;
  const accId = process.env.CHATWOOT_ACCOUNT_ID;
  const token = process.env.CHATWOOT_TOKEN;
  if (!url || !accId || !token || !conversationId) {
    console.log('AIKON: CHATWOOT_* não configurado, mensagem não enviada');
    return false;
  }
  try {
    const r = await fetch(`${url}/api/v1/accounts/${accId}/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'api_access_token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ content: message, message_type: 'outgoing', private: false }),
    });
    console.log(`AIKON → conv ${conversationId}: ${r.ok ? 'OK' : r.status}`);
    return r.ok;
  } catch (e) {
    console.log('AIKON envio error:', e.message);
    return false;
  }
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

  const SELECT = 'id, name, status, status_ia, categoria_ia, aikon_stage, aikon_subtipo, cw_conversation_id';

  try {
    const { data: rpc } = await supabase.rpc('find_lead_by_digits', { search_digits: tail });
    if (rpc?.length) return rpc[0];
  } catch {
    console.log('RPC indisponível, usando ilike');
  }

  const { data } = await supabase
    .from('crm_leads')
    .select(SELECT)
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

    const content        = payload.content || payload.message?.content || '';
    const phone          = payload.conversation?.meta?.sender?.phone_number
                        || payload.sender?.phone_number
                        || payload.contact?.phone_number
                        || '';
    const conversationId = payload.conversation?.id;

    console.log(`WEBHOOK: "${content}" | phone: ${phone} | conv: ${conversationId}`);

    if (!content || !phone) {
      return res.status(200).json({ ok: true, skip: 'no content or phone' });
    }

    const lead = await buscarLeadPorTelefone(phone);
    if (!lead) {
      console.log(`Lead não encontrado: ${phone}`);
      return res.status(200).json({ ok: true, skip: 'lead not found' });
    }

    const now    = new Date().toISOString();
    const convId = conversationId || lead.cw_conversation_id;
    const nome   = (lead.name || 'trader').split(' ')[0];

    // ── Fase 1: Classificação inicial ─────────────────────────
    if (!lead.categoria_ia) {
      const categoria = await classificar(content);
      if (!categoria) {
        await supabase.from('crm_leads')
          .update({ status_ia: 'Respondeu', updated_at: now })
          .eq('id', lead.id);
        return res.status(200).json({ ok: true, skip: 'unclassified' });
      }

      const msg = aikonMsg(categoria, 'msg1', { nome });
      await supabase.from('crm_leads').update({
        categoria_ia:       categoria,
        status_ia:          'Respondeu',
        status:             lead.status === 'IA Disparou' ? 'Qualificado' : lead.status,
        aikon_stage:        'msg1_aguardando',
        cw_conversation_id: String(convId),
        updated_at:         now,
      }).eq('id', lead.id);

      if (msg) await enviarMensagemChatwoot(convId, msg);
      console.log(`✅ #${lead.id} classificado: ${categoria} → msg1 enviada`);
      return res.status(200).json({ ok: true, lead_id: lead.id, categoria, aikon: 'msg1_sent' });
    }

    // ── Fase 2: Conversa AIKON em andamento ───────────────────
    const { categoria_ia: categoria, aikon_stage: stage, aikon_subtipo: subtipoSalvo } = lead;
    console.log(`AIKON: stage=${stage} | categoria=${categoria}`);

    // msg1_aguardando → detecta dor e envia msg2 (ou msg2 + proposta para Aumentar Lotes)
    if (stage === 'msg1_aguardando') {
      const subtipo = detectarSubtipo(content, categoria);
      const msg     = aikonMsg(categoria, 'msg2', { nome, subtipo });
      if (msg) await enviarMensagemChatwoot(convId, msg);

      // Aumentar Lotes: msg2 já tem CTA de reunião → vai para proposta_enviada
      const proximoStage = categoria === 'Aumentar Lotes' ? 'proposta_enviada' : 'msg2_aguardando';
      await supabase.from('crm_leads').update({
        aikon_stage:   proximoStage,
        aikon_subtipo: subtipo,
        updated_at:    now,
      }).eq('id', lead.id);
      return res.status(200).json({ ok: true, aikon: 'msg2_sent', subtipo });
    }

    // msg2_aguardando → envia msg3 (diagnóstico → solução para Inconsistente; escolha para Começando)
    if (stage === 'msg2_aguardando') {
      const subtipo = detectarSubtipo(content, categoria);
      const msg     = aikonMsg(categoria, 'msg3', { nome, subtipo });
      if (msg) await enviarMensagemChatwoot(convId, msg);
      await supabase.from('crm_leads').update({
        aikon_stage:   'msg3_aguardando',
        aikon_subtipo: subtipo,
        updated_at:    now,
      }).eq('id', lead.id);
      return res.status(200).json({ ok: true, aikon: 'msg3_sent', subtipo });
    }

    // msg3_aguardando → proposta de reunião (Inconsistente) ou msg4 com CTA (Começando)
    if (stage === 'msg3_aguardando') {
      const subtipo = categoria === 'Começando'
        ? detectarSubtipo(content, categoria)
        : (subtipoSalvo || 'padrao');
      const msg = aikonMsg(categoria, 'msg4', { nome, subtipo });
      if (msg) await enviarMensagemChatwoot(convId, msg);
      await supabase.from('crm_leads').update({
        aikon_stage:   'proposta_enviada',
        aikon_subtipo: subtipo,
        updated_at:    now,
      }).eq('id', lead.id);
      return res.status(200).json({ ok: true, aikon: 'proposta_sent' });
    }

    // proposta_enviada → detecta aceitação e envia link Calendly
    if (stage === 'proposta_enviada') {
      if (aceitouReuniao(content)) {
        const msg = aikonMsg(categoria, 'calendly', { nome });
        if (msg) await enviarMensagemChatwoot(convId, msg);
        await supabase.from('crm_leads').update({
          status:      'Reunião Marcada',
          aikon_stage: 'reuniao_agendada',
          updated_at:  now,
        }).eq('id', lead.id);
        console.log(`🎯 #${lead.id} aceitou reunião!`);
        return res.status(200).json({ ok: true, aikon: 'reuniao_agendada' });
      }
      // Não aceitou claramente → humano assume
      return res.status(200).json({ ok: true, skip: 'awaiting_human', stage });
    }

    // Qualquer outro stage (reuniao_agendada, etc.) → humano
    return res.status(200).json({ ok: true, skip: 'human_stage', stage });

  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
