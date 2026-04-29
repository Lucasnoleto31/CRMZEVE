-- ═══════════════════════════════════════════════════════════════════════
-- FASE 5 — DISPARO AUTOMÁTICO AIKON (schema)
-- Estende crm_stage_templates para mapear template ↔ categoria_ia.
-- Idempotente. Roda DEPOIS da Fase 1 (conversion-upgrade.sql).
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1) Mapeamento template ↔ categoria_ia ────────────────────────────
-- Quando categoria_filter é NULL, o template serve a qualquer categoria.
-- Quando preenchida, só dispara para leads daquela categoria_ia.
alter table public.crm_stage_templates
  add column if not exists categoria_filter text,           -- 'Aumentar Lotes' | 'Inconsistente' | 'Começando' | NULL
  add column if not exists priority         integer not null default 100,
  add column if not exists last_dispatched_at timestamptz;

create index if not exists idx_crm_stage_templates_dispatch
  on public.crm_stage_templates (stage, categoria_filter, enabled, priority asc);


-- ── 2) Tabela de quota diária por vendedor ────────────────────────────
-- Anti-spam financeiro: cada vendedor tem cap de N templates/dia.
-- Reset diário (a chave inclui a data, então só conta hoje).
create table if not exists public.crm_daily_outbound (
  user_id  uuid not null references public.crm_users(id) on delete cascade,
  day      date not null default current_date,
  count    integer not null default 0,
  primary key (user_id, day)
);

create or replace function public.bump_daily_outbound(p_user uuid)
returns integer language plpgsql security definer as $$
declare
  v_count integer;
begin
  insert into public.crm_daily_outbound (user_id, day, count)
       values (p_user, current_date, 1)
  on conflict (user_id, day) do update
       set count = public.crm_daily_outbound.count + 1
  returning count into v_count;
  return v_count;
end $$;


-- ── 3) View: estatísticas de atribuição por template ──────────────────
-- Útil pro admin ver "qual copy converte". Reaproveita RLS via select.
create or replace view public.v_template_performance as
  select
    template_name,
    count(*)                                   as total,
    count(*) filter (where outcome='sent')     as sent,
    count(*) filter (where outcome='delivered')as delivered,
    count(*) filter (where outcome='responded')as responded,
    count(*) filter (where outcome='qualified')as qualified,
    count(*) filter (where outcome='converted')as converted,
    coalesce(sum(cost_brl),0)::numeric(12,2)   as cost_total_brl,
    case when count(*) filter (where outcome='sent') > 0
         then round(100.0 * count(*) filter (where outcome='qualified') / count(*) filter (where outcome='sent'), 2)
         else 0 end                            as qualif_rate_pct
    from public.crm_attributions
   where template_name is not null
   group by template_name
   order by total desc;


-- ── 4) Quota diária visível por vendedor (admin acompanha) ───────────
create or replace view public.v_daily_outbound_today as
  select u.id, u.name, u.email, u.role,
         coalesce(d.count, 0) as templates_hoje
    from public.crm_users u
    left join public.crm_daily_outbound d
      on d.user_id = u.id and d.day = current_date
   where u.active = true
   order by templates_hoje desc;


-- ═══════════════════════════════════════════════════════════════════════
-- Após rodar este SQL, popule crm_stage_templates com os templates
-- aprovados Meta — exemplo:
--
--   insert into crm_stage_templates (stage, template_name, template_body,
--          language, category, enabled, categoria_filter, priority)
--   values
--   ('Qualificado', 'aikon_aumentar_lotes_m1',
--    'Oi {{1}}! Aqui é o AIKON, da Zeve. Vi que você já opera...',
--    'pt_BR', 'MARKETING', true, 'Aumentar Lotes', 10),
--   ('Qualificado', 'aikon_inconsistente_m1',
--    'Oi {{1}}! ...', 'pt_BR', 'MARKETING', true, 'Inconsistente', 10),
--   ('Qualificado', 'aikon_comecando_m1',
--    'Oi {{1}}! ...', 'pt_BR', 'MARKETING', true, 'Começando', 10);
--
-- O disparo só ativa quando AIKON_AUTO_DISPATCH=true em Vercel env.
-- ═══════════════════════════════════════════════════════════════════════
