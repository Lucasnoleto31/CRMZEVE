-- ═══════════════════════════════════════════════════════════════════════
-- FIX: PostgREST upsert em crm_stage_templates
--
-- Problema: a migration funnel-stage-refactor.sql criou um INDEX único
-- composto, mas PostgREST exige uma CONSTRAINT (não index) pra ON CONFLICT.
-- Erro: "there is no unique or exclusion constraint matching the ON CONFLICT".
--
-- Solução: substituir o índice por uma UNIQUE CONSTRAINT com NULLS NOT
-- DISTINCT (Postgres 15+, suportado pelo Supabase). Isso faz NULL = NULL
-- pra fins de unicidade — exatamente o que precisamos pra
-- (stage, categoria_filter) onde categoria_filter pode ser null.
-- ═══════════════════════════════════════════════════════════════════════

-- 1) Remove o índice único anterior (criado em funnel-stage-refactor.sql)
drop index if exists public.crm_stage_templates_stage_cat_uniq;

-- 2) Remove constraint antiga em (stage) caso ainda exista, sob qualquer
--    nome conhecido. Idempotente — se nenhuma existir, não faz nada.
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'crm_stage_templates_stage_key') then
    alter table public.crm_stage_templates drop constraint crm_stage_templates_stage_key;
  end if;
  if exists (select 1 from pg_constraint where conname = 'crm_stage_templates_stage_unique') then
    alter table public.crm_stage_templates drop constraint crm_stage_templates_stage_unique;
  end if;
  if exists (select 1 from pg_constraint where conname = 'crm_stage_templates_stage_cat_unique') then
    alter table public.crm_stage_templates drop constraint crm_stage_templates_stage_cat_unique;
  end if;
end $$;

-- 3) Cria UNIQUE CONSTRAINT (não index!) com NULLS NOT DISTINCT
--    → permite ON CONFLICT (stage, categoria_filter) funcionar
--    → trata NULL = NULL pra evitar duplicatas com categoria_filter nulo
alter table public.crm_stage_templates
  add constraint crm_stage_templates_stage_cat_unique
  unique nulls not distinct (stage, categoria_filter);


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICAÇÃO:
--   select conname, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'public.crm_stage_templates'::regclass;
--
-- Esperado ver:
--   crm_stage_templates_stage_cat_unique UNIQUE NULLS NOT DISTINCT (stage, categoria_filter)
-- ═══════════════════════════════════════════════════════════════════════
