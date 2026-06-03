// ═══════════════════════════════════════════════════════════════════════
// Marcar como ghost — aplica label 'ghost' no Chatwoot pra leads
// que receberam disparo mas nunca responderam.
// ─────────────────────────────────────────────────────────────────────────
// Critério (no Supabase):
//   • last_outbound_at IS NOT NULL  (foi disparado pra ele)
//   • last_inbound_at IS NULL       (nunca respondeu)
//   • last_outbound_at < NOW() - N dias  (já passou N dias do último disparo)
//
// O que o script faz pra cada lead elegível:
//   1. Encontra o contato no Chatwoot pelo telefone
//   2. Pega as labels atuais
//   3. Adiciona a label 'ghost' (preservando as outras)
//   4. Atualiza status='ghost' no Supabase SE o status atual for 'novo'
//      (leads em atendimento/reuniao/cliente/etc mantêm o status original
//      pra não bagunçar a classificação humana do time)
//   5. Registra atividade em crm_activity
//
// Uso:
//   node bot/marcar-ghost.js                       # DRY-RUN (default)
//   node bot/marcar-ghost.js --executar            # APLICA AS LABELS
//   node bot/marcar-ghost.js --dias=7              # threshold em dias (default 7)
//   node bot/marcar-ghost.js --label=ghost         # nome da label (default ghost)
//   node bot/marcar-ghost.js --limit=50            # piloto em 50 leads
//   node bot/marcar-ghost.js --delay=500           # ms entre chamadas (default 500)
//   node bot/marcar-ghost.js --no-sync-status      # não mexer em crm_leads.status
// ═══════════════════════════════════════════════════════════════════════

require('dotenv').config();
const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const CW_URL     = (process.env.CHATWOOT_URL || '').replace(/\/$/, '');
const CW_ACCOUNT = process.env.CHATWOOT_ACCOUNT_ID || '';
const CW_TOKEN   = process.env.CHATWOOT_TOKEN || '';

// ─── Helpers ─────────────────────────────────────────────────────────────

function isTelefoneValido(numero) {
  const digits = String(numero || '').replace(/\D/g, '');
  const local = digits.startsWith('55') ? digits.slice(2) : digits;
  return local.length === 10 || local.length === 11;
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

// Carrega todos os contatos do Chatwoot. Retorna Map<digits10, { id, labels[] }>.
// Igual ao disparo-massa.js — duplicado de propósito pra evitar require do bot.js
// (que tem side effect de inicializar o cliente WhatsApp).
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
        entry.labels = ['_erro_busca_'];
        erros++;
      }
    }
    process.stdout.write('\n');
    if (erros > 0) {
      console.log(`   ⚠️  ${erros} erro(s) ao buscar labels.`);
    }
  }

  return map;
}

// Aplica uma label nova num contato preservando as existentes.
// Chatwoot endpoint POST /contacts/{id}/labels SUBSTITUI a lista, então
// montamos a lista completa (atuais + nova) antes de mandar.
async function adicionarLabel(contactId, labelsAtuais, novaLabel) {
  const set = new Set(labelsAtuais);
  set.add(novaLabel);
  const lista = [...set];
  await cwApi(`/contacts/${contactId}/labels`, 'POST', { labels: lista });
  return lista;
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const isExecutar = args.includes('--executar');
  const noSyncStatus = args.includes('--no-sync-status');
  const labelArg = args.find(a => a.startsWith('--label='));
  const label = labelArg ? labelArg.split('=')[1] : 'ghost';
  const diasArg = args.find(a => a.startsWith('--dias='));
  const dias = diasArg ? parseInt(diasArg.split('=')[1], 10) : 7;
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;
  const delayArg = args.find(a => a.startsWith('--delay='));
  const delayMs = delayArg ? parseInt(delayArg.split('=')[1], 10) : 500;

  console.log('═══════════════════════════════════════════════════════');
  console.log(`  MARCAR GHOST — aplica label '${label}' em quem não respondeu`);
  console.log('═══════════════════════════════════════════════════════');
  if (!isExecutar) {
    console.log('  🟡 MODO DRY-RUN — nenhuma label será aplicada');
    console.log('     Pra aplicar de verdade, rode com --executar');
  } else {
    console.log('  🔴 MODO EXECUÇÃO — labels serão aplicadas no Chatwoot');
  }
  console.log(`  📅 Threshold: ${dias} dia(s) sem resposta`);
  console.log(`  🔄 Sincroniza status no Supabase: ${noSyncStatus ? 'NÃO' : 'sim (só pra status=novo)'}`);
  if (limit) console.log(`  📐 Limite: ${limit} leads`);
  console.log(`  ⏱  Delay entre chamadas: ${delayMs}ms`);
  console.log('');

  if (!CW_URL || !CW_ACCOUNT || !CW_TOKEN) {
    console.error('❌ Chatwoot não configurado (.env). Abortando.');
    process.exit(1);
  }

  // 1. Carrega candidatos do Supabase
  const cutoff = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
  console.log(`⏳ Buscando leads sem resposta desde ${cutoff.slice(0, 10)}...`);

  let fromRow = 0;
  const pageSize = 1000;
  const candidatos = [];
  while (true) {
    const { data, error } = await supabase
      .from('crm_leads')
      .select('id, name, phone, status, last_outbound_at, last_inbound_at')
      .not('last_outbound_at', 'is', null)
      .is('last_inbound_at', null)
      .lt('last_outbound_at', cutoff)
      .order('last_outbound_at', { ascending: true })
      .range(fromRow, fromRow + pageSize - 1);
    if (error) {
      console.error('❌ Erro ao ler crm_leads:', error.message);
      process.exit(1);
    }
    if (!data || data.length === 0) break;
    candidatos.push(...data);
    if (data.length < pageSize) break;
    fromRow += pageSize;
  }
  console.log(`✅ ${candidatos.length} candidato(s) encontrado(s).\n`);

  if (candidatos.length === 0) {
    console.log('Nada a fazer. Saindo.');
    return;
  }

  // 2. Filtra inválidos (defesa em profundidade)
  const validos = candidatos.filter(l => isTelefoneValido(l.phone));
  const invalidos = candidatos.length - validos.length;
  if (invalidos > 0) {
    console.log(`⚠️  ${invalidos} com telefone inválido — ignorados.`);
  }

  // 3. Carrega contatos do Chatwoot pra mapear telefone → contact_id + labels atuais
  const contatosCw = await carregarContatosChatwoot();
  console.log(`✅ ${contatosCw.size} contatos no Chatwoot mapeados.\n`);

  // 4. Cruza: separa quem precisa receber a label
  const naoEncontrados = [];
  const jaTemLabel = [];
  const aMarcar = [];
  for (const lead of validos) {
    const digits10 = String(lead.phone).replace(/\D/g, '').slice(-10);
    const cw = contatosCw.get(digits10);
    if (!cw) {
      naoEncontrados.push(lead);
      continue;
    }
    if (cw.labels.includes(label)) {
      jaTemLabel.push(lead);
      continue;
    }
    aMarcar.push({ lead, contactId: cw.id, labelsAtuais: cw.labels });
  }

  // 5. Distribuição por status pra contexto
  const distStatus = {};
  aMarcar.forEach(({ lead }) => {
    const s = lead.status || 'sem_status';
    distStatus[s] = (distStatus[s] || 0) + 1;
  });

  console.log('📊 Resumo:');
  console.log(`   A marcar:           ${aMarcar.length}`);
  console.log(`   Já tinham '${label}':  ${jaTemLabel.length} (pulados)`);
  console.log(`   Sem contato no CW:  ${naoEncontrados.length} (pulados)`);
  if (Object.keys(distStatus).length > 0) {
    console.log('\n   Status atual dos que serão marcados:');
    Object.entries(distStatus)
      .sort(([, a], [, b]) => b - a)
      .forEach(([s, c]) => {
        const sync = !noSyncStatus && s === 'novo' ? '→ ghost' : '(mantém)';
        console.log(`     ${s.padEnd(15)} ${String(c).padStart(5)}  ${sync}`);
      });
  }
  console.log('');

  // 6. Aplica limit se passado
  const alvo = limit ? aMarcar.slice(0, limit) : aMarcar;
  if (limit) console.log(`📐 Aplicando limite: ${alvo.length} leads.\n`);

  if (alvo.length === 0) {
    console.log('Nada a marcar.');
    return;
  }

  // 7. Confirmação
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  if (isExecutar) {
    const resp = await pergunta(
      rl,
      `Pra confirmar a marcação de ${alvo.length} contato(s) com label '${label}',\ndigite EXATAMENTE a palavra MARCAR: `
    );
    if (resp.trim() !== 'MARCAR') {
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

  // 8. Loop
  const stats = { marcados: 0, statusAtualizado: 0, falhas: 0 };
  const tempoInicio = Date.now();

  for (let i = 0; i < alvo.length; i++) {
    const { lead, contactId, labelsAtuais } = alvo[i];
    const linhaProgresso = `[${String(i + 1).padStart(4)}/${alvo.length}] ${(lead.name || '').slice(0, 25).padEnd(25)} (status: ${lead.status})`;

    if (!isExecutar) {
      stats.marcados++;
      if ((i + 1) % 50 === 0 || i === alvo.length - 1) {
        console.log(`${linhaProgresso} (dry-run)`);
      }
      continue;
    }

    try {
      await adicionarLabel(contactId, labelsAtuais, label);
      stats.marcados++;
      console.log(`✅ ${linhaProgresso} → label aplicada`);

      if (!noSyncStatus && lead.status === 'novo') {
        const now = new Date().toISOString();
        const { error: upErr } = await supabase
          .from('crm_leads')
          .update({ status: 'ghost', updated_at: now })
          .eq('id', lead.id);
        if (!upErr) {
          stats.statusAtualizado++;
          await supabase.from('crm_activity').insert({
            lead_id:     lead.id,
            action:      'Marcado como ghost',
            detail:      `label '${label}' no Chatwoot + status='ghost' (marcar-ghost · >${dias}d sem resposta)`,
            responsible: 'Bot',
            created_at:  now,
          });
        } else {
          console.error(`   ⚠️  Falha ao atualizar status: ${upErr.message}`);
        }
      } else {
        // Só registra activity (não muda status)
        const now = new Date().toISOString();
        await supabase.from('crm_activity').insert({
          lead_id:     lead.id,
          action:      `Label '${label}' aplicada no Chatwoot`,
          detail:      `status mantido em '${lead.status}' (marcar-ghost · >${dias}d sem resposta)`,
          responsible: 'Bot',
          created_at:  now,
        });
      }
    } catch (e) {
      stats.falhas++;
      console.error(`❌ ${linhaProgresso} → ${e.message}`);
    }

    if (i < alvo.length - 1) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  // 9. Sumário
  const minutos = ((Date.now() - tempoInicio) / 1000 / 60).toFixed(1);
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(`  ${isExecutar ? 'EXECUÇÃO CONCLUÍDA' : 'DRY-RUN CONCLUÍDO'}  (em ${minutos} min)`);
  console.log('═══════════════════════════════════════════════════════');
  console.log(`🏷  ${isExecutar ? 'Labels aplicadas' : 'Seriam aplicadas'}: ${stats.marcados}`);
  if (isExecutar) console.log(`🔄 Status atualizado pra 'ghost' no Supabase: ${stats.statusAtualizado}`);
  if (stats.falhas > 0) console.log(`❌ Falhas: ${stats.falhas}`);
  console.log('');
}

main().catch(e => {
  console.error('\n💥 Erro fatal:', e);
  process.exit(1);
});
