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

-- ── Atualiza policies RLS para o role=reunioes ─────────────────────────
-- Problema anterior: quando o Artur movia um lead de "Reunião Agendada" para
-- outro status (ex.: "Em Abertura" depois de marcar a reunião como realizada),
-- a linha deixava de ser visível (USING do SELECT falha — não é mais
-- Reunião Agendada e, se ele não é o assigned_to, nem por dono ele vê).
-- O PATCH ... return=representation voltava vazio e o front interpretava como
-- erro de conexão.
--
-- Correção: o role=reunioes continua enxergando o lead se ele tem um
-- meeting_outcome gravado (ou seja, passou pela página Reuniões).
-- Isso mantém o histórico visível no painel dele mesmo após o status mudar.
drop policy if exists leads_select on public.crm_leads;
create policy leads_select on public.crm_leads for select using (
  current_user_role() = 'admin'
  or assigned_to = auth.uid()
  or (
    current_user_role() = 'reunioes' and (
      status = 'Reunião Agendada' or meeting_outcome is not null
    )
  )
);

drop policy if exists leads_modify on public.crm_leads;
create policy leads_modify on public.crm_leads for all using (
  current_user_role() = 'admin'
  or assigned_to = auth.uid()
  or (
    current_user_role() = 'reunioes' and (
      status = 'Reunião Agendada' or meeting_outcome is not null
    )
  )
) with check (
  current_user_role() = 'admin'
  or assigned_to = auth.uid()
  or current_user_role() = 'reunioes'
);

drop policy if exists activity_select on public.crm_activity;
create policy activity_select on public.crm_activity for select using (
  exists (
    select 1 from public.crm_leads l
    where l.id = crm_activity.lead_id and (
      current_user_role() = 'admin'
      or l.assigned_to = auth.uid()
      or (
        current_user_role() = 'reunioes' and (
          l.status = 'Reunião Agendada' or l.meeting_outcome is not null
        )
      )
    )
  )
);
