-- ============================================
-- 076: Parceiros (cadastro conectado à agenda) + Marcos do calendário
--
-- 1. partners: cadastro do ambiente, no padrão do catálogo de produtos.
-- 2. calendar_marcos: eventos que aparecem no calendário da agenda
--    (lead_cadastrado automático · reunião/ação com parceiro).
-- 3. Trigger em crm_leads INSERT: gera marco "Lead novo" para TODO lead
--    (manual, descoberto pelo agente, inbound) no dia do cadastro.
-- ============================================

-- ---------- 1. Parceiros ----------
CREATE TABLE IF NOT EXISTS public.partners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment public.environment_type NOT NULL,
  name text NOT NULL,
  contact_name text,
  contact_email text,
  contact_phone text,
  social_instagram text,
  notes text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','inactive')),
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS partners_env_idx ON public.partners (environment);

ALTER TABLE public.partners ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partners_select ON public.partners;
CREATE POLICY partners_select ON public.partners
  FOR SELECT TO authenticated
  USING (is_env_staff((select auth.uid()), environment));

DROP POLICY IF EXISTS partners_write ON public.partners;
CREATE POLICY partners_write ON public.partners
  FOR INSERT TO authenticated
  WITH CHECK (is_env_admin((select auth.uid()), environment));

DROP POLICY IF EXISTS partners_update ON public.partners;
CREATE POLICY partners_update ON public.partners
  FOR UPDATE TO authenticated
  USING (is_env_admin((select auth.uid()), environment))
  WITH CHECK (is_env_admin((select auth.uid()), environment));

DROP POLICY IF EXISTS partners_delete ON public.partners;
CREATE POLICY partners_delete ON public.partners
  FOR DELETE TO authenticated
  USING (is_env_admin((select auth.uid()), environment));

-- ---------- 2. Marcos do calendário ----------
CREATE TABLE IF NOT EXISTS public.calendar_marcos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment public.environment_type NOT NULL,
  kind text NOT NULL
    CHECK (kind IN ('lead_cadastrado','reuniao_parceiro','acao_parceiro')),
  title text NOT NULL,
  description text,
  event_date date NOT NULL,
  event_time time,
  partner_id uuid REFERENCES public.partners(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES public.crm_leads(id) ON DELETE CASCADE,
  responsible_id uuid REFERENCES public.users(id),
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned','done','canceled')),
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS calendar_marcos_env_date_idx
  ON public.calendar_marcos (environment, event_date);
CREATE INDEX IF NOT EXISTS calendar_marcos_partner_idx
  ON public.calendar_marcos (partner_id);
CREATE INDEX IF NOT EXISTS calendar_marcos_lead_idx
  ON public.calendar_marcos (lead_id);

ALTER TABLE public.calendar_marcos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS marcos_select ON public.calendar_marcos;
CREATE POLICY marcos_select ON public.calendar_marcos
  FOR SELECT TO authenticated
  USING (is_env_staff((select auth.uid()), environment));

DROP POLICY IF EXISTS marcos_write ON public.calendar_marcos;
CREATE POLICY marcos_write ON public.calendar_marcos
  FOR INSERT TO authenticated
  WITH CHECK (is_env_staff((select auth.uid()), environment));

DROP POLICY IF EXISTS marcos_update ON public.calendar_marcos;
CREATE POLICY marcos_update ON public.calendar_marcos
  FOR UPDATE TO authenticated
  USING (is_env_staff((select auth.uid()), environment))
  WITH CHECK (is_env_staff((select auth.uid()), environment));

DROP POLICY IF EXISTS marcos_delete ON public.calendar_marcos;
CREATE POLICY marcos_delete ON public.calendar_marcos
  FOR DELETE TO authenticated
  USING (is_env_admin((select auth.uid()), environment));

-- ---------- 3. Marco automático para todo lead novo ----------
CREATE OR REPLACE FUNCTION public.create_lead_milestone()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.calendar_marcos (environment, kind, title, event_date, lead_id, created_by)
  VALUES (
    NEW.environment,
    'lead_cadastrado',
    '🎯 Lead novo: ' || NEW.name,
    COALESCE(NEW.created_at::date, CURRENT_DATE),
    NEW.id,
    NEW.owner_id
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_create_lead_milestone ON public.crm_leads;
CREATE TRIGGER trg_create_lead_milestone
  AFTER INSERT ON public.crm_leads
  FOR EACH ROW
  EXECUTE FUNCTION public.create_lead_milestone();
