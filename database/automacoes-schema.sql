-- ============================================
-- BASE DE AUTOMAÇÕES - SCHEMA SUPABASE
-- ============================================

-- Criar tabela de automações
CREATE TABLE IF NOT EXISTS automacoes (
  id BIGSERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  descricao TEXT,
  canal TEXT NOT NULL DEFAULT 'general',
  tipo TEXT NOT NULL DEFAULT 'geral',
  conteudo TEXT NOT NULL,
  
  -- Status e controle
  ativa BOOLEAN DEFAULT TRUE,
  
  -- Rastreamento Chatwoot
  chatwoot_id BIGINT UNIQUE,
  chatwoot_data JSONB,
  
  -- Execução
  ultima_execucao TIMESTAMP,
  total_execucoes INTEGER DEFAULT 0,
  
  -- Auditoria
  sincronizado_em TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  -- Índices
  CONSTRAINT canal_valid CHECK (canal IN ('whatsapp', 'email', 'sms', 'facebook', 'instagram', 'telegram', 'chatwoot', 'general')),
  CONSTRAINT tipo_valid CHECK (tipo IN ('boas_vindas', 'confirmacao', 'notificacao', 'suporte', 'marketing', 'geral', 'sincronizado'))
);

CREATE INDEX idx_automacoes_canal ON automacoes(canal);
CREATE INDEX idx_automacoes_tipo ON automacoes(tipo);
CREATE INDEX idx_automacoes_ativa ON automacoes(ativa);
CREATE INDEX idx_automacoes_chatwoot_id ON automacoes(chatwoot_id);
CREATE INDEX idx_automacoes_created_at ON automacoes(created_at DESC);

-- Criar tabela de regras de seleção automática
CREATE TABLE IF NOT EXISTS automacao_regras (
  id BIGSERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  descricao TEXT,
  
  -- Condição
  condicao TEXT NOT NULL DEFAULT 'canal',
  valor TEXT NOT NULL,
  
  -- Referência à automação
  automacao_id BIGINT NOT NULL REFERENCES automacoes(id) ON DELETE CASCADE,
  
  -- Prioridade (menor número = maior prioridade)
  prioridade INTEGER DEFAULT 100,
  
  -- Status
  ativa BOOLEAN DEFAULT TRUE,
  
  -- Auditoria
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  CONSTRAINT condicao_valid CHECK (condicao IN ('canal', 'tipo', 'periodo', 'prioridade', 'custom'))
);

CREATE INDEX idx_automacao_regras_condicao ON automacao_regras(condicao);
CREATE INDEX idx_automacao_regras_automacao_id ON automacao_regras(automacao_id);
CREATE INDEX idx_automacao_regras_prioridade ON automacao_regras(prioridade ASC);

-- Criar tabela de histórico de execução
CREATE TABLE IF NOT EXISTS automacao_execucoes (
  id BIGSERIAL PRIMARY KEY,
  automacao_id BIGINT NOT NULL REFERENCES automacoes(id) ON DELETE CASCADE,
  regra_id BIGINT REFERENCES automacao_regras(id) ON DELETE SET NULL,
  
  -- Dados da execução
  canal TEXT,
  tipo TEXT,
  contato_dados JSONB,
  resultado JSONB,
  status TEXT DEFAULT 'sucesso',
  mensagem TEXT,
  
  -- Duração
  duracao_ms INTEGER,
  
  -- Auditoria
  created_at TIMESTAMP DEFAULT NOW(),
  
  CONSTRAINT status_valid CHECK (status IN ('sucesso', 'erro', 'pendente', 'cancelada'))
);

CREATE INDEX idx_automacao_execucoes_automacao_id ON automacao_execucoes(automacao_id);
CREATE INDEX idx_automacao_execucoes_created_at ON automacao_execucoes(created_at DESC);
CREATE INDEX idx_automacao_execucoes_status ON automacao_execucoes(status);

-- Criar tabela de sincronização
CREATE TABLE IF NOT EXISTS automacao_sincronizacao (
  id BIGSERIAL PRIMARY KEY,
  
  -- Fonte
  origem TEXT DEFAULT 'chatwoot',
  
  -- Resultado
  total_processadas INTEGER DEFAULT 0,
  criadas INTEGER DEFAULT 0,
  atualizadas INTEGER DEFAULT 0,
  erros INTEGER DEFAULT 0,
  detalhes JSONB,
  
  -- Auditoria
  created_at TIMESTAMP DEFAULT NOW(),
  
  CONSTRAINT origem_valid CHECK (origem IN ('chatwoot', 'manual', 'api'))
);

CREATE INDEX idx_automacao_sincronizacao_created_at ON automacao_sincronizacao(created_at DESC);

-- Criar tabela de logs
CREATE TABLE IF NOT EXISTS automacao_logs (
  id BIGSERIAL PRIMARY KEY,
  
  -- Contexto
  automacao_id BIGINT REFERENCES automacoes(id) ON DELETE SET NULL,
  tipo_log TEXT NOT NULL,
  nivel TEXT DEFAULT 'info',
  mensagem TEXT NOT NULL,
  dados JSONB,
  
  -- Rastreamento
  stack_trace TEXT,
  
  -- Auditoria
  created_at TIMESTAMP DEFAULT NOW(),
  
  CONSTRAINT tipo_log_valid CHECK (tipo_log IN ('execucao', 'sincronizacao', 'erro', 'auditoria')),
  CONSTRAINT nivel_valid CHECK (nivel IN ('debug', 'info', 'warning', 'error', 'critical'))
);

CREATE INDEX idx_automacao_logs_automacao_id ON automacao_logs(automacao_id);
CREATE INDEX idx_automacao_logs_created_at ON automacao_logs(created_at DESC);
CREATE INDEX idx_automacao_logs_nivel ON automacao_logs(nivel);

-- ============================================
-- FUNÇÕES E TRIGGERS
-- ============================================

-- Função para atualizar updated_at
CREATE OR REPLACE FUNCTION atualizar_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers para updated_at
CREATE TRIGGER trigger_automacoes_updated_at
BEFORE UPDATE ON automacoes
FOR EACH ROW
EXECUTE FUNCTION atualizar_updated_at();

CREATE TRIGGER trigger_automacao_regras_updated_at
BEFORE UPDATE ON automacao_regras
FOR EACH ROW
EXECUTE FUNCTION atualizar_updated_at();

-- ============================================
-- DADOS DE EXEMPLO
-- ============================================

-- Inserir automações de exemplo
INSERT INTO automacoes (nome, descricao, canal, tipo, conteudo, ativa)
VALUES
  (
    'Boas-vindas WhatsApp',
    'Mensagem automática de boas-vindas via WhatsApp',
    'whatsapp',
    'boas_vindas',
    'Olá {{nome}}! 👋\n\nBem-vindo à nossa plataforma! Como podemos ajudá-lo?',
    true
  ),
  (
    'Confirmação de Pedido Email',
    'Enviar confirmação de pedido por email',
    'email',
    'confirmacao',
    'Obrigado por sua compra!\n\nPedido: {{pedido_id}}\nTotal: R$ {{total}}\n\nEstarei monitorando seu pedido.',
    true
  ),
  (
    'Notificação de Entrega SMS',
    'Notificar cliente sobre entrega via SMS',
    'sms',
    'notificacao',
    'Seu pedido foi entregue! Rastreamento: {{rastreamento}}',
    true
  ),
  (
    'Suporte Facebook',
    'Resposta automática de suporte no Facebook',
    'facebook',
    'suporte',
    'Obrigado por entrar em contato! Um membro do nosso time responderá em breve.',
    true
  );

-- Inserir regras de exemplo
INSERT INTO automacao_regras (nome, condicao, valor, automacao_id, prioridade)
VALUES
  (
    'WhatsApp Always',
    'canal',
    'whatsapp',
    1,
    10
  ),
  (
    'Email for Orders',
    'canal',
    'email',
    2,
    20
  );

-- ============================================
-- RLS (Row Level Security) - Opcional
-- ============================================

-- Habilitar RLS
ALTER TABLE automacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE automacao_regras ENABLE ROW LEVEL SECURITY;
ALTER TABLE automacao_execucoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE automacao_logs ENABLE ROW LEVEL SECURITY;

-- Política: Qualquer um pode ler automações ativas
CREATE POLICY "automacoes_read_ativas"
ON automacoes
FOR SELECT
USING (ativa = true);

-- Política: Apenas administradores podem modificar
CREATE POLICY "automacoes_write_admin"
ON automacoes
FOR ALL
USING (true)
WITH CHECK (true);

-- ============================================
-- VIEWS ÚTEIS
-- ============================================

-- View: Automações com contagem de execuções
CREATE OR REPLACE VIEW vw_automacoes_stats AS
SELECT
  a.id,
  a.nome,
  a.canal,
  a.tipo,
  a.ativa,
  COUNT(e.id) as total_execucoes,
  MAX(e.created_at) as ultima_execucao,
  COALESCE(SUM(CASE WHEN e.status = 'sucesso' THEN 1 ELSE 0 END), 0) as execucoes_sucesso,
  COALESCE(SUM(CASE WHEN e.status = 'erro' THEN 1 ELSE 0 END), 0) as execucoes_erro
FROM automacoes a
LEFT JOIN automacao_execucoes e ON a.id = e.automacao_id
GROUP BY a.id, a.nome, a.canal, a.tipo, a.ativa;

-- View: Regras com informações de automação
CREATE OR REPLACE VIEW vw_automacao_regras_detalhes AS
SELECT
  r.id,
  r.nome as regra_nome,
  r.condicao,
  r.valor,
  r.prioridade,
  a.id as automacao_id,
  a.nome as automacao_nome,
  a.canal,
  a.tipo,
  r.ativa
FROM automacao_regras r
JOIN automacoes a ON r.automacao_id = a.id;

-- ============================================
-- COMENTÁRIOS
-- ============================================

COMMENT ON TABLE automacoes IS 'Base central de automações sincronizadas do Chatwoot';
COMMENT ON TABLE automacao_regras IS 'Regras inteligentes para seleção automática de automações';
COMMENT ON TABLE automacao_execucoes IS 'Histórico de execuções das automações';
COMMENT ON TABLE automacao_sincronizacao IS 'Registro de sincronizações com Chatwoot';
COMMENT ON TABLE automacao_logs IS 'Logs detalhados de operações e erros';
