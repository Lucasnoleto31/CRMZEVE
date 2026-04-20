-- Notificações in-app por usuário.
-- Rode depois do auth-users.sql. Idempotente.

create table if not exists public.crm_notifications (
  id         bigserial primary key,
  user_id    uuid not null references public.crm_users(id) on delete cascade,
  lead_id    bigint references public.crm_leads(id) on delete cascade,
  type       text not null default 'info',
  message    text not null,
  read       boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_crm_notif_user_unread
  on public.crm_notifications (user_id, read, created_at desc);

alter table public.crm_notifications enable row level security;

-- Cada usuário lê somente as próprias notificações (admin vê todas).
drop policy if exists notif_select_own on public.crm_notifications;
create policy notif_select_own on public.crm_notifications for select
  using (user_id = auth.uid() or public.current_user_role() = 'admin');

-- Cada usuário pode marcar as próprias como lidas (admin pode todas).
drop policy if exists notif_update_own on public.crm_notifications;
create policy notif_update_own on public.crm_notifications for update
  using (user_id = auth.uid() or public.current_user_role() = 'admin')
  with check (user_id = auth.uid() or public.current_user_role() = 'admin');

-- INSERT intencionalmente sem policy: só service_role (bot/proxy interno)
-- cria notificações, e service_role bypassa RLS.
