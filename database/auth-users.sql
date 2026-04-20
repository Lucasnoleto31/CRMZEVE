-- ═══════════════════════════════════════════════════════════════════════
-- FASE 2 — AUTH, USUÁRIOS E PERMISSÕES
-- Rode este SQL no SQL Editor do Supabase UMA ÚNICA VEZ.
-- Depois, rode scripts/auth-seed.js no terminal para criar os usuários.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1) Tabela de usuários do CRM ──────────────────────────────────────
-- Espelha auth.users (Supabase Auth) e guarda papel (role) e metadados.
-- Populada pelo trigger on_auth_user_created abaixo.
create table if not exists crm_users (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null unique,
  name       text not null default '',
  role       text not null default 'vendedor' check (role in ('admin','vendedor','reunioes')),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_crm_users_role on crm_users(role);

-- ── 2) Trigger: sempre que um usuário é criado no Supabase Auth,
--     cria a linha correspondente em crm_users com role/name vindos
--     dos user_metadata (definidos pelo seed script).
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.crm_users (id, email, name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'name',  ''),
    coalesce(new.raw_user_meta_data->>'role', 'vendedor')
  )
  on conflict (id) do update
     set email = excluded.email,
         name  = coalesce(nullif(excluded.name, ''), crm_users.name),
         role  = excluded.role;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── 3) assigned_to em crm_leads ───────────────────────────────────────
-- FK para crm_users — quem é o dono atual deste lead.
alter table crm_leads
  add column if not exists assigned_to uuid references crm_users(id) on delete set null;

create index if not exists idx_crm_leads_assigned_to on crm_leads(assigned_to);

-- ── 4) Helper: retorna o role do usuário logado ───────────────────────
create or replace function public.current_user_role()
returns text language sql stable security definer as $$
  select role from public.crm_users where id = auth.uid();
$$;

-- ── 5) RLS nas tabelas ────────────────────────────────────────────────
alter table crm_users    enable row level security;
alter table crm_leads    enable row level security;
alter table crm_activity enable row level security;
alter table crm_stage_templates enable row level security;

-- Remove policies antigas "allow_all" se existirem (do setup inicial)
drop policy if exists "allow_all" on crm_leads;
drop policy if exists "allow_all" on crm_activity;
drop policy if exists "allow_all" on crm_stage_templates;

-- crm_users: cada usuário vê a si; admin vê todos
drop policy if exists users_select on crm_users;
create policy users_select on crm_users for select
  using ( id = auth.uid() or current_user_role() = 'admin' );

drop policy if exists users_modify_admin on crm_users;
create policy users_modify_admin on crm_users for all
  using ( current_user_role() = 'admin' )
  with check ( current_user_role() = 'admin' );

-- crm_leads:
--   admin: tudo
--   vendedor: só os leads com assigned_to = ele
--   reunioes: leads com assigned_to = ele OU status = 'Reunião Agendada'
drop policy if exists leads_select on crm_leads;
create policy leads_select on crm_leads for select using (
  current_user_role() = 'admin'
  or assigned_to = auth.uid()
  or (current_user_role() = 'reunioes' and status = 'Reunião Agendada')
);

drop policy if exists leads_modify on crm_leads;
create policy leads_modify on crm_leads for all using (
  current_user_role() = 'admin'
  or assigned_to = auth.uid()
  or (current_user_role() = 'reunioes' and status = 'Reunião Agendada')
) with check (
  current_user_role() = 'admin'
  or assigned_to = auth.uid()
  or (current_user_role() = 'reunioes')
);

-- crm_activity: vê quem pode ver o lead dono; escreve admin + dono
drop policy if exists activity_select on crm_activity;
create policy activity_select on crm_activity for select using (
  exists (
    select 1 from crm_leads l
    where l.id = crm_activity.lead_id and (
      current_user_role() = 'admin'
      or l.assigned_to = auth.uid()
      or (current_user_role() = 'reunioes' and l.status = 'Reunião Agendada')
    )
  )
);

drop policy if exists activity_insert on crm_activity;
create policy activity_insert on crm_activity for insert with check (
  current_user_role() is not null
);

-- crm_stage_templates: admin edita, todos autenticados leem
drop policy if exists stage_templates_select on crm_stage_templates;
create policy stage_templates_select on crm_stage_templates for select
  using ( auth.uid() is not null );

drop policy if exists stage_templates_modify on crm_stage_templates;
create policy stage_templates_modify on crm_stage_templates for all
  using ( current_user_role() = 'admin' )
  with check ( current_user_role() = 'admin' );
