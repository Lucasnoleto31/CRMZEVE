// ═══════════════════════════════════════════════════════════════════════
// Templates de boas-vindas / prospecção — fonte única
// ─────────────────────────────────────────────────────────────────────────
// Usado por:
//   • bot.js          → rotaciona pra cada novo lead que cai no CRM
//                       (group_join + importação de membros existentes)
//   • disparo-massa.js → rotaciona no disparo em massa pra base
//
// Cada item precisa ter:
//   • template_name    → idêntico ao template aprovado no Meta
//   • template_body    → texto pra exibição local no Chatwoot/logs
//                        (o que o destinatário recebe é o aprovado no Meta)
//   • language         → ex: 'pt_BR'
//   • category         → ex: 'MARKETING'
//
// Pra trocar um texto: edite (ou recrie) o template no Meta Business Manager
// e reflita o novo template_name e template_body aqui.
// ═══════════════════════════════════════════════════════════════════════

const TEMPLATES_BOAS_VINDAS = [
  {
    template_name: 'diagnostico_3_momentos',
    template_body:
`Aqui é o Artur, do time do Fabrício.

Tô organizando o conteúdo da semana e quero te direcionar pro material certo. Me responde com um número:

1 — Não comecei a operar ainda
2 — Opero mas não tô consistente
3 — Opero bem e quero escalar

Mando o material específico do seu momento.`,
    language: 'pt_BR',
    category: 'MARKETING',
  },
  {
    template_name: 'setup_vs_impulso',
    template_body:
`Pergunta direta do time do Fabrício:

Quando você entra numa operação, é porque seu setup deu sinal ou porque o mercado tá "andando"?

Pode responder sem vergonha, ninguém vai julgar. A gente pergunta isso porque a maioria que perde dinheiro confunde os dois.`,
    language: 'pt_BR',
    category: 'MARKETING',
  },
  {
    template_name: 'bastidor_pergunta_fabricio',
    template_body:
`Tava conversando com o Fabrício hoje e ele me pediu pra te perguntar uma coisa.

O que mais te atrapalha hoje quando você opera: falta de tempo, falta de estratégia, emocional, ou ainda tá perdido pra começar?

Respondendo, eu te conto o que ele falou sobre isso.`,
    language: 'pt_BR',
    category: 'MARKETING',
  },
  {
    template_name: 'convite_papo_artur',
    template_body:
`Aqui é o Artur. Tô abrindo agenda essa semana pra conversa rápida 1 a 1 com quem quer começar a operar junto com o Fabrício direto.

Não é live, não é grupo. É papo pra entender seu momento e ver se faz sentido.

Quer marcar um horário? Responde SIM que eu te mando a agenda.`,
    language: 'pt_BR',
    category: 'MARKETING',
  },
  {
    template_name: 'corretora_atual',
    template_body:
`Aqui é o Artur. Pergunta rápida: hoje você opera por qual corretora?

Pergunto porque tem um detalhe sobre quem opera com a gente direto que pode mudar o jogo pro seu caso. Mas depende de onde você tá hoje.

Me responde só o nome da corretora, eu te explico.`,
    language: 'pt_BR',
    category: 'MARKETING',
  },
];

// ─── Templates de RECONTATO ──────────────────────────────────────────────
// Disparados pelo disparo-massa.js quando rodado com --apenas-label=ghost.
// Pra leads que já receberam disparo e nunca responderam (label 'ghost').
// Estratégia: limpa-ou-resgata — qualifica quem ainda quer receber conteúdo
// e identifica definitivamente quem virou lixo (pra parar de queimar dinheiro).
const TEMPLATES_RECONTATO = [
  {
    template_name: 'recontato_lista_limpa',
    template_body:
`Aqui é o Artur. Tô fazendo uma limpa na minha lista esse mês e antes de te tirar daqui queria te perguntar:

Você ainda quer receber conteúdo do Fabrício sobre operação?

SIM se quer continuar. PARAR se prefere que eu pare por aqui.

Sem ressentimento, prometo.`,
    language: 'pt_BR',
    category: 'MARKETING',
  },
  {
    template_name: 'recontato_novidade_fabricio',
    template_body:
`Faz um tempo que não falo contigo, foi mal.

Aproveita que tô voltando que tem uma coisa nova: o Fabrício mudou o operacional dele no mini esse mês. Posso te mandar como ficou?

Responde SIM. Sem custo, sem pegadinha.`,
    language: 'pt_BR',
    category: 'MARKETING',
  },
];

module.exports = { TEMPLATES_BOAS_VINDAS, TEMPLATES_RECONTATO };
