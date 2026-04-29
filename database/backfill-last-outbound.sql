-- ═══════════════════════════════════════════════════════════════════════
-- BACKFILL: popular last_outbound_at retroativamente
--
-- Lê crm_activity por 'Template disparado' e copia a data pra
-- crm_leads.last_outbound_at — APENAS quando essa coluna ainda está NULL
-- (não sobrescreve dados reais que o webhook/bot já populou).
--
-- Idempotente. Pode rodar mais de uma vez sem efeito colateral.
--
-- Após rodar: leads em 'novo' com last_outbound_at populado vão aparecer
-- como 'aguardando' (< 24h) ou 'silencio' (> 24h) na view v_lead_signal.
-- Os Ghost ficam consistentes (stage_entered_at sincroniza com último disparo).
-- ═══════════════════════════════════════════════════════════════════════

-- ── 1) Backfill principal: usa último 'Template disparado' do log ────
-- Padrões aceitos: 'Template disparado', 'Disparado', 'IA disparou'.
with last_outbound as (
  select
    lead_id,
    max(created_at) as last_at
  from public.crm_activity
  where action ilike '%emplate disparado%'
     or action ilike '%isparou%'
     or action ilike '%disparado%'
  group by lead_id
)
update public.crm_leads l
   set last_outbound_at = lo.last_at,
       updated_at       = now()
  from last_outbound lo
 where l.id = lo.lead_id
   and l.last_outbound_at is null;


-- ── 2) Fallback para Ghost/Morto/Cliente/Abrindo sem activity ────────
-- Se chegou em status terminal mas não tem registro de disparo, usa
-- stage_entered_at (data em que entrou no estado atual). Garante que
-- esses leads tenham um timestamp coerente — se não tivessem disparo
-- algum, não estariam onde estão. Bem conservador.
update public.crm_leads
   set last_outbound_at = (stage_entered_at::date + time '12:00:00')::timestamptz,
       updated_at       = now()
 where last_outbound_at is null
   and status in ('ghost','morto','cliente','abrindo')
   and stage_entered_at is not null;


-- ── 3) Para Reunião / Atendimento sem dados, usa stage_entered_at ───
-- Estes claramente passaram por contato. Mesmo critério.
update public.crm_leads
   set last_outbound_at = (stage_entered_at::date + time '12:00:00')::timestamptz,
       updated_at       = now()
 where last_outbound_at is null
   and status in ('reuniao','atendimento')
   and stage_entered_at is not null;


-- ── 4) Backfill de last_inbound_at (mais conservador) ────────────────
-- Se existe atividade de qualificação pela IA com sucesso, presume
-- que houve resposta. Só onde categoria_ia já está preenchida.
with last_inbound as (
  select
    lead_id,
    max(created_at) as last_at
  from public.crm_activity
  where (action ilike '%qualifica%'
         or action ilike '%Resultado da reuni%'
         or action ilike '%respondeu%')
  group by lead_id
)
update public.crm_leads l
   set last_inbound_at = li.last_at,
       updated_at      = now()
  from last_inbound li
 where l.id = li.lead_id
   and l.last_inbound_at is null
   and l.categoria_ia is not null;


-- ═══════════════════════════════════════════════════════════════════════
-- VERIFICAÇÃO — rode depois pra ver o impacto:
--
--   select funnel_stage, count(*)
--     from v_lead_signal
--    group by funnel_stage
--    order by count desc;
--
-- Esperado: 'novo' diminui, 'silencio' e 'aguardando' aumentam.
-- 'morto'/'ghost'/'cliente'/'abrindo'/'reuniao'/'atendimento' permanecem.
--
-- Quanto foi populado:
--   select
--     count(*) filter (where last_outbound_at is not null) as com_outbound,
--     count(*) filter (where last_inbound_at is not null) as com_inbound,
--     count(*) as total
--   from crm_leads;
-- ═══════════════════════════════════════════════════════════════════════
