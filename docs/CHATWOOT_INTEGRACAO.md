# 🔗 Integração Chatwoot + Base de Automações

Este guia explica como conectar seu Chatwoot à Base de Automações do CRMZEVE.

## 🎯 Objetivo

Sincronizar todos os disparos (automation rules) do Chatwoot e executá-los a partir da interface unificada.

## 1️⃣ Obter Token do Chatwoot

### Passo 1: Acessar Configurações

1. Acesse seu Chatwoot em `https://seu-chatwoot.com`
2. Vá para **Settings** → **API** ou **Account Settings**
3. Encontre **API Tokens** ou **Personal Access Tokens**

### Passo 2: Gerar Token

- Clique em **Create New Token** ou **Generate Token**
- Escopo necessário: `automation_rules:read`, `automation_rules:write`
- Copie o token (não será mostrado novamente!)

### Passo 3: Encontrar Account ID

Acesse: `https://seu-chatwoot.com/api/v1/accounts`

Resposta:
```json
{
  "data": [
    {
      "id": 1,
      "name": "Sua Conta"
    }
  ]
}
```

Anote o `id` (geralmente é 1).

## 2️⃣ Configurar Credenciais

### Opção A: Arquivo .env (Recomendado)

Crie `.env` baseado em `.env.example`:

```bash
CHATWOOT_API=https://seu-chatwoot.com
CHATWOOT_TOKEN=seu_token_aqui
CHATWOOT_ACCOUNT_ID=1
```

### Opção B: Variáveis de Ambiente

```bash
export CHATWOOT_API=https://seu-chatwoot.com
export CHATWOOT_TOKEN=seu_token_aqui
export CHATWOOT_ACCOUNT_ID=1
```

### Opção C: Dashboard HTML

Edite `automacoes.html`:

```javascript
const CHATWOOT_API = 'https://seu-chatwoot.com';
const CHATWOOT_TOKEN = 'seu-token-aqui';
```

## 3️⃣ Testar Conexão

### Via cURL

```bash
curl -X GET "https://seu-chatwoot.com/api/v1/accounts/1/automation_rules" \
  -H "Authorization: Bearer seu_token_aqui" \
  -H "Content-Type: application/json"
```

Resposta esperada:
```json
{
  "payload": [
    {
      "id": 1,
      "name": "Boas-vindas WhatsApp",
      "description": "Mensagem automática de boas-vindas",
      "enabled": true,
      "trigger": { ... },
      "actions": [ ... ]
    }
  ]
}
```

### No Node.js

```bash
node -e "
const sync = require('./api/automacoes-sync.js');
sync.syncAutomations().then(r => console.log(JSON.stringify(r, null, 2)));
"
```

## 4️⃣ Sincronizar Automações

### Opção 1: Dashboard

1. Abra `automacoes.html`
2. Clique em **🔄 Sincronizar Chatwoot**
3. Aguarde confirmação

### Opção 2: API

```bash
curl -X POST http://localhost:3001/api/automacoes/sync \
  -H "Authorization: Bearer seu-token-api" \
  -H "Content-Type: application/json"
```

### Opção 3: Automático (Cron)

Adicione ao crontab (a cada hora):

```bash
0 * * * * cd /caminho/para/CRMZEVE && node api/automacoes-sync.js
```

## 5️⃣ Estrutura do Disparador Chatwoot

### Trigger (Condição)

```json
{
  "trigger_on": "contact_attributes",
  "name": "customer_first_name"
}
```

### Actions (Ações)

```json
{
  "action_name": "send_message",
  "action_params": {
    "message": "Olá {{customer.name}}!",
    "message_type": "template"
  }
}
```

## 6️⃣ Mapeamento Automático

O sistema tenta mapear automaticamente:

**Canal** extraído de:
- Nome da automação (`whatsapp`, `email`, `sms`, etc)
- Trigger (`trigger_on` contém `channel`, `email_channel`, etc)

**Tipo** extraído de:
- Nome (`boas-vindas`, `confirmação`, `notificação`, `suporte`, `marketing`)

## 7️⃣ Executar Automação Sincronizada

### Pelo Dashboard

1. Abra **Execução Rápida**
2. Selecione Canal: "WhatsApp"
3. Selecione Tipo: "Boas-vindas"
4. Clique **▶️ Executar Automação**

### Pela API

```bash
curl -X POST http://localhost:3001/api/automacoes/1/execute \
  -H "Authorization: Bearer seu-token-api" \
  -H "Content-Type: application/json" \
  -d '{
    "contact": {
      "id": "contact_123",
      "name": "João Silva",
      "email": "joao@exemplo.com"
    }
  }'
```

## 8️⃣ Webhook do Chatwoot

Configure webhook no Chatwoot para atualizar base:

**URL:** `http://seu-servidor.com/api/automacoes/webhook/chatwoot`

**Eventos:**
- `automation_rule.executed`
- `automation_rule.created`
- `automation_rule.updated`
- `automation_rule.deleted`

No Chatwoot:

1. **Settings** → **Integrations** → **Webhooks**
2. URL: `http://seu-servidor.com/api/automacoes/webhook/chatwoot`
3. Eventos: Selecione `automation_rule.*`
4. Salve

## 🔍 Troubleshooting

### "401 Unauthorized"

**Solução:**
- Verifique token do Chatwoot
- Confirme que ainda é válido
- Regenere se necessário

### "404 Not Found"

**Solução:**
- Verifique URL do Chatwoot
- Verifique Account ID
- Teste endpoint direto com curl

### "Nenhuma automação sincronizada"

**Solução:**
1. Crie automações no Chatwoot primeiro
2. Verifique se estão ativas
3. Verifique logs: `SELECT * FROM automacao_logs WHERE tipo_log = 'sincronizacao'`

### "Erro ao executar automação"

**Solução:**
1. Verifique dados de contato
2. Veja detalhes em `automacao_execucoes`
3. Procure stack trace em `automacao_logs`

## 📊 Monitoramento

### Ver Automações Sincronizadas

```sql
SELECT nome, canal, tipo, ultima_execucao, total_execucoes
FROM automacoes
WHERE chatwoot_id IS NOT NULL
ORDER BY ultima_execucao DESC;
```

### Ver Histórico de Sincronização

```sql
SELECT * FROM automacao_sincronizacao
ORDER BY created_at DESC
LIMIT 10;
```

### Ver Execuções

```sql
SELECT a.nome, e.status, e.created_at
FROM automacao_execucoes e
JOIN automacoes a ON e.automacao_id = a.id
ORDER BY e.created_at DESC;
```

## ✅ Checklist de Configuração

- [ ] Token Chatwoot gerado e testado
- [ ] Account ID confirmado
- [ ] Credenciais em `.env`
- [ ] Conexão testada com cURL
- [ ] Automações sincronizadas
- [ ] Dashboard acessível
- [ ] API rodando
- [ ] Webhook configurado (opcional)

## 🎓 Exemplo Completo

### Cenário: Boas-vindas WhatsApp Automática

**1. No Chatwoot:**
- Criar automação "Boas-vindas WhatsApp"
- Trigger: Novo contato
- Action: Enviar mensagem no WhatsApp
- Ativar

**2. No CRMZEVE:**
- Sincronizar Chatwoot
- Criar regra: Se canal=whatsapp → execute esta
- Automação pronta

**3. Em Produção:**
- Cada novo contato no WhatsApp dispara automaticamente
- Histórico registrado em `automacao_execucoes`
- Analytics disponível em `vw_automacoes_stats`

---

**Versão:** 1.0.0  
**Última atualização:** Abril 2026
