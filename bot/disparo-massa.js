// ═══════════════════════════════════════════════════════════════════════
// Disparo em massa — 5 templates aleatórios pra base de leads do CRM
// ─────────────────────────────────────────────────────────────────────────
// Uso:
//   node bot/disparo-massa.js                       # MODO DRY-RUN (default)
//   node bot/disparo-massa.js --executar            # DISPARA DE VERDADE
//   node bot/disparo-massa.js --executar --limit=50 # piloto em 50 leads
//   node bot/disparo-massa.js --delay=3000          # 3s entre envios
//   node bot/disparo-massa.js --incluir-todos       # ignora filtro de label
//                                                   # (default: só quem NÃO tem label)
//   node bot/disparo-massa.js --apenas-label=ghost  # MODO RECONTATO: inverte
//                                                   # filtro (só quem TEM essa label)
//                                                   # e troca pool pra TEMPLATES_RECONTATO
//   node bot/disparo-massa.js --mes=2026-06         # só leads que entraram na
//                                                   # comunidade nesse mês (campo entry)
//
// Por que dry-run é default: o disparo é ação irreversível e cara
// (~R$ 0,55/msg). Você precisa passar --executar explícito pra valer.
// O dry-run mostra a distribuição entre os 5 templates e o que SERIA
// disparado, sem chamar a API do Chatwoot.
//
// Lida com:
//   • Filtragem de LIDs (telefone inválido) antes do disparo
//   • Filtragem por LABELS do Chatwoot: dispara só pra quem NÃO tem
//     nenhuma etiqueta (= lead virgem, nunca classificado pelo time)
//     – inclui contatos sem registro no Chatwoot ainda
//     – exclui qualquer contato com pelo menos 1 label aplicada
//   • Sorteio aleatório entre os 5 templates a cada lead
//   • Confirmação dupla (precisa digitar EXATAMENTE 'DISPARAR' em caps)
//   • Rate-limit configurável entre envios
//   • Atualização de last_outbound_at + crm_activity por lead
//   • Log de progresso + sumário final por template
// ═══════════════════════════════════════════════════════════════════════

require('dotenv').config();
const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');
const { TEMPLATES_BOAS_VINDAS, TEMPLATES_RECONTATO } = require('./templates');

// Pool atual de templates pra sorteio. Setado em main() baseado nas flags.
let templatesPool = TEMPLATES_BOAS_VINDAS;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CW_URL     = (process.env.CHATWOOT_URL || '').replace(/\/$/, '');
const CW_ACCOUNT = process.env.CHATWOOT_ACCOUNT_ID || '';
const CW_TOKEN   = process.env.CHATWOOT_TOKEN || '';
const CW_INBOX   = process.env.CHATWOOT_INBOX_ID || '';

// Os 5 templates ficam em bot/templates.js — fonte única compartilhada
// com bot.js (que também rotaciona pra novos leads).

// ─── Helpers ─────────────────────────────────────────────────────────────

function isTelefoneValido(numero) {
  const digits = String(numero || '').replace(/\D/g, '');
  const local = digits.startsWith('55') ? digits.slice(2) : digits;
  return local.length === 10 || local.length === 11;
}

function toE164(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('55')) return `+${digits}`;
  return `+55${digits}`;
}

function sortearTemplate() {
  return templatesPool[Math.floor(Math.random() * templatesPool.length)];
}

async function cwApi(path, method = 'GET', body = null) {
  const url = `${CW_URL}/api/v1/accounts/${CW_ACCOUNT}${path}`;
  const opts = {
    method,
    headers: { 'api_access_token': CW_TOKEN, 'Content-Type': 'application/json' },
  };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text }; }
  if (!res.ok) throw new Error(`Chatwoot ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  return json;
}

function pergunta(rl, texto) {
  return new Promise(resolve => rl.question(texto, resolve));
}

// Carrega todos os contatos do Chatwoot com suas labels.
// Retorna Map<digits10, { id, labels[] }>, onde digits10 = últimos 10
// dígitos do telefone (mesma chave de dedupe usada no resto do projeto).
//
// Algumas instalações Chatwoot não devolvem labels no listing geral;
// nesse caso fazemos 1 call extra por contato pra preencher.
async function carregarContatosChatwoot() {
  console.log('⏳ Carregando contatos do Chatwoot...');
  const map = new Map();
  let page = 1;
  const perPage = 50;
  let total = null;
  let labelsNoListing = true;

  while (true) {
    const data = await cwApi(`/contacts?page=${page}&per_page=${perPage}`);
    const items = data?.payload || data?.data || [];
    if (total === null) total = data?.meta?.count ?? data?.meta?.total ?? null;
    if (!items.length) break;

    for (const c of items) {
      const phone = c.phone_number || c.contact?.phone_number || '';
      const digits10 = phone.replace(/\D/g, '').slice(-10);
      if (!digits10) continue;
      const id = c.id || c.contact?.id;
      if (!('labels' in c)) labelsNoListing = false;
      const labels = Array.isArray(c.labels) ? c.labels : [];
      map.set(digits10, { id, labels });
    }

    process.stdout.write(`\r   página ${page} — ${map.size} contatos${total ? ` / ~${total}` : ''}`);
    page++;
    if (page > 500) break;
    if (total && (page - 1) * perPage >= total) break;
  }
  process.stdout.write('\n');

  // Fallback: labels não vieram no listing — busca uma a uma
  if (!labelsNoListing && map.size > 0) {
    console.log(`   ⏳ Labels não vieram no listing. Buscando ${map.size} individualmente...`);
    let i = 0, erros = 0;
    for (const entry of map.values()) {
      i++;
      if (i % 50 === 0 || i === map.size) process.stdout.write(`\r   ${i}/${map.size}`);
      try {
        const detail = await cwApi(`/contacts/${entry.id}/labels`);
        const labels = detail?.payload?.labels || detail?.payload || [];
        entry.labels = Array.isArray(labels) ? labels : [];
      } catch {
        // Erro ao buscar = conservador, marca como "tem label" pra NÃO disparar.
        // Melhor pular do que arriscar disparar pra lead já classificado.
        entry.labels = ['_erro_busca_'];
        erros++;
      }
    }
    process.stdout.write('\n');
    if (erros > 0) {
      console.log(`   ⚠️  ${erros} erro(s) ao buscar labels — excluídos do disparo por segurança.`);
    }
  }

  return map;
}

// ─── Disparo (mesma lógica do bot.js, adaptada pra template direto) ──────

async function enviarTemplate(lead, template) {
  const phone = toE164(lead.phone);

  // 1. Busca/cria contato
  let contactId;
  try {
    const search = await cwApi(`/contacts/search?q=${encodeURIComponent(phone)}&page=1`);
    const found = search?.payload?.find(c => {
      const p = (c.phone_number || '').replace(/\D/g, '');
      return p.endsWith(phone.replace(/\D/g, '').slice(-10));
    });
    if (found) contactId = found.id;
  } catch { /* segue */ }

  if (!contactId) {
    try {
      const created = await cwApi('/contacts', 'POST', {
        name:         lead.name,
        phone_number: phone,
      });
      const contact = created?.contact || created?.payload?.contact || created?.payload || created;
      contactId = contact?.id;
      if (!contactId) throw new Error('createContact sem id');
    } catch (e) {
      if (/already been taken|422/.test(e.message)) {
        const digits = phone.replace(/\D/g, '');
        const search = await cwApi(`/contacts/search?q=${encodeURIComponent(digits.slice(-10))}&page=1`);
        const found = search?.payload?.find(c => {
          const p = (c.phone_number || '').replace(/\D/g, '');
          return p.endsWith(digits.slice(-10));
        });
        if (!found?.id) throw new Error('422 sem fallback');
        contactId = found.id;
      } else {
        throw e;
      }
    }
  }

  // 2. Busca/cria conversa
  let conversationId;
  try {
    const list = await cwApi(`/contacts/${contactId}/conversations`);
    const items = list?.payload || (Array.isArray(list) ? list : []);
    const existing = items.find(c => String(c.inbox_id) === String(CW_INBOX));
    if (existing?.id) conversationId = existing.id;
  } catch { /* segue */ }

  if (!conversationId) {
    let sourceId = null;
    try {
      const detail = await cwApi(`/contacts/${contactId}`);
      const payload = detail?.payload || detail;
      const inboxes = payload?.contact_inboxes || [];
      const match = inboxes.find(ci => String(ci?.inbox?.id || ci?.inbox_id) === String(CW_INBOX));
      if (match?.source_id) sourceId = match.source_id;
    } catch { /* segue */ }

    if (!sourceId) {
      let ci;
      try {
        ci = await cwApi(`/contacts/${contactId}/contact_inboxes`, 'POST', {
          inbox_id:  parseInt(CW_INBOX, 10),
          source_id: phone,
        });
      } catch (first) {
        if (/422|400/.test(first.message)) {
          ci = await cwApi(`/contacts/${contactId}/contact_inboxes`, 'POST', {
            inbox_id:  parseInt(CW_INBOX, 10),
            source_id: phone.replace(/\D/g, ''),
          });
        } else {
          throw first;
        }
      }
      sourceId = ci?.source_id || ci?.payload?.source_id;
      if (!sourceId) throw new Error('contact_inbox sem source_id');
    }

    const conv = await cwApi('/conversations', 'POST', {
      source_id:  sourceId,
      inbox_id:   parseInt(CW_INBOX, 10),
      contact_id: contactId,
    });
    conversationId = conv?.id || conv?.payload?.id;
    if (!conversationId) throw new Error('createConversation sem id');
  }

  // 3. Envia template (aprovado sem variáveis — processed_params vazio)
  await cwApi(`/conversations/${conversationId}/messages`, 'POST', {
    message_type: 'outgoing',
    private:      false,
    content:      template.template_body,
    template_params: {
      name:     template.template_name,
      category: template.category || 'MARKETING',
      language: template.language || 'pt_BR',
      processed_params: {},
    },
  });

  return { contactId, conversationId };
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const isExecutar = args.includes('--executar');
  const incluirTodos = args.includes('--incluir-todos');
  const apenasLabelArg = args.find(a => a.startsWith('--apenas-label='));
  const apenasLabel = apenasLabelArg ? apenasLabelArg.split('=')[1] : null;
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
  const delayArg = args.find(a => a.startsWith('--delay='));
  const delayMs = delayArg ? parseInt(delayArg.split('=')[1], 10) : 2000;

  // --mes=YYYY-MM: filtra por entry (data de entrada na comunidade) dentro
  // do mês. Vira range [primeiro-dia, primeiro-dia-do-mes-seguinte).
  const mesArg = args.find(a => a.startsWith('--mes='));
  let entryDesde = null, entryAte = null, mesLabel = null;
  if (mesArg) {
    const valor = mesArg.split('=')[1];
    const m = /^(\d{4})-(\d{2})$/.exec(valor);
    if (!m) {
      console.error(`❌ --mes inválido: "${valor}". Use o formato YYYY-MM (ex: --mes=2026-06).`);
      process.exit(1);
    }
    const ano = parseInt(m[1], 10);
    const mes = parseInt(m[2], 10);
    entryDesde = `${ano}-${String(mes).padStart(2, '0')}-01`;
    const proxAno = mes === 12 ? ano + 1 : ano;
    const proxMes = mes === 12 ? 1 : mes + 1;
    entryAte = `${proxAno}-${String(proxMes).padStart(2, '0')}-01`;
    mesLabel = `${ano}-${String(mes).padStart(2, '0')}`;
  }

  // Modo RECONTATO: --apenas-label=ghost troca o pool pra TEMPLATES_RECONTATO
  // e inverte o filtro (inclui só quem tem a label, em vez de quem não tem).
  // Pra outras labels (--apenas-label=cliente, por ex), mantém o pool default.
  const isModoRecontato = apenasLabel === 'ghost';
  if (isModoRecontato) {
    templatesPool = TEMPLATES_RECONTATO;
  }

  console.log('═══════════════════════════════════════════════════════');
  if (isModoRecontato) {
    console.log('  DISPARO EM MASSA — MODO RECONTATO (label \'ghost\')');
  } else if (apenasLabel) {
    console.log(`  DISPARO EM MASSA — APENAS com label '${apenasLabel}'`);
  } else {
    console.log(`  DISPARO EM MASSA — ${templatesPool.length} templates aleatórios pra base`);
  }
  console.log('═══════════════════════════════════════════════════════');
  if (!isExecutar) {
    console.log('  🟡 MODO DRY-RUN — nenhuma mensagem será enviada');
    console.log('     Pra disparar de verdade, rode com --executar');
  } else {
    console.log('  🔴 MODO EXECUÇÃO — disparos reais via Chatwoot/Meta');
  }
  if (apenasLabel) console.log(`  🏷  Filtro: só leads com label '${apenasLabel}'`);
  if (mesLabel) console.log(`  📅 Filtro: entry em ${mesLabel} (${entryDesde} a ${entryAte})`);
  console.log(`  📚 Pool de templates: ${templatesPool.length} (${templatesPool.map(t => t.template_name).join(', ')})`);
  if (limit) console.log(`  📐 Limite: ${limit} leads`);
  console.log(`  ⏱  Delay entre envios: ${delayMs}ms`);
  console.log('');

  // Valida config Chatwoot: precisa pra filtrar por labels (sempre que NÃO
  // for --incluir-todos) e pra disparar (sempre que for --executar).
  if (!incluirTodos || isExecutar) {
    if (!CW_URL || !CW_ACCOUNT || !CW_TOKEN || !CW_INBOX) {
      console.error('❌ Chatwoot não configurado (.env). Abortando.');
      console.error('   Necessário pra filtrar por labels. Use --incluir-todos pra rodar sem Chatwoot.');
      process.exit(1);
    }
  }
  if (isExecutar) {
    const placeholders = templatesPool.filter(t => t.template_name.startsWith('COLE_AQUI_'));
    if (placeholders.length > 0) {
      console.error(`❌ ${placeholders.length} template(s) ainda com placeholder COLE_AQUI_. Edite bot/templates.js antes de executar:`);
      placeholders.forEach(t => console.error(`   • ${t.template_name}`));
      process.exit(1);
    }
  }

  // 1. Carrega base (paginado, filtrado por mês no servidor se --mes foi passado)
  console.log('⏳ Carregando leads do CRM...');
  let fromRow = 0;
  const pageSize = 1000;
  const leads = [];
  while (true) {
    let query = supabase
      .from('crm_leads')
      .select('id, name, phone, status, entry')
      .order('created_at', { ascending: true });
    if (entryDesde) query = query.gte('entry', entryDesde);
    if (entryAte)   query = query.lt('entry', entryAte);
    const { data, error } = await query.range(fromRow, fromRow + pageSize - 1);
    if (error) {
      console.error('❌ Erro ao ler crm_leads:', error.message);
      process.exit(1);
    }
    if (!data || data.length === 0) break;
    leads.push(...data);
    if (data.length < pageSize) break;
    fromRow += pageSize;
  }
  console.log(`✅ ${leads.length} leads carregados${mesLabel ? ` (entry em ${mesLabel})` : ''}.\n`);

  // 2. Filtra inválidos (LIDs)
  const validos = leads.filter(l => isTelefoneValido(l.phone));
  const invalidos = leads.length - validos.length;
  if (invalidos > 0) {
    console.log(`⚠️  ${invalidos} lead(s) com telefone inválido (LID) — ignorados.`);
  }

  // 3. Filtro por etiquetas do Chatwoot
  //    Default (sem flag): dispara só pra quem NÃO tem nenhuma label.
  //    --apenas-label=X: INVERTE — dispara só pra quem tem essa label.
  //    --incluir-todos: ignora filtro.
  let elegiveis;
  if (incluirTodos) {
    elegiveis = validos;
    console.log('🟢 Flag --incluir-todos ativa: sem filtro de labels.\n');
  } else {
    const contatosCw = await carregarContatosChatwoot();
    console.log(`✅ ${contatosCw.size} contato(s) no Chatwoot mapeado(s).`);

    let comLabel = 0, semLabel = 0;
    contatosCw.forEach(c => (c.labels.length > 0 ? comLabel++ : semLabel++));
    console.log(`   📊 Com label: ${comLabel}  |  Sem label: ${semLabel}\n`);

    if (apenasLabel) {
      // Modo recontato / segmentado: INCLUI só quem tem a label especificada
      elegiveis = validos.filter(lead => {
        const digits10 = String(lead.phone).replace(/\D/g, '').slice(-10);
        const cw = contatosCw.get(digits10);
        return cw && cw.labels.includes(apenasLabel);
      });
      const ignorados = validos.length - elegiveis.length;
      console.log(`🎯 ${elegiveis.length} lead(s) com label '${apenasLabel}' — vão receber disparo.`);
      console.log(`   ${ignorados} lead(s) sem essa label — ignorados.\n`);
    } else {
      // Default: EXCLUI quem tem qualquer label
      const excluidos = [];
      elegiveis = validos.filter(lead => {
        const digits10 = String(lead.phone).replace(/\D/g, '').slice(-10);
        const cw = contatosCw.get(digits10);
        if (!cw) return true;
        if (cw.labels.length === 0) return true;
        excluidos.push({ lead, labels: cw.labels });
        return false;
      });

      if (excluidos.length > 0) {
        const labelCounts = {};
        excluidos.forEach(({ labels }) => labels.forEach(l => {
          labelCounts[l] = (labelCounts[l] || 0) + 1;
        }));
        console.log(`🚫 ${excluidos.length} lead(s) excluído(s) por já terem etiqueta no Chatwoot.`);
        console.log('   Top labels nos excluídos:');
        Object.entries(labelCounts)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 8)
          .forEach(([l, c]) => console.log(`     • ${l.padEnd(25)} ${c}`));
        console.log(`   Pra ignorar esse filtro: --incluir-todos\n`);
      }
    }
  }

  // 4. Aplica limite se passado
  const alvo = limit ? elegiveis.slice(0, limit) : elegiveis;
  console.log(`📤 Alvo final: ${alvo.length} leads`);
  const custoEstimado = (alvo.length * 0.55).toFixed(2);
  console.log(`💰 Custo estimado (R$ 0,55/msg): R$ ${custoEstimado}`);
  console.log('');

  // 4. Pré-sorteia distribuição (pra mostrar antes da confirmação)
  const distribuicaoPreviewSeed = alvo.map(() => sortearTemplate().template_name);
  const dist = {};
  distribuicaoPreviewSeed.forEach(name => { dist[name] = (dist[name] || 0) + 1; });
  console.log('🎲 Distribuição prevista nesse sorteio (vai mudar a cada rodada):');
  Object.entries(dist).forEach(([name, count]) => {
    const pct = ((count / alvo.length) * 100).toFixed(1);
    console.log(`   ${name.padEnd(45)} ${String(count).padStart(5)} (${pct}%)`);
  });
  console.log('');

  // 5. Confirmação dupla (só em modo --executar)
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  if (isExecutar) {
    const resp = await pergunta(
      rl,
      `Pra confirmar o disparo REAL de ${alvo.length} mensagens (~R$ ${custoEstimado}),\ndigite EXATAMENTE a palavra DISPARAR: `
    );
    if (resp.trim() !== 'DISPARAR') {
      console.log('\n❌ Cancelado (palavra não bateu).');
      rl.close();
      return;
    }
  } else {
    const resp = await pergunta(rl, 'Continuar com o DRY-RUN? (s/n): ');
    if (resp.trim().toLowerCase() !== 's') {
      console.log('\n❌ Cancelado.');
      rl.close();
      return;
    }
  }
  rl.close();
  console.log('');

  // 6. Loop principal
  const stats = { enviados: 0, falhas: 0, porTemplate: {} };
  const tempoInicio = Date.now();

  for (let i = 0; i < alvo.length; i++) {
    const lead = alvo[i];
    const template = sortearTemplate();
    stats.porTemplate[template.template_name] = (stats.porTemplate[template.template_name] || 0) + 1;

    const linhaProgresso = `[${String(i + 1).padStart(4)}/${alvo.length}] ${(lead.name || '').slice(0, 25).padEnd(25)} → ${template.template_name}`;

    if (!isExecutar) {
      stats.enviados++;
      if ((i + 1) % 50 === 0 || i === alvo.length - 1) {
        console.log(linhaProgresso + ' (dry-run)');
      }
      continue;
    }

    try {
      const r = await enviarTemplate(lead, template);
      stats.enviados++;
      console.log(`✅ ${linhaProgresso} → conv #${r.conversationId}`);

      // Atualiza CRM
      const now = new Date().toISOString();
      await supabase
        .from('crm_leads')
        .update({ last_outbound_at: now, updated_at: now })
        .eq('id', lead.id);
      await supabase.from('crm_activity').insert({
        lead_id:     lead.id,
        action:      'Template disparado (massa)',
        detail:      `${template.template_name} (disparo-massa)`,
        responsible: 'Bot',
        created_at:  now,
      });
    } catch (e) {
      stats.falhas++;
      console.error(`❌ ${linhaProgresso} → ${e.message}`);
    }

    if (i < alvo.length - 1) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  // 7. Sumário
  const minutos = ((Date.now() - tempoInicio) / 1000 / 60).toFixed(1);
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  ${isExecutar ? 'DISPARO CONCLUÍDO' : 'DRY-RUN CONCLUÍDO'}  (em ${minutos} min)`);
  console.log('═══════════════════════════════════════════════════════');
  console.log(`📤 ${isExecutar ? 'Enviados com sucesso' : 'Seriam enviados'}: ${stats.enviados}`);
  if (stats.falhas > 0) console.log(`❌ Falhas: ${stats.falhas}`);
  console.log('\nDistribuição final por template:');
  Object.entries(stats.porTemplate)
    .sort(([, a], [, b]) => b - a)
    .forEach(([name, count]) => {
      const pct = ((count / stats.enviados) * 100).toFixed(1);
      console.log(`   ${name.padEnd(45)} ${String(count).padStart(5)} (${pct}%)`);
    });
  console.log('');
}

main().catch(e => {
  console.error('\n💥 Erro fatal:', e);
  process.exit(1);
});
