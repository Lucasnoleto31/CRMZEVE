-- Campos dedicados à página "Reuniões" (usados pelo role=reunioes).
-- Rode este SQL no Supabase depois do auth-users.sql.

alter table public.crm_leads
  add column if not exists meeting_at      timestamptz,
  add column if not exists meeting_link    text,
  add column if not exists meeting_outcome text check (meeting_outcome is null or meeting_outcome in ('realizada','nao_compareceu','remarcou','cancelou'));

-- Index para listar rápido as reuniões ordenadas por data
create index if not exists idx_crm_leads_meeting_at
  on public.crm_leads (meeting_at)
  where meeting_at is not null;
