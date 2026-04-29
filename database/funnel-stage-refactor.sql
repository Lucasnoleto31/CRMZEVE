-- ═══════════════════════════════════════════════════════════════════════
-- REFACTOR: status antigos → etapas dinâmicas do funil (11 estados)
--
-- Idempotente. Roda DEPOIS de conversion-upgrade.sql E lead-signal.sql.
--
-- Estados:
--   AUTOMÁTICOS (calculados via view, NUNCA setados em crm_leads.status):
--     'aguardando', 'silencio', 'ativo', 'esfriando'
--   MANUAIS (setados em crm_leads.status):
--     'novo', 'atendimento', 'reuniao', 'abrindo', 'cliente', 'ghost', 'morto'
--
-- O frontend lê SEMPRE crm_leads_full.funnel_stage (computado).
-- A view aplica prioridade: se status manual ≠ 'novo', retorna status;
-- senão, calcula a etapa pelo comportamento (last_inbound/outbound).
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1) Migra valores em crm_leads.status ────────────────────────────
-- Conversões:
--   'Lead Novo'         → 'novo'
--   'IA Disparou'       → 'novo'           (view recalcula aguardando/silencio)
--   'Qualificado'       → 'novo'           (view recalcula ativo/silencio/esfriando)
--   'AIKON em Ação'     → 'atendimento'
--   'Reunião Agendada'  → 'reuniao'
--   'Em Abertura'       → 'abrindo'
--   'Convertido'        → 'cliente'
--   'Perdido' c/ loss_category='sem_resposta' → 'ghost'
--   'Perdido' c/ outras categorias            → 'morto'

-- Antes de migrar, removemos a constraint antiga (se houver) — vamos
-- recriá-la com os valores novos no fim.
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'crm_leads_status_check') then
    alter table public.crm_leads drop constraint crm_leads_status_check;
  end if;
end $$;

update public.crm_leads set status = 'novo'         where status = 'Lead Novo';
update public.crm_leads set status = 'novo'         where status = 'IA Disparou';
update public.crm_leads set status = 'novo'         where status = 'Qualificado';
update public.crm_leads set status = 'atendimento'  where status = 'AIKON em Ação';
update public.crm_leads set status = 'reuniao'      where status = 'Reunião Agendada';
update public.crm_leads set status = 'abrindo'      where status = 'Em Abertura';
update public.crm_leads set status = 'cliente'      where status = 'Convertido';
update public.crm_leads set status = 'ghost'        where status = 'Perdido' and loss_category = 'sem_resposta';
update public.crm_leads set status = 'morto'        where status = 'Perdido' and (loss_category is null or loss_category != 'sem_resposta');

-- Se restou algum 'Perdido' sem loss_category (não devia, mas defensivo): ghost
update public.crm_leads set status = 'ghost'        where status = 'Perdido';

-- Constraint nova: status só aceita os 7 valores manuais
alter table public.crm_leads
  add constraint crm_leads_status_check check (
    status in ('novo','atendimento','reuniao','abrindo','cliente','ghost','morto')
  );


-- ── 2) Migra crm_stage_templates.stage ──────────────────────────────
-- Templates eram indexados por etapa (stage). Conversões análogas.
-- A unique(stage) pode causar conflito se dois antigos mapearem pro
-- mesmo novo — desabilitamos temporariamente, deduplicamos, recriamos.

do $$ begin
  if exists (
    select 1 from pg_constraint
    where conname = 'crm_stage_templates_stage_key'
       or conname = 'crm_stage_templates_stage_unique'
  ) then
    alter table public.crm_stage_templates drop constraint if exists crm_stage_templates_stage_key;
    alter table public.crm_stage_templates drop constraint if exists crm_stage_templates_stage_unique;
  end if;
end $$;

update public.crm_stage_templates set stage = 'novo'         where stage in ('Lead Novo','IA Disparou','Qualificado');
update public.crm_stage_templates set stage = 'atendimento'  where stage = 'AIKON em Ação';
update public.crm_stage_templates set stage = 'reuniao'      where stage = 'Reunião Agendada';
update public.crm_stage_templates set stage = 'abrindo'      where stage = 'Em Abertura';
update public.crm_stage_templates set stage = 'cliente'      where stage = 'Convertido';

-- Deduplica: se sobraram múltiplos templates pro mesmo stage, mantém
-- o mais recente (priority menor + updated_at maior).
delete from public.crm_stage_templates a
 using public.crm_stage_templates b
 where a.id < b.id
   and a.stage = b.stage
   and coalesce(a.categoria_filter, '') = coalesce(b.categoria_filter, '');

-- Recria a unicidade — agora considerando o filtro de categoria
-- (permite ter 1 template por (stage, categoria_filter)).
create unique index if not exists crm_stage_templates_stage_cat_uniq
  on public.crm_stage_templates (stage, coalesce(categoria_filter, ''));


-- ── 3) Atualiza policies RLS de role=reunioes para o novo nome ──────
-- Antes: status = 'Reunião Agendada'. Agora: status = 'reuniao'.
drop policy if exists leads_select on public.crm_leads;
create policy leads_select on public.crm_leads for select using (
  public.current_user_role() = 'admin'
  or assigned_to = auth.uid()
  or (
    public.current_user_role() = 'reunioes' and (
      status = 'reuniao' or meeting_outcome is not null
    )
  )
);

drop policy if exists leads_modify on public.crm_leads;
create policy leads_modify on public.crm_leads for all using (
  public.current_user_role() = 'admin'
  or assigned_to = auth.uid()
  or (
    public.current_user_role() = 'reunioes' and (
      status = 'reuniao' or meeting_outcome is not null
    )
  )
) with check (
  public.current_user_role() = 'admin'
  or assigned_to = auth.uid()
  or public.current_user_role() = 'reunioes'
);

drop policy if exists activity_select on public.crm_activity;
create policy activity_select on public.crm_activity for select using (
  exists (
    select 1 from public.crm_leads l
    where l.id = crm_activity.lead_id and (
      public.current_user_role() = 'admin'
      or l.assigned_to = auth.uid()
      or (
        public.current_user_role() = 'reunioes' and (
          l.status = 'reuniao' or l.meeting_outcome is not null
        )
      )
    )
  )
);


-- ── 4) Recria view v_lead_signal com a lógica nova ──────────────────
-- IMPORTANTE: PostgreSQL não permite mudar nome/ordem de colunas via
-- CREATE OR REPLACE VIEW. Como estamos adicionando funnel_stage como
-- coluna nova, precisamos DROP + CREATE. Dependências (crm_leads_full,
-- v_lead_signal_summary) também são dropadas em ordem reversa.
drop view if exists public.v_lead_signal_summary;
drop view if exists public.crm_leads_full;
drop view if exists public.v_lead_signal;

-- Prioridade do estado:
--   1) Status manual (≠ 'novo') vence sempre — vendedor decidiu
--   2) Senão, calcula pelo comportamento
-- Resultado: 11 estados possíveis em funnel_stage.
create view public.v_lead_signal
  with (security_invoker = true) as
  select
    l.id,
    case
      -- Manual tem prioridade
      when l.status in ('atendimento','reuniao','abrindo','cliente','ghost','morto') then l.status
      -- Auto: ainda não tocado
      when l.last_outbound_at is null then 'novo'
      -- Disparou, sem resposta — tempo divide aguardando × silêncio
      when l.last_inbound_at is null and (now() - l.last_outbound_at) < interval '24 hours' then 'aguardando'
      when l.last_inbound_at is null then 'silencio'
      -- Respondeu o último disparo, nas últimas 48h
      when l.last_inbound_at >= l.last_outbound_at and (now() - l.last_inbound_at) < interval '48 hours' then 'ativo'
      -- Respondeu antes mas o último contato foi nosso (esfriando)
      when l.last_inbound_at < l.last_outbound_at then 'esfriando'
      else 'ativo'
    end as funnel_stage,
    -- Compatibilidade: alias 'sinal' para código antigo durante transição
    case
      when l.status in ('atendimento','reuniao','abrindo','cliente','ghost','morto') then l.status
      when l.last_outbound_at is null then 'novo'
      when l.last_inbound_at is null and (now() - l.last_outbound_at) < interval '24 hours' then 'aguardando'
      when l.last_inbound_at is null then 'silencio'
      when l.last_inbound_at >= l.last_outbound_at and (now() - l.last_inbound_at) < interval '48 hours' then 'ativo'
      when l.last_inbound_at < l.last_outbound_at then 'esfriando'
      else 'ativo'
    end as sinal,
    greatest(
      0,
      extract(epoch from (
        now() - coalesce(greatest(l.last_inbound_at, l.last_outbound_at), l.created_at)
      ))::int / 86400
    ) as dias_sem_movimento,
    l.last_inbound_at,
    l.last_outbound_at,
    l.loss_category,
    l.status as status_manual
  from public.crm_leads l;


-- ── 5) Recria crm_leads_full sobre a view nova ──────────────────────
-- (já dropada na seção 4 antes de v_lead_signal)
create view public.crm_leads_full
  with (security_invoker = true) as
  select
    l.*,
    s.funnel_stage,
    s.sinal,
    s.dias_sem_movimento
  from public.crm_leads l
  left join public.v_lead_signal s on s.id = l.id;


-- ── 6) View resumo (para relatório/cron) — nomes novos ──────────────
-- (já dropada na seção 4)
create view public.v_lead_signal_summary
  with (security_invoker = true) as
  select
    funnel_stage,
    count(*)::int as total,
    count(*) filter (where (now() - coalesce(last_inbound_at, last_outbound_at)) < interval '7 days')::int as ultimos_7d
  from public.v_lead_signal
  group by funnel_stage
  order by total desc;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICAÇÃO:
--
--   select status, count(*) from crm_leads group by status;
--   -- Esperado: novo, atendimento, reuniao, abrindo, cliente, ghost, morto
--
--   select funnel_stage, count(*) from v_lead_signal group by funnel_stage;
--   -- Esperado: + aguardando, silencio, ativo, esfriando
--
-- ROLLBACK (em caso de pânico):
--   Restaurar valores antigos é viável SE você tem backup. Não há
--   migration reversa automática porque mapeamento 'IA Disparou'/'Qualificado'
--   → 'novo' perde informação. Faça snapshot antes de rodar:
--     create table crm_leads_bkp_pre_refactor as select * from crm_leads;
-- ═══════════════════════════════════════════════════════════════════════
