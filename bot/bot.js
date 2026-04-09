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

async function selecionarGrupo() {
  console.log('⏳ Carregando grupos e comunidades...\n');

  const chats = await client.getChats();
  const grupos = chats
    .filter(c => c.isGroup)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (grupos.length === 0) {
    console.log('❌ Nenhum grupo encontrado.');
    return;
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('  Selecione o grupo/comunidade para monitorar:');
  console.log('═══════════════════════════════════════════════════════');
  grupos.forEach((g, i) => {
    const n = g.participants?.length ?? '?';
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

  console.log('\n⏳ Importando membros...\n');

  let salvos = 0;
  let erros = 0;

  for (let i = 0; i < novos.length; i++) {
    const p = novos[i];
    process.stdout.write(`\r  Processando ${i + 1}/${novos.length}...`);

    try {
      let nome = p.name || null;
      if (!nome) {
        try {
          const contact = await client.getContactById(p.id);
          nome = contact.pushname || contact.name || null;
        } catch {
          // contato sem nome disponível
        }
      }

      const leadData = {
        name:       nome || 'Sem nome',
        phone:      formatarTelefone(p.number),
        status:     'Novo',
        origin:     'WhatsApp',
        community:  targetGroupName,
        entry:      p.joinedAt
          ? new Date(p.joinedAt * 1000).toISOString().slice(0, 10)
          : new Date().toISOString().slice(0, 10),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase
        .from('crm_leads')
        .insert(leadData);

      if (error) {
        if (erros === 0) console.error('\n\n❌ Primeiro erro:', JSON.stringify(error));
        erros++;
      } else {
        salvos++;
      }
    } catch (e) {
      if (erros === 0) console.error('\n\n❌ Primeiro erro (catch):', e.message);
      erros++;
    }

    // Pequena pausa para não sobrecarregar
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`\n\n✅ Importação concluída: ${salvos} cadastrados no CRM, ${pulados} ignorados (já existiam), ${erros} erros.\n`);
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
        const nome = contact.pushname || contact.name || 'Sem nome';

        // Verifica duplicata pelo telefone
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
          name:       nome,
          phone:      phoneFormatado,
          status:     'Novo',
          origin:     'WhatsApp',
          community:  targetGroupName,
          entry:      today.slice(0, 10),
          created_at: today,
          updated_at: today,
        };

        console.log(`\n👤 Novo lead: ${leadData.name} (${leadData.phone})`);

        const { error } = await supabase
          .from('crm_leads')
          .insert(leadData);

        if (error) {
          console.error(`❌ Erro ao salvar ${leadData.name}:`, error.message);
        } else {
          console.log(`✅ Salvo no CRM: ${leadData.name}`);
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
