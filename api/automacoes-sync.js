/**
 * API de Automações - Sincronização com Chatwoot
 * Integra disparos do Chatwoot com a base de automações
 */

const { createClient } = require('@supabase/supabase-js');
const fetch = require('node-fetch');

// Configuração
const SUPABASE_URL = process.env.SUPABASE_URL || 'YOUR_SUPABASE_URL';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'YOUR_SUPABASE_KEY';
const CHATWOOT_API = process.env.CHATWOOT_API || 'YOUR_CHATWOOT_API_URL';
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN || 'YOUR_CHATWOOT_TOKEN';
const ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '1';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

/**
 * Sincronizar automações do Chatwoot para Supabase
 */
async function syncAutomations() {
  try {
    console.log('[SYNC] Iniciando sincronização com Chatwoot...');
    
    const response = await fetch(
      `${CHATWOOT_API}/api/v1/accounts/${ACCOUNT_ID}/automation_rules`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${CHATWOOT_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Erro Chatwoot: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const automacoes = data.payload || [];

    console.log(`[SYNC] ${automacoes.length} automações encontradas`);

    let created = 0;
    let updated = 0;

    for (const automation of automacoes) {
      // Verificar se já existe
      const { data: existing } = await supabase
        .from('automacoes')
        .select('id')
        .eq('chatwoot_id', automation.id)
        .single();

      const autoData = {
        nome: automation.name,
        descricao: automation.description || `Sincronizado do Chatwoot - ${automation.id}`,
        canal: extractChannel(automation),
        tipo: extractType(automation),
        conteudo: JSON.stringify(automation),
        chatwoot_id: automation.id,
        chatwoot_data: automation,
        ativa: automation.enabled,
        sincronizado_em: new Date().toISOString()
      };

      if (existing) {
        // Atualizar
        const { error } = await supabase
          .from('automacoes')
          .update(autoData)
          .eq('id', existing.id);
        
        if (error) {
          console.error(`[SYNC] Erro ao atualizar automação ${automation.id}:`, error);
        } else {
          updated++;
        }
      } else {
        // Criar
        const { error } = await supabase
          .from('automacoes')
          .insert([autoData]);
        
        if (error) {
          console.error(`[SYNC] Erro ao criar automação ${automation.id}:`, error);
        } else {
          created++;
        }
      }
    }

    console.log(`[SYNC] Sincronização completa: ${created} criadas, ${updated} atualizadas`);
    return { success: true, created, updated, total: automacoes.length };
  } catch (error) {
    console.error('[SYNC] Erro:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Executar automação no Chatwoot
 */
async function executeAutomation(automationId, contactData = {}) {
  try {
    console.log(`[EXEC] Executando automação ${automationId}`);

    // Buscar automação no banco
    const { data: automation, error: fetchError } = await supabase
      .from('automacoes')
      .select('*')
      .eq('id', automationId)
      .single();

    if (fetchError || !automation) {
      throw new Error('Automação não encontrada');
    }

    if (!automation.chatwoot_id) {
      console.log('[EXEC] Automação local (sem Chatwoot ID)');
      return { success: true, type: 'local', automation };
    }

    // Executar no Chatwoot
    const response = await fetch(
      `${CHATWOOT_API}/api/v1/accounts/${ACCOUNT_ID}/automation_rules/${automation.chatwoot_id}/execute`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CHATWOOT_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ contact: contactData })
      }
    );

    if (!response.ok) {
      throw new Error(`Erro ao executar: ${response.status}`);
    }

    console.log('[EXEC] Automação executada com sucesso');
    return { success: true, type: 'chatwoot', automation };
  } catch (error) {
    console.error('[EXEC] Erro:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Aplicar regra de seleção automática
 */
async function applySmartRule(canal, tipo, contactData = {}) {
  try {
    console.log(`[RULE] Aplicando regra: canal=${canal}, tipo=${tipo}`);

    // Buscar regra aplicável
    const { data: rules, error } = await supabase
      .from('automacao_regras')
      .select('*, automacoes(*)')
      .eq('condicao', 'canal')
      .eq('valor', canal);

    if (error) throw error;

    if (rules.length === 0) {
      console.log('[RULE] Nenhuma regra encontrada');
      return { success: false, message: 'Nenhuma regra aplicável' };
    }

    // Usar primeira regra disponível
    const rule = rules[0];
    const result = await executeAutomation(rule.automacao_id, contactData);

    return { success: true, rule: rule.nome, result };
  } catch (error) {
    console.error('[RULE] Erro:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Webhook do Chatwoot - capturar disparos e sincronizar
 */async function handleChatwootWebhook(payload) {
  try {
    console.log('[WEBHOOK] Evento Chatwoot:', payload.event);

    if (payload.event === 'automation_rule.executed') {
      const automation = payload.data;
      
      // Atualizar na base
      await supabase
        .from('automacoes')
        .update({ 
          ultima_execucao: new Date().toISOString(),
          total_execucoes: (automation.executions || 0) + 1
        })
        .eq('chatwoot_id', automation.id);

      console.log('[WEBHOOK] Automação atualizada');
      return { success: true };
    }
  } catch (error) {
    console.error('[WEBHOOK] Erro:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Funções auxiliares
 */
function extractChannel(automation) {
  const trigger = automation.trigger || {};
  const conditions = trigger.conditions || [];
  
  const channelMap = {
    'email': 'email',
    'whatsapp': 'whatsapp',
    'sms': 'sms',
    'facebook': 'facebook',
    'instagram': 'instagram',
    'telegram': 'telegram'
  };

  for (const [key, value] of Object.entries(channelMap)) {
    if (JSON.stringify(trigger).includes(key)) return value;
  }

  return 'general';
}

function extractType(automation) {
  const name = (automation.name || '').toLowerCase();
  
  if (name.includes('boas-vindas') || name.includes('welcome')) return 'boas_vindas';
  if (name.includes('confirmação') || name.includes('confirm')) return 'confirmacao';
  if (name.includes('notificação') || name.includes('notif')) return 'notificacao';
  if (name.includes('suporte') || name.includes('support')) return 'suporte';
  if (name.includes('marketing') || name.includes('promo')) return 'marketing';
  
  return 'geral';
}

// Exportar funções
module.exports = {
  syncAutomations,
  executeAutomation,
  applySmartRule,
  handleChatwootWebhook
};

// Se executado diretamente
if (require.main === module) {
  syncAutomations().then(result => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.success ? 0 : 1);
  });
}
