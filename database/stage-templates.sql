-- Mapeamento "etapa do funil → template do Chatwoot"
-- Rode este SQL uma vez no SQL Editor do Supabase

create table if not exists crm_stage_templates (
  id bigserial primary key,
  stage text not null unique,           -- 'Lead Novo', 'IA Disparou', 'Qualificado', ...
  template_name text not null,          -- nome aprovado do template no Meta (ex: contato_grupo_seleto)
  template_body text,                   -- corpo exato do template aprovado
  language text not null default 'pt_BR',
  category text not null default 'MARKETING',
  enabled boolean not null default true,
  auto_trigger boolean not null default false,  -- futuro: dispara sem pedir confirmação
  updated_at timestamptz not null default now()
);

create index if not exists idx_crm_stage_templates_enabled on crm_stage_templates(enabled);

alter table crm_stage_templates enable row level security;

-- Política aberta (o acesso real é controlado pela service_role do backend proxy)
drop policy if exists "allow_all" on crm_stage_templates;
create policy "allow_all" on crm_stage_templates for all using (true) with check (true);
