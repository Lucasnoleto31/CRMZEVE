/**
 * API REST - Gerenciar Automações
 * Endpoints para criar, atualizar, deletar e executar automações
 */

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { syncAutomations, executeAutomation, applySmartRule, handleChatwootWebhook } = require('./automacoes-sync');

const app = express();
app.use(express.json());

// Middleware de autenticação
const AUTH_TOKEN = process.env.API_TOKEN || 'seu-token-secreto';

function authenticate(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Configuração Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ============================================
// SINCRONIZAÇÃO
// ============================================

/**
 * POST /api/automacoes/sync
 * Sincronizar automações do Chatwoot
 */
app.post('/api/automacoes/sync', authenticate, async (req, res) => {
  try {
    const result = await syncAutomations();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/automacoes/sync/status
 * Status da última sincronização
 */
app.get('/api/automacoes/sync/status', authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('automacoes')
      .select('sincronizado_em, chatwoot_id')
      .order('sincronizado_em', { ascending: false })
      .limit(1)
      .single();

    if (error) throw error;

    res.json({
      lastSync: data?.sincronizado_em,
      fromChatwoot: !!data?.chatwoot_id
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// LISTAR AUTOMAÇÕES
// ============================================

/**
 * GET /api/automacoes
 * Listar todas as automações
 */
app.get('/api/automacoes', async (req, res) => {
  try {
    const { canal, tipo, ativa } = req.query;

    let query = supabase.from('automacoes').select('*');

    if (canal) query = query.eq('canal', canal);
    if (tipo) query = query.eq('tipo', tipo);
    if (ativa !== undefined) query = query.eq('ativa', ativa === 'true');

    const { data, error } = await query.order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/automacoes/:id
 * Obter automação específica
 */
app.get('/api/automacoes/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('automacoes')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Automação não encontrada' });
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// CRIAR/ATUALIZAR AUTOMAÇÕES
// ============================================

/**
 * POST /api/automacoes
 * Criar nova automação
 */
app.post('/api/automacoes', authenticate, async (req, res) => {
  try {
    const { nome, descricao, canal, tipo, conteudo, ativa } = req.body;

    if (!nome || !canal || !tipo || !conteudo) {
      return res.status(400).json({ error: 'Campos obrigatórios faltando' });
    }

    const { data, error } = await supabase
      .from('automacoes')
      .insert([{
        nome,
        descricao: descricao || '',
        canal,
        tipo,
        conteudo,
        ativa: ativa !== false,
        created_at: new Date().toISOString()
      }])
      .select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/automacoes/:id
 * Atualizar automação
 */
app.put('/api/automacoes/:id', authenticate, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('automacoes')
      .update(req.body)
      .eq('id', req.params.id)
      .select();

    if (error) throw error;
    if (!data.length) {
      return res.status(404).json({ error: 'Automação não encontrada' });
    }

    res.json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/automacoes/:id
 * Deletar automação
 */
app.delete('/api/automacoes/:id', authenticate, async (req, res) => {
  try {
    const { error } = await supabase
      .from('automacoes')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// EXECUTAR AUTOMAÇÕES
// ============================================

/**
 * POST /api/automacoes/:id/execute
 * Executar automação específica
 */
app.post('/api/automacoes/:id/execute', authenticate, async (req, res) => {
  try {
    const { contact } = req.body || {};
    const result = await executeAutomation(req.params.id, contact);
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/automacoes/execute/smart
 * Executar automação baseada em critérios inteligentes
 */
app.post('/api/automacoes/execute/smart', authenticate, async (req, res) => {
  try {
    const { canal, tipo, contact } = req.body;

    if (!canal || !tipo) {
      return res.status(400).json({ error: 'Canal e tipo são obrigatórios' });
    }

    // Buscar automação que corresponda aos critérios
    const { data: automacao, error } = await supabase
      .from('automacoes')
      .select('*')
      .eq('canal', canal)
      .eq('tipo', tipo)
      .eq('ativa', true)
      .limit(1)
      .single();

    if (error || !automacao) {
      return res.status(404).json({ error: 'Nenhuma automação disponível' });
    }

    const result = await executeAutomation(automacao.id, contact);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// REGRAS
// ============================================

/**
 * GET /api/automacoes/regras
 * Listar todas as regras
 */
app.get('/api/automacoes/regras', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('automacao_regras')
      .select('*, automacoes(nome)')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/automacoes/regras
 * Criar nova regra
 */
app.post('/api/automacoes/regras', authenticate, async (req, res) => {
  try {
    const { nome, condicao, valor, automacao_id } = req.body;

    if (!nome || !condicao || !valor || !automacao_id) {
      return res.status(400).json({ error: 'Campos obrigatórios faltando' });
    }

    const { data, error } = await supabase
      .from('automacao_regras')
      .insert([{
        nome,
        condicao,
        valor,
        automacao_id,
        created_at: new Date().toISOString()
      }])
      .select();

    if (error) throw error;
    res.status(201).json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/automacoes/regras/:id
 * Deletar regra
 */
app.delete('/api/automacoes/regras/:id', authenticate, async (req, res) => {
  try {
    const { error } = await supabase
      .from('automacao_regras')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// WEBHOOKS
// ============================================

/**
 * POST /api/automacoes/webhook/chatwoot
 * Webhook do Chatwoot
 */
app.post('/api/automacoes/webhook/chatwoot', async (req, res) => {
  try {
    const result = await handleChatwootWebhook(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// STATS
// ============================================

/**
 * GET /api/automacoes/stats
 * Estatísticas gerais
 */
app.get('/api/automacoes/stats', async (req, res) => {
  try {
    const { data: automacoes, error } = await supabase
      .from('automacoes')
      .select('ativa, canal, tipo');

    if (error) throw error;

    const stats = {
      total: automacoes.length,
      ativas: automacoes.filter(a => a.ativa).length,
      inativas: automacoes.filter(a => !a.ativa).length,
      porCanal: {},
      porTipo: {}
    };

    automacoes.forEach(a => {
      stats.porCanal[a.canal] = (stats.porCanal[a.canal] || 0) + 1;
      stats.porTipo[a.tipo] = (stats.porTipo[a.tipo] || 0) + 1;
    });

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 API de Automações rodando em http://localhost:${PORT}`);
});

module.exports = app;
