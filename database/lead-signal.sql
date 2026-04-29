-- ═══════════════════════════════════════════════════════════════════════
-- LEAD SIGNAL — Sinal de vida do lead (resolve "morreu vs nunca respondeu")
-- Idempotente. Roda DEPOIS de conversion-upgrade.sql (precisa de
-- last_inbound_at e last_outbound_at já existentes em crm_leads).
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1) Categoria de perda padronizada ────────────────────────────────
-- Mantém loss_reason como texto livre (contexto do vendedor) E adiciona
-- loss_category como enumeração fechada — alimenta a distinção
-- crítica entre "morto" (recusa explícita) e "ghost" (silêncio).
alter table public.crm_leads
  add column if not exists loss_category text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'crm_leads_loss_category_chk'
  ) then
    alter table public.crm_leads
      add constraint crm_leads_loss_category_chk check (
        loss_category is null or loss_category in (
          'recusou', 'sem_capital', 'comprou_concorrente', 'sem_resposta'
        )
      );
  end if;
end $$;

-- ── 2) Backfill: Perdidos antigos sem categoria viram "sem_resposta"
-- Premissa conservadora: se o vendedor não preencheu, provavelmente
-- foi um silêncio — vira ghost, não morto. Vendedor pode reclassificar.
update public.crm_leads
   set loss_category = 'sem_resposta'
 where status = 'Perdido' and loss_category is null;

-- Index pra filtros rápidos por categoria
create index if not exists idx_crm_leads_loss_category
  on public.crm_leads (loss_category)
  where loss_category is not null;


-- ── 3) View: sinal de vida do lead (computado) ────────────────────────
-- Resolve a ambiguidade de status_ia=null. Combina:
--   - status (etapa do funil)
--   - last_outbound_at (último disparo nosso)
--   - last_inbound_at (última resposta do lead)
--   - loss_category (motivo padronizado, se Perdido)
--
-- security_invoker=true → respeita RLS de crm_leads automaticamente.
create or replace view public.v_lead_signal
  with (security_invoker = true) as
  select
    l.id,
    case
      when l.status = 'Convertido' then 'convertido'
      when l.status = 'Perdido' and l.loss_category in ('recusou','sem_capital','comprou_concorrente') then 'morto'
      when l.status = 'Perdido' then 'ghost'
      when l.last_outbound_at is null then 'novo'
      when l.last_inbound_at is null and (now() - l.last_outbound_at) < interval '24 hours' then 'aguardando'
      when l.last_inbound_at is null then 'silencio'
      when l.last_inbound_at >= l.last_outbound_at and (now() - l.last_inbound_at) < interval '48 hours' then 'ativo'
      when l.last_inbound_at < l.last_outbound_at then 'esfriando'
      else 'ativo'
    end as sinal,
    -- Dias desde a última movimentação (inbound OU outbound), o que veio depois
    greatest(
      0,
      extract(epoch from (
        now() - coalesce(greatest(l.last_inbound_at, l.last_outbound_at), l.created_at)
      ))::int / 86400
    ) as dias_sem_movimento,
    l.last_inbound_at,
    l.last_outbound_at,
    l.loss_category
  from public.crm_leads l;


-- ── 4) View completa: crm_leads + sinal (uma chamada só pro frontend)
create or replace view public.crm_leads_full
  with (security_invoker = true) as
  select
    l.*,
    s.sinal,
    s.dias_sem_movimento
  from public.crm_leads l
  left join public.v_lead_signal s on s.id = l.id;


-- ── 5) Resumo agregado pro relatório semanal (admin) ─────────────────
create or replace view public.v_lead_signal_summary
  with (security_invoker = true) as
  select
    sinal,
    count(*)::int as total,
    count(*) filter (where (now() - coalesce(last_inbound_at, last_outbound_at)) < interval '7 days')::int as ultimos_7d
  from public.v_lead_signal
  group by sinal
  order by total desc;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICAÇÃO RÁPIDA — rode após aplicar:
--
--   select sinal, total, ultimos_7d from v_lead_signal_summary;
--
-- Esperado: distribuição entre 'ativo','aguardando','silencio','ghost',
-- 'morto','novo','esfriando','convertido'. Se TUDO estiver em 'novo' é
-- porque last_inbound_at/last_outbound_at ainda estão null em todos —
-- o webhook (Fase 2) precisa estar deployado pra começar a popular.
-- ═══════════════════════════════════════════════════════════════════════
