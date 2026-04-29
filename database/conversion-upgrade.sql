-- ═══════════════════════════════════════════════════════════════════════
-- FASE 1 — UPGRADE DE CONVERSÃO
-- Schema, índices, RPC, trigger de round-robin e tabela de atribuição.
-- Idempotente: pode rodar quantas vezes quiser.
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1) Colunas novas em crm_leads ─────────────────────────────────────
-- score:                 cache do calcScore() (0..99). Atualizado pelo cron.
-- score_updated_at:      última recalculação.
-- chatwoot_conversation_id: link direto p/ a conversa no Chatwoot (drawer).
-- last_inbound_at:       última mensagem RECEBIDA do lead (resposta).
-- last_outbound_at:      última mensagem ENVIADA pra ele (anti-spam).
alter table public.crm_leads
  add column if not exists score                    integer not null default 0,
  add column if not exists score_updated_at         timestamptz,
  add column if not exists chatwoot_conversation_id bigint,
  add column if not exists last_inbound_at          timestamptz,
  add column if not exists last_outbound_at         timestamptz;

create index if not exists idx_crm_leads_score
  on public.crm_leads (score desc)
  where status not in ('Convertido','Perdido');

create index if not exists idx_crm_leads_chatwoot_conv
  on public.crm_leads (chatwoot_conversation_id)
  where chatwoot_conversation_id is not null;

create index if not exists idx_crm_leads_last_inbound
  on public.crm_leads (last_inbound_at desc)
  where last_inbound_at is not null;


-- ── 2) Round-robin: contador de leads atribuídos por vendedor ─────────
-- assigned_count: quantos leads ATIVOS estão na carteira do vendedor agora.
-- Usado pelo trigger de atribuição automática para escolher o menos
-- carregado. Mantido por trigger AFTER em crm_leads (abaixo).
alter table public.crm_users
  add column if not exists assigned_count integer not null default 0;

create index if not exists idx_crm_users_round_robin
  on public.crm_users (role, active, assigned_count)
  where active = true;


-- ── 3) Tabela de atribuição (qual disparo gerou qual conversão) ───────
-- Cada disparo de template, cada resposta, cada conversão registra uma
-- linha. Permite query "qual copy tem maior taxa de qualificação".
create table if not exists public.crm_attributions (
  id                bigserial primary key,
  lead_id           bigint not null references public.crm_leads(id) on delete cascade,

  -- Origem do contato
  template_name     text,                          -- nome aprovado Meta
  template_id       bigint references public.crm_stage_templates(id) on delete set null,
  channel           text,                          -- 'whatsapp','email','sms'…
  category_at_time  text,                          -- categoria_ia no momento

  -- Resultado
  outcome           text not null default 'sent',  -- ver constraint abaixo
  outcome_at        timestamptz default now(),

  -- Custo (R$0,55/mensagem template Meta — default refletindo isso)
  cost_brl          numeric(10,4) not null default 0,

  -- Metadados livres (chatwoot_message_id, http response, etc.)
  meta              jsonb,

  created_at        timestamptz not null default now(),

  constraint outcome_valid check (outcome in (
    'sent', 'delivered', 'read', 'responded',
    'qualified', 'meeting_booked', 'converted', 'lost', 'failed'
  ))
);

create index if not exists idx_crm_attributions_lead    on public.crm_attributions(lead_id);
create index if not exists idx_crm_attributions_outcome on public.crm_attributions(outcome, outcome_at desc);
create index if not exists idx_crm_attributions_tpl     on public.crm_attributions(template_name)
  where template_name is not null;

alter table public.crm_attributions enable row level security;

drop policy if exists attributions_select on public.crm_attributions;
create policy attributions_select on public.crm_attributions for select using (
  exists (
    select 1 from public.crm_leads l
    where l.id = crm_attributions.lead_id and (
      public.current_user_role() = 'admin'
      or l.assigned_to = auth.uid()
      or (public.current_user_role() = 'reunioes' and (l.status = 'Reunião Agendada' or l.meeting_outcome is not null))
    )
  )
);

-- INSERT/UPDATE só via service_role (webhook/cron) — sem policy de write.


-- ── 4) RPC mais robusta para buscar lead por telefone ─────────────────
-- Problema: find_lead_by_digits busca pelos últimos 8 dígitos. Dois leads
-- com final igual colidem (ex.: dois traders com sobrenome diferente mas
-- final 9876-5432). Esta versão tenta MAIS específica primeiro:
--   1) Match exato dos últimos 11 dígitos (DDD+9+8 dígitos)
--   2) Últimos 10 dígitos (DDD+8 dígitos sem o 9 extra)
--   3) Fallback: últimos 9 dígitos SE for único; senão NULL
-- Retorna null em vez de o lead errado quando há ambiguidade.
create or replace function public.find_lead_by_phone_strict(search_digits text)
returns setof public.crm_leads
language plpgsql stable security definer as $$
declare
  d text := regexp_replace(coalesce(search_digits,''), '\D', '', 'g');
  tail11 text;
  tail10 text;
  tail9  text;
  cnt    int;
begin
  if length(d) < 8 then return; end if;

  tail11 := right(d, 11);
  tail10 := right(d, 10);
  tail9  := right(d, 9);

  -- 1) Match nos últimos 11 (mais específico)
  return query
    select * from public.crm_leads
    where regexp_replace(coalesce(phone,''), '\D', '', 'g') like '%' || tail11
    limit 2;
  if found then return; end if;

  -- 2) Últimos 10
  return query
    select * from public.crm_leads
    where regexp_replace(coalesce(phone,''), '\D', '', 'g') like '%' || tail10
    limit 2;
  if found then return; end if;

  -- 3) Últimos 9 — só retorna se for único (evita colisão silenciosa)
  select count(*) into cnt
    from public.crm_leads
    where regexp_replace(coalesce(phone,''), '\D', '', 'g') like '%' || tail9;
  if cnt = 1 then
    return query
      select * from public.crm_leads
      where regexp_replace(coalesce(phone,''), '\D', '', 'g') like '%' || tail9
      limit 1;
  end if;
end $$;


-- ── 5) Trigger de round-robin: atribui lead novo ao vendedor menos carregado
-- Roda BEFORE INSERT — só preenche assigned_to se vier null.
-- Estratégia: vendedor (role='vendedor') ATIVO com menor assigned_count;
-- empate resolve por created_at (mais antigo primeiro = mais justo).
create or replace function public.assign_lead_round_robin()
returns trigger language plpgsql security definer as $$
declare
  chosen_id uuid;
begin
  if new.assigned_to is not null then
    return new;
  end if;

  select id into chosen_id
    from public.crm_users
   where role = 'vendedor' and active = true
   order by assigned_count asc, created_at asc
   limit 1;

  if chosen_id is not null then
    new.assigned_to := chosen_id;
  end if;

  return new;
end $$;

drop trigger if exists trg_assign_lead_round_robin on public.crm_leads;
create trigger trg_assign_lead_round_robin
  before insert on public.crm_leads
  for each row execute function public.assign_lead_round_robin();


-- ── 6) Manutenção do assigned_count (incrementa/decrementa) ───────────
-- Roda AFTER INSERT/UPDATE/DELETE. "Carteira ativa" = leads que NÃO estão
-- em Convertido nem Perdido nem archived=true.
create or replace function public.bump_assigned_count()
returns trigger language plpgsql security definer as $$
declare
  was_active boolean := false;
  is_active  boolean := false;
begin
  -- Estado anterior
  if tg_op in ('UPDATE','DELETE') and old.assigned_to is not null then
    was_active := (
      coalesce(old.archived,false) = false
      and old.status not in ('Convertido','Perdido')
    );
  end if;

  -- Estado novo
  if tg_op in ('INSERT','UPDATE') and new.assigned_to is not null then
    is_active := (
      coalesce(new.archived,false) = false
      and new.status not in ('Convertido','Perdido')
    );
  end if;

  -- Decrementa antigo
  if tg_op in ('UPDATE','DELETE') and was_active and old.assigned_to is not null then
    if tg_op = 'DELETE' or new.assigned_to is distinct from old.assigned_to or not is_active then
      update public.crm_users
         set assigned_count = greatest(0, assigned_count - 1)
       where id = old.assigned_to;
    end if;
  end if;

  -- Incrementa novo
  if tg_op in ('INSERT','UPDATE') and is_active and new.assigned_to is not null then
    if tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to or not was_active then
      update public.crm_users
         set assigned_count = assigned_count + 1
       where id = new.assigned_to;
    end if;
  end if;

  return coalesce(new, old);
end $$;

drop trigger if exists trg_bump_assigned_count on public.crm_leads;
create trigger trg_bump_assigned_count
  after insert or update of assigned_to, status, archived or delete on public.crm_leads
  for each row execute function public.bump_assigned_count();


-- ── 7) Recalcular assigned_count uma vez (one-shot, idempotente) ──────
-- Após criar o trigger, ressincroniza com a realidade.
update public.crm_users u
   set assigned_count = coalesce(sub.cnt, 0)
  from (
    select assigned_to as uid, count(*)::int as cnt
      from public.crm_leads
     where assigned_to is not null
       and coalesce(archived,false) = false
       and status not in ('Convertido','Perdido')
     group by assigned_to
  ) sub
 where u.id = sub.uid
    or (u.assigned_count > 0 and not exists (
        select 1 from public.crm_leads l
        where l.assigned_to = u.id
          and coalesce(l.archived,false) = false
          and l.status not in ('Convertido','Perdido')
       ));


-- ── 8) View útil: leads quentes (score >= 65) por vendedor ────────────
-- Usada pelo Hoje/Pill "Quentes". Reaproveita RLS de crm_leads.
create or replace view public.v_crm_leads_hot as
  select *
    from public.crm_leads
   where coalesce(archived,false) = false
     and status not in ('Convertido','Perdido')
     and score >= 65;


-- ── 9) Atualiza updated_at quando algo muda (helper genérico) ─────────
-- Útil pra queries de "o que mudou desde X" em sync futuro.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- crm_leads já tem updated_at? Adiciona se faltar.
alter table public.crm_leads
  add column if not exists updated_at timestamptz not null default now();

drop trigger if exists trg_touch_crm_leads on public.crm_leads;
create trigger trg_touch_crm_leads
  before update on public.crm_leads
  for each row execute function public.touch_updated_at();


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICAÇÃO RÁPIDA — rode estas queries depois pra confirmar:
--
-- 1) Colunas novas:
--    select column_name from information_schema.columns
--     where table_name='crm_leads' and column_name in
--       ('score','chatwoot_conversation_id','last_inbound_at','last_outbound_at');
--
-- 2) Triggers ativos:
--    select tgname from pg_trigger
--     where tgrelid='public.crm_leads'::regclass and not tgisinternal;
--
-- 3) Assigned_count batendo com a realidade:
--    select u.email, u.assigned_count,
--           (select count(*) from crm_leads l
--             where l.assigned_to = u.id
--               and not coalesce(l.archived,false)
--               and l.status not in ('Convertido','Perdido')) as real_count
--      from crm_users u
--     where u.role = 'vendedor';
--
-- 4) RPC funciona:
--    select * from find_lead_by_phone_strict('5511987654321');
-- ═══════════════════════════════════════════════════════════════════════
