-- ============================================
-- 078: disparo em massa + oferta + reforço de marcos
--
-- 1. prospecting_jobs: novo tipo mass_dispatch (coordinator do disparo).
-- 2. prospecting_campaigns.offer: oferta/desconto que o agente cita.
-- 3. calendar_marcos: novo kind 'reuniao_lead' (agendamento real),
--    idempotência do marco automático (UNIQUE lead_id+kind) e
--    realtime publication (o listener do bite nunca disparava).
-- 4. Índice p/ reaquecimento (follow-up por last_contact_at).
-- ============================================

-- ─── 1. mass_dispatch ───
ALTER TABLE public.prospecting_jobs
  DROP CONSTRAINT IF EXISTS prospecting_jobs_type_check;
ALTER TABLE public.prospecting_jobs
  ADD CONSTRAINT prospecting_jobs_type_check
  CHECK (type = ANY (ARRAY[
    'discover_companies'::text, 'enrich_company'::text,
    'analyze_company'::text, 'score_company'::text,
    'generate_message'::text, 'send_message'::text, 'follow_up'::text,
    'mass_dispatch'::text
  ]));

-- ─── 2. Oferta da campanha ───
ALTER TABLE public.prospecting_campaigns
  ADD COLUMN IF NOT EXISTS offer text;

-- ─── 3. Marcos: reuniao_lead + idempotência + realtime ───
ALTER TABLE public.calendar_marcos
  DROP CONSTRAINT IF EXISTS calendar_marcos_kind_check;
ALTER TABLE public.calendar_marcos
  ADD CONSTRAINT calendar_marcos_kind_check
  CHECK (kind = ANY (ARRAY['lead_cadastrado'::text, 'reuniao_parceiro'::text, 'acao_parceiro'::text, 'reuniao_lead'::text]));

CREATE UNIQUE INDEX IF NOT EXISTS uq_calendar_marcos_lead_kind
  ON public.calendar_marcos (lead_id, kind)
  WHERE lead_id IS NOT NULL;

-- Trigger automático passa a ser idempotente (respeita o unique index)
CREATE OR REPLACE FUNCTION public.create_lead_milestone()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.calendar_marcos
    (environment, kind, title, description, event_date, lead_id, status, created_by)
  VALUES
    (NEW.environment, 'lead_cadastrado',
     '🎯 Lead novo: ' || NEW.name,
     'Lead ' || COALESCE(NEW.origin, 'manual') || ' criado no CRM.',
     NEW.created_at::date,
     NEW.id, 'planned', NULL)
  ON CONFLICT (lead_id, kind) DO NOTHING;
  RETURN NEW;
END;
$$;

DO $pub$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'calendar_marcos'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.calendar_marcos;
  END IF;
END
$pub$;

-- ─── 4. Índice do reaquecimento ───
CREATE INDEX IF NOT EXISTS idx_crm_leads_followup
  ON public.crm_leads (environment, prospecting_status, last_contact_at)
  WHERE prospecting_status IN ('contacted', 'replied');
