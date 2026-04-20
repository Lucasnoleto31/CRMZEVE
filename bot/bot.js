require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const readline = require('readline');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

let targetGroupId = null;
let targetGroupName = null;

const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'lead-tracker' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    protocolTimeout: 300000,
    timeout: 120000,
  },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pergunta(rl, texto) {
  return new Promise(resolve => rl.question(texto, resolve));
}

// Formata número para padrão do CRM: (XX) 9XXXX-XXXX
function formatarTelefone(numero) {
  const digits = String(numero).replace(/\D/g, '');
  const local = digits.startsWith('55') ? digits.slice(2) : digits;
  if (local.length === 11) return `(${local.slice(0,2)}) ${local.slice(2,7)}-${local.slice(7)}`;
  if (local.length === 10) return `(${local.slice(0,2)}) ${local.slice(2,6)}-${local.slice(6)}`;
  return local;
}

function formatarData(ts) {
  if (!ts) return 'Desconhecida';
  const d = new Date(ts * 1000);
  return d.toLocaleDateString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// Acessa os dados internos do WhatsApp Web para pegar timestamps reais de entrada
async function buscarParticipantesComData(groupSerializedId) {
  // Tentativa 1: window.Store.GroupMetadata
  try {
    const result = await client.pupPage.evaluate((gId) => {
      const group = window.Store.GroupMetadata.get(gId);
      if (!group) return null;
      const list = group.participants?.getModelsArray?.() || [];
      if (list.length === 0) return null;
      return list.map(p => {
        const contact = window.Store.Contact?.get?.(p.id._serialized);
        return {
          id: p.id._serialized,
          number: p.id.user,
          isAdmin: p.isAdmin || false,
          joinedAt: p.t || null,
          name: p.notify || contact?.pushname || contact?.name || null,
        };
      });
    }, groupSerializedId);
    if (result && result.length > 0) return result;
  } catch { /* tenta próximo */ }

  // Tentativa 2: window.Store.Chat groupMetadata
  try {
    const result = await client.pupPage.evaluate((gId) => {
      const chat = window.Store.Chat.get(gId);
      const meta = chat?.groupMetadata;
      if (!meta) return null;
      const list = meta.participants?.getModelsArray?.() || [];
      if (list.length === 0) return null;
      return list.map(p => {
        const contact = window.Store.Contact?.get?.(p.id._serialized);
        return {
          id: p.id._serialized,
          number: p.id.user,
          isAdmin: p.isAdmin || false,
          joinedAt: p.t || null,
          name: p.notify || contact?.pushname || contact?.name || null,
        };
      });
    }, groupSerializedId);
    if (result && result.length > 0) return result;
  } catch { /* tenta próximo */ }

  // Tentativa 3: window.Store.GroupMetadata via find/filter
  try {
    const result = await client.pupPage.evaluate((gId) => {
      const all = window.Store.GroupMetadata?.models || [];
      const group = all.find?.(g => g.id?._serialized === gId);
      if (!group) return null;
      const list = group.participants?.models || [];
      if (list.length === 0) return null;
      return list.map(p => {
        const contact = window.Store.Contact?.get?.(p.id._serialized);
        return {
          id: p.id._serialized,
          number: p.id.user,
          isAdmin: p.isAdmin || false,
          joinedAt: p.t || null,
          name: p.notify || contact?.pushname || contact?.name || null,
        };
      });
    }, groupSerializedId);
    if (result && result.length > 0) return result;
  } catch { /* tenta próximo */ }

  // Fallback: usa API do whatsapp-web.js (sem data de entrada)
  try {
    console.log('⚠️  Datas de entrada indisponíveis — importando apenas nome e telefone.\n');
    const chat = await client.getChatById(groupSerializedId);
    if (!chat?.participants?.length) return null;
    return chat.participants.map(p => ({
      id: p.id._serialized,
      number: p.id.user,
      isAdmin: p.isAdmin || false,
      joinedAt: null,
      name: p.notify || null,
    }));
  } catch { return null; }
}

// Extrai nomes a partir das mensagens do grupo (notifyName = nome configurado no WA)
async function buscarNomesPorMensagens(groupSerializedId) {
  try {
    return await client.pupPage.evaluate((gId) => {
      const chat = window.Store.Chat.get(gId);
      if (!chat) return {};
      const msgs = chat.msgs?.models || [];
      const map = {};
      for (const msg of msgs) {
        const authorId = msg.author?._serialized || (msg.id?.fromMe ? null : msg.from?._serialized);
        const nome = msg.notifyName;
        if (authorId && nome && !map[authorId]) {
          map[authorId] = nome;
        }
      }
      return map;
    }, groupSerializedId);
  } catch { return {}; }
}

// ─── Eventos ─────────────────────────────────────────────────────────────────

client.on('qr', (qr) => {
  console.log('\n📱 Escaneie o QR Code com seu WhatsApp:\n');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log('✅ Autenticado!');
});

client.on('ready', async () => {
  console.log('\n🚀 Conectado ao WhatsApp!\n');
  await selecionarGrupo();
});

// ─── Seleção de grupo ─────────────────────────────────────────────────────────

async function carregarGruposDireto() {
  // Fallback: lê grupos direto do window.Store (mais rápido que getChats())
  return await client.pupPage.evaluate(() => {
    const chats = window.Store.Chat?.getModelsArray?.() || [];
    return chats
      .filter(c => c.isGroup)
      .map(c => ({
        id: { _serialized: c.id._serialized },
        name: c.name || c.formattedTitle || c.id.user,
        isGroup: true,
        participantsCount: c.groupMetadata?.participants?.length ?? null,
      }));
  });
}

async function selecionarGrupo() {
  console.log('⏳ Carregando grupos e comunidades...\n');

  let grupos;
  try {
    const chats = await client.getChats();
    grupos = chats
      .filter(c => c.isGroup)
      .map(c => ({
        id: c.id,
        name: c.name,
        isGroup: true,
        participantsCount: c.participants?.length ?? null,
      }))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } catch (err) {
    console.log(`⚠️  getChats() falhou (${err.message.split('\n')[0]}).`);
    console.log('⏳ Tentando fallback direto via Store...\n');
    grupos = (await carregarGruposDireto())
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }

  if (grupos.length === 0) {
    console.log('❌ Nenhum grupo encontrado.');
    return;
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('  Selecione o grupo/comunidade para monitorar:');
  console.log('═══════════════════════════════════════════════════════');
  grupos.forEach((g, i) => {
    const n = g.participantsCount ?? '?';
    console.log(`  [${String(i + 1).padStart(2, ' ')}] ${g.name}  (${n} membros)`);
  });
  console.log('═══════════════════════════════════════════════════════\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const resposta = await pergunta(rl, 'Digite o número do grupo: ');
  const idx = parseInt(resposta.trim(), 10) - 1;

  if (isNaN(idx) || idx < 0 || idx >= grupos.length) {
    console.log('\n❌ Número inválido. Reinicie o bot e tente novamente.\n');
    rl.close();
    return;
  }

  const grupoSelecionado = grupos[idx];
  targetGroupId = grupoSelecionado.id._serialized;
  targetGroupName = grupoSelecionado.name;

  console.log(`\n✅ Grupo selecionado: "${targetGroupName}"\n`);

  await importarMembrosExistentes(grupoSelecionado, rl);
  rl.close();

  console.log('\n👁  Aguardando novos membros...\n');
}

// ─── Importação de membros existentes ────────────────────────────────────────

async function importarMembrosExistentes(chat, rl) {
  console.log('⏳ Carregando membros existentes com datas de entrada...\n');

  const participantesRaw = await buscarParticipantesComData(chat.id._serialized);

  if (!participantesRaw || participantesRaw.length === 0) {
    console.log('⚠️  Não foi possível carregar os membros. Pulando importação.\n');
    return;
  }

  // Busca nomes via mensagens do grupo (notifyName = nome do WA do remetente)
  console.log('⏳ Buscando nomes nas mensagens do grupo...\n');
  const nomesPorMensagem = await buscarNomesPorMensagens(chat.id._serialized);

  // Mescla: prioriza notify do participante, depois nome das mensagens
  const participantes = participantesRaw.map(p => ({
    ...p,
    name: p.name || nomesPorMensagem[p.id] || null,
  }));

  // Ordena por data de entrada (mais antigos primeiro)
  const ordenados = [...participantes].sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));

  console.log('─────────────────────────────────────────────────────────────────────────');
  console.log(`  ${ordenados.length} membros encontrados em "${targetGroupName}"`);
  console.log('─────────────────────────────────────────────────────────────────────────');
  console.log(`  ${'#'.padEnd(4)} ${'Telefone'.padEnd(18)} ${'Entrada'.padEnd(20)} ${'Nome'.padEnd(25)} Admin`);
  console.log('─────────────────────────────────────────────────────────────────────────');

  ordenados.forEach((p, i) => {
    const num = `+${p.number}`.padEnd(18);
    const data = formatarData(p.joinedAt).padEnd(20);
    const nome = (p.name || 'Sem nome').padEnd(25);
    const admin = p.isAdmin ? '★' : '';
    console.log(`  ${String(i + 1).padEnd(4)} ${num} ${data} ${nome} ${admin}`);
  });

  console.log('─────────────────────────────────────────────────────────────────\n');

  // Busca telefones já cadastrados no CRM para evitar duplicatas (paginado)
  console.log('⏳ Verificando duplicatas no banco...\n');
  const telefonesExistentes = new Set();
  let fromRow = 0;
  const pageSize = 1000;
  while (true) {
    const { data: pagina } = await supabase
      .from('crm_leads')
      .select('phone')
      .range(fromRow, fromRow + pageSize - 1);
    if (!pagina || pagina.length === 0) break;
    pagina.forEach(r => {
      const d = (r.phone || '').replace(/\D/g, '');
      if (d) telefonesExistentes.add(d.slice(-10));
    });
    if (pagina.length < pageSize) break;
    fromRow += pageSize;
  }

  const novos = ordenados.filter(p => {
    const d = String(p.number).replace(/\D/g, '');
    return !telefonesExistentes.has(d.slice(-10));
  });
  const pulados = ordenados.length - novos.length;

  if (pulados > 0) {
    console.log(`⏭  ${pulados} já cadastrado(s) — serão ignorados.\n`);
  }

  if (novos.length === 0) {
    console.log('✅ Nenhum membro novo para importar. Banco já está atualizado.\n');
    return;
  }

  const confirma = await pergunta(rl, `Importar ${novos.length} membro(s) novo(s) para o banco? (s/n): `);

  if (confirma.trim().toLowerCase() !== 's') {
    console.log('⏭  Importação cancelada. Monitorando apenas novos membros.\n');
    return;
  }

  // Pergunta separada sobre disparo — evita spam em backfills de membros antigos.
  // Só perguntamos se o Chatwoot está configurado; caso contrário nem adianta oferecer.
  const cwReady = CW_ATIVO && CW_URL && CW_ACCOUNT && CW_TOKEN && CW_INBOX;
  let deveDisparar = false;
  if (cwReady) {
    const respDisp = await pergunta(
      rl,
      `Disparar template do Chatwoot para os ${novos.length} novos (etapa "Lead Novo")? (s/n): `
    );
    deveDisparar = respDisp.trim().toLowerCase() === 's';
  } else {
    console.log('ℹ️  Chatwoot não configurado — import será feito sem disparo.');
  }

  console.log('\n⏳ Importando membros...\n');

  let salvos = 0;
  let erros = 0;
  let disparados = 0;
  let disparoPulado = 0;

  for (let i = 0; i < novos.length; i++) {
    const p = novos[i];
    process.stdout.write(`\r  Processando ${i + 1}/${novos.length}...`);

    try {
      let nome = (p.name || '').trim() || null;
      if (!nome) {
        try {
          const contact = await client.getContactById(p.id);
          nome = (
            contact.pushname ||
            contact.name ||
            contact.verifiedName ||
            contact.shortName ||
            contact.formattedName ||
            ''
          ).trim() || null;
        } catch {
          // contato sem nome disponível
        }
      }
      const phoneFmt = formatarTelefone(p.number);

      const leadData = {
        name:       nome || `Lead ${phoneFmt}`,
        phone:      phoneFmt,
        status:     'Lead Novo',
        origin:     'WhatsApp',
        community:  targetGroupName,
        entry:      p.joinedAt
          ? new Date(p.joinedAt * 1000).toISOString().slice(0, 10)
          : new Date().toISOString().slice(0, 10),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { data: saved, error } = await supabase
        .from('crm_leads')
        .insert(leadData)
        .select('id')
        .single();

      if (error) {
        if (erros === 0) console.error('\n\n❌ Primeiro erro:', JSON.stringify(error));
        erros++;
      } else {
        salvos++;
        // Só dispara se o usuário confirmou na pergunta de antes.
        // Pausa maior aqui para respeitar rate-limit em importações grandes.
        if (deveDisparar) {
          try {
            const ok = await chatwootDisparar(leadData, saved.id);
            if (ok) disparados++; else disparoPulado++;
          } catch (dispErr) {
            console.error(`\n   ❌ Disparo falhou para ${leadData.name}: ${dispErr.message}`);
            disparoPulado++;
          }
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    } catch (e) {
      if (erros === 0) console.error('\n\n❌ Primeiro erro (catch):', e.message);
      erros++;
    }

    // Pequena pausa entre leads para não sobrecarregar o whatsapp-web
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n\n✅ Importação concluída: ${salvos} cadastrados no CRM, ${pulados} ignorados (já existiam), ${erros} erros.`);
  if (deveDisparar) {
    console.log(`📤 Chatwoot: ${disparados} template(s) disparado(s), ${disparoPulado} pulado(s).\n`);
  } else {
    console.log('📤 Chatwoot: disparo não solicitado neste import.\n');
  }
}

// ─── Chatwoot — disparo automático ───────────────────────────────────────────

const CW_URL      = (process.env.CHATWOOT_URL || '').replace(/\/$/, '');
const CW_ACCOUNT  = process.env.CHATWOOT_ACCOUNT_ID || '';
const CW_TOKEN    = process.env.CHATWOOT_TOKEN || '';
const CW_INBOX    = process.env.CHATWOOT_INBOX_ID || '';
const CW_ATIVO    = process.env.CHATWOOT_AUTO_DISPARO !== 'false'; // default: ligado

const CW_MENSAGEM = process.env.CHATWOOT_MENSAGEM ||
`Oi! Aqui é o Artur, da equipe do Fabricio 👊

Bem-vindo! Antes de te apresentar o que fazemos, me fala: como tá sua operação hoje?

1️⃣ Começando
2️⃣ Operando e querendo crescer
3️⃣ Operando mas inconsistente`;

// Converte "(11) 99999-9999" → "+5511999999999"
function toE164(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('55')) return `+${digits}`;
  return `+55${digits}`;
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

// Busca o mapeamento etapa → template da tabela crm_stage_templates.
// O bot e o frontend compartilham essa mesma fonte de verdade, então o que
// o usuário configurar na aba "Automações" do CRM vale também aqui.
async function getStageTemplate(stage) {
  try {
    const { data, error } = await supabase
      .from('crm_stage_templates')
      .select('*')
      .eq('stage', stage)
      .eq('enabled', true)
      .maybeSingle();
    if (error) throw error;
    return data || null;
  } catch (e) {
    console.error(`   ⚠️  Não foi possível ler crm_stage_templates: ${e.message}`);
    return null;
  }
}

async function chatwootDisparar(lead, leadId, stage = 'Lead Novo') {
  if (!CW_ATIVO || !CW_URL || !CW_ACCOUNT || !CW_TOKEN || !CW_INBOX) {
    console.log('⚠️  Chatwoot não configurado — disparo automático ignorado.');
    return false;
  }

  const phone = toE164(lead.phone);
  console.log(`📤 Chatwoot: iniciando disparo para ${lead.name} (${phone}) — etapa "${stage}"…`);

  // Resolve qual mensagem enviar:
  //   1º tenta o template vinculado à etapa (crm_stage_templates)
  //   2º cai para CHATWOOT_MENSAGEM (texto livre — só funciona dentro de janela de 24h)
  const mapping = await getStageTemplate(stage);
  if (!mapping && !CW_MENSAGEM) {
    console.log(`   ⚠️  Sem template vinculado à etapa "${stage}" e sem CHATWOOT_MENSAGEM definido — disparo ignorado.`);
    return false;
  }

  // 1. Busca contato existente
  let contactId;
  try {
    const search = await cwApi(`/contacts/search?q=${encodeURIComponent(phone)}&page=1`);
    const found = search?.payload?.find(c => {
      const p = (c.phone_number || '').replace(/\D/g, '');
      return p.endsWith(phone.replace(/\D/g, '').slice(-10));
    });
    if (found) {
      contactId = found.id;
      console.log(`   ↳ Contato existente: #${contactId}`);
    }
  } catch { /* segue para criar */ }

  // 2. Cria contato se não encontrou
  if (!contactId) {
    try {
      const created = await cwApi('/contacts', 'POST', {
        name:         lead.name,
        phone_number: phone,
      });
      contactId = created?.id || created?.contact?.id;
      console.log(`   ↳ Contato criado: #${contactId}`);
    } catch (e) {
      console.error(`   ❌ Erro ao criar contato: ${e.message}`);
      return false;
    }
  }

  // 3. Cria conversa
  let conversationId;
  try {
    const conv = await cwApi(`/contacts/${contactId}/conversations`, 'POST', {
      inbox_id: parseInt(CW_INBOX, 10),
    });
    conversationId = conv?.id;
    console.log(`   ↳ Conversa criada: #${conversationId}`);
  } catch (e) {
    console.error(`   ❌ Erro ao criar conversa: ${e.message}`);
    return false;
  }

  // 4. Envia mensagem — template aprovado se existir, senão texto livre
  try {
    const payload = mapping
      ? {
          message_type: 'outgoing',
          private:      false,
          content:      mapping.template_body || '',
          template_params: {
            name:     mapping.template_name,
            category: mapping.category || 'MARKETING',
            language: mapping.language || 'pt_BR',
            processed_params: {},
          },
        }
      : {
          message_type: 'outgoing',
          private:      false,
          content:      CW_MENSAGEM,
        };
    await cwApi(`/conversations/${conversationId}/messages`, 'POST', payload);
    console.log(`   ✅ ${mapping ? `Template "${mapping.template_name}" enviado!` : 'Mensagem livre enviada!'}`);
  } catch (e) {
    console.error(`   ❌ Erro ao enviar mensagem: ${e.message}`);
    return false;
  }

  // 5. Registra atividade no CRM e avança status → IA Disparou
  try {
    const now = new Date().toISOString();
    await supabase
      .from('crm_leads')
      .update({ status: 'IA Disparou', stage_entered_at: now.slice(0, 10), cadencia_step: 0, updated_at: now })
      .eq('id', leadId);
    await supabase.from('crm_activity').insert({
      lead_id:     leadId,
      action:      'Template disparado',
      detail:      mapping ? `${mapping.template_name} (bot · etapa ${stage})` : `mensagem livre (bot · etapa ${stage})`,
      responsible: 'Bot',
      created_at:  now,
    });
    console.log(`   ↳ Status atualizado: IA Disparou`);
  } catch (e) {
    console.error(`   ⚠️  Erro ao atualizar status/activity: ${e.message}`);
  }

  return true;
}

// ─── Monitoramento de novos membros ──────────────────────────────────────────

client.on('group_join', async (notification) => {
  if (!targetGroupId) return;

  try {
    const chat = await notification.getChat();
    if (chat.id._serialized !== targetGroupId) return;

    const memberIds = notification.recipientIds || [];

    for (const memberId of memberIds) {
      try {
        const contact = await client.getContactById(memberId);

        const phoneFormatado = formatarTelefone(contact.number || memberId.replace('@c.us', ''));
        // Fallback encadeado: pushname > name > verifiedName > shortName > formattedName.
        // Se nada estiver populado (acontece em contatos novos que nunca mandaram mensagem
        // para este número ou que não compartilham nome), usa o próprio telefone como nome —
        // evita que leads entrem no CRM como "Sem nome" e acabem em templates assim.
        const nome = (
          contact.pushname ||
          contact.name ||
          contact.verifiedName ||
          contact.shortName ||
          contact.formattedName ||
          ''
        ).trim() || `Lead ${phoneFormatado}`;

        // Verifica duplicata
        const digits = phoneFormatado.replace(/\D/g, '').slice(-10);
        const { data: existente } = await supabase
          .from('crm_leads')
          .select('id')
          .ilike('phone', `%${digits}%`)
          .limit(1);

        if (existente && existente.length > 0) {
          console.log(`\n⏭  Lead já existe no CRM: ${nome} (${phoneFormatado})`);
          continue;
        }

        const today = new Date().toISOString();
        const leadData = {
          name:       nome || `Lead ${phoneFormatado}`,
          phone:      phoneFormatado,
          status:     'Lead Novo',
          origin:     'WhatsApp',
          community:  targetGroupName,
          entry:      today.slice(0, 10),
          created_at: today,
          updated_at: today,
        };

        console.log(`\n👤 Novo lead: ${leadData.name} (${leadData.phone})`);

        const { data: saved, error } = await supabase
          .from('crm_leads')
          .insert(leadData)
          .select('id')
          .single();

        if (error) {
          console.error(`❌ Erro ao salvar ${leadData.name}:`, error.message);
        } else {
          console.log(`✅ Salvo no CRM: ${leadData.name} (#${saved.id})`);
          // Disparo automático Chatwoot (aguarda 3s para não sobrecarregar)
          await new Promise(r => setTimeout(r, 3000));
          await chatwootDisparar(leadData, saved.id);
        }
      } catch (contactErr) {
        console.error(`⚠️  Erro ao buscar contato ${memberId}:`, contactErr.message);
      }
    }
  } catch (err) {
    console.error('❌ Erro no group_join:', err.message);
  }
});

client.on('disconnected', (reason) => {
  console.log('🔌 Desconectado:', reason);
  targetGroupId = null;
  targetGroupName = null;
  console.log('Reiniciando em 5 segundos...');
  setTimeout(() => client.initialize(), 5000);
});

client.initialize();
