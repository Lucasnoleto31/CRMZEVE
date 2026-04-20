# 📋 Base de Automações - Guia de Uso

## Visão Geral

A **Base de Automações** é um sistema centralizado para gerenciar, sincronizar e executar disparos do Chatwoot com seleção inteligente.

## 🚀 Início Rápido

### 1. Configurar Supabase

1. Acesse seu projeto Supabase
2. Vá para **SQL Editor**
3. Cole o conteúdo de `database/automacoes-schema.sql`
4. Execute

### 2. Configurar Credenciais

Abra `automacoes.html` e substitua:

```javascript
const SUPABASE_URL = 'sua-url-supabase';
const SUPABASE_KEY = 'sua-chave-publica';
const CHATWOOT_API = 'https://seu-chatwoot.com';
const CHATWOOT_TOKEN = 'seu-token-chatwoot';
```

Da mesma forma em `api/automacoes-sync.js` e `api/automacoes.js`:

```bash
export SUPABASE_URL="sua-url"
export SUPABASE_KEY="sua-chave"
export CHATWOOT_API="sua-url-chatwoot"
export CHATWOOT_TOKEN="seu-token"
export API_TOKEN="seu-token-api"
```

### 3. Instalar Dependências

```bash
npm install express @supabase/supabase-js
```

### 4. Iniciar Servidor

```bash
node api/automacoes.js
```

## 📊 Dashboard

Abra `automacoes.html` no navegador para acessar:

### Tabs Principais:

#### 1️⃣ **Lista de Automações**
- Ver todas as automações
- Buscar por nome/descrição
- Visualizar detalhes
- Executar manualmente
- Criar novas automações

#### 2️⃣ **Regras de Seleção**
- Definir regras automáticas
- Condições: Canal, Tipo, Período, Prioridade
- Associar automação a regra
- Deletar regras

#### 3️⃣ **Execução Rápida**
- Seletor inteligente
- Escolher canal + tipo
- Sistema sugere automação
- Um clique para executar

## 🔄 Sincronização com Chatwoot

### Automática

Cron job a cada hora:
```bash
0 * * * * node api/automacoes-sync.js
```

Ou via API:
```bash
POST /api/automacoes/sync
Authorization: Bearer seu-token
```

### Manual

Clique em **"🔄 Sincronizar Chatwoot"** no dashboard

## 📡 Endpoints da API

### Automações

```
GET    /api/automacoes                    # Listar todas
GET    /api/automacoes?canal=whatsapp     # Filtrar por canal
GET    /api/automacoes/:id                # Detalhes
POST   /api/automacoes                    # Criar
PUT    /api/automacoes/:id                # Atualizar
DELETE /api/automacoes/:id                # Deletar
```

### Execução

```
POST   /api/automacoes/:id/execute        # Executar específica
POST   /api/automacoes/execute/smart      # Seleção inteligente
```

**Exemplo:**
```bash
curl -X POST http://localhost:3001/api/automacoes/1/execute \
  -H "Authorization: Bearer seu-token" \
  -H "Content-Type: application/json" \
  -d '{
    "contact": {
      "id": "123",
      "nome": "João"
    }
  }'
```

### Regras

```
GET    /api/automacoes/regras             # Listar todas
POST   /api/automacoes/regras             # Criar
DELETE /api/automacoes/regras/:id         # Deletar
```

### Sincronização

```
POST   /api/automacoes/sync               # Sincronizar agora
GET    /api/automacoes/sync/status        # Status último sync
```

### Estatísticas

```
GET    /api/automacoes/stats              # Stats gerais
```

## 📝 Estrutura de Dados

### Tabela: automacoes

| Campo | Tipo | Descrição |
|-------|------|-----------|
| id | BIGINT | ID único |
| nome | TEXT | Nome da automação |
| descricao | TEXT | Descrição |
| canal | TEXT | whatsapp, email, sms, facebook, instagram, telegram |
| tipo | TEXT | boas_vindas, confirmacao, notificacao, suporte, marketing |
| conteudo | TEXT | Corpo da mensagem |
| ativa | BOOLEAN | Status |
| chatwoot_id | BIGINT | ID no Chatwoot (se sincronizado) |
| ultima_execucao | TIMESTAMP | Última execução |
| total_execucoes | INTEGER | Contador |

### Tabela: automacao_regras

| Campo | Tipo | Descrição |
|-------|------|-----------|
| id | BIGINT | ID único |
| nome | TEXT | Nome da regra |
| condicao | TEXT | canal, tipo, periodo, prioridade |
| valor | TEXT | Valor da condição |
| automacao_id | BIGINT | FK para automacoes |
| prioridade | INTEGER | Menor = maior prioridade |
| ativa | BOOLEAN | Status |

### Tabela: automacao_execucoes

| Campo | Tipo | Descrição |
|-------|------|-----------|
| id | BIGINT | ID único |
| automacao_id | BIGINT | FK para automacoes |
| canal | TEXT | Canal usado |
| tipo | TEXT | Tipo |
| resultado | JSONB | Resposta da execução |
| status | TEXT | sucesso, erro, pendente |
| duracao_ms | INTEGER | Tempo de execução |

## 🎯 Casos de Uso

### Caso 1: Boas-vindas Automáticas

1. Criar automação "Boas-vindas WhatsApp"
2. Canal: WhatsApp
3. Tipo: Boas-vindas
4. Criar regra: Se canal = whatsapp → use esta automação
5. Cada novo contato no WhatsApp dispara automaticamente

### Caso 2: Confirmação de Pedido

1. Criar automação "Confirmação Email"
2. Canal: Email
3. Tipo: Confirmação
4. API POST /api/automacoes/1/execute com dados do pedido
5. Email enviado automaticamente

### Caso 3: Seletor Inteligente

1. Selecionar: Canal = SMS, Tipo = Notificação
2. Dashboard sugere: "Notificação de Entrega SMS"
3. Clicar "Executar"
4. Automação executada com 1 clique

## 🔐 Segurança

- ✅ RLS habilitado no Supabase
- ✅ Autenticação Bearer token
- ✅ Validações de entrada
- ✅ Logs auditados

## 📊 Monitoramento

### Views Úteis

**Automações com Estatísticas:**
```sql
SELECT * FROM vw_automacoes_stats;
```

**Regras Detalhadas:**
```sql
SELECT * FROM vw_automacao_regras_detalhes;
```

### Logs

Todos os eventos são registrados em `automacao_logs`:
- Execuções
- Sincronizações
- Erros
- Auditoria

Consulte:
```sql
SELECT * FROM automacao_logs 
WHERE nivel = 'error' 
ORDER BY created_at DESC;
```

## 🛠️ Troubleshooting

### "Erro ao carregar automações"
- Verifique credenciais Supabase
- Confirme que as tabelas foram criadas
- Cheque console do navegador (F12)

### "Erro na sincronização com Chatwoot"
- Verifique URL e token do Chatwoot
- Teste com curl: `curl -H "Authorization: Bearer TOKEN" URL/api/v1/automation_rules`
- Logs em `automacao_logs`

### "Nenhuma automação disponível"
- Crie manualmente ou sincronize do Chatwoot
- Verifique se está marcada como ativa
- Confirme canal e tipo corretos

## 📈 Próximas Melhorias

- [ ] Integração com n8n para fluxos complexos
- [ ] Agendamento de automações
- [ ] A/B testing de conteúdo
- [ ] Analytics avançado
- [ ] Webhooks customizados
- [ ] Editor visual de fluxos

## 📞 Suporte

Para dúvidas ou problemas:
1. Consulte os logs: `/api/automacoes/logs`
2. Verifique schema: `/database/automacoes-schema.sql`
3. Teste endpoints com Postman
4. Verifique credenciais

---

**Versão:** 1.0.0  
**Última atualização:** Abril 2026
