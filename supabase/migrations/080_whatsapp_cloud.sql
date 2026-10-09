-- ============================================
-- 080: WhatsApp Cloud API (oficial Meta) por ambiente
--
-- 1 conexão por ambiente (padrão instagram_connections/074):
--   - camadas: RLS (só admin do ambiente gerencia; staff lê metadados)
--   - access_tokenanon: NUNCA sai pelo REST para authenticated
-- Envio: worker (sendViaCloud) lê pelo service role; recepção:
-- webhook Meta (mesma URL do Instagram) → ingest → cérebro da conversa.
-- ============================================

CREATE TABLE IF NOT EXISTS public.whatsapp_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment public.environment_type NOT NULL,
  waba_id text,
  phone_number_id text NOT NULL,
  display_phone text,
  access_token text NOT NULL,
  -- template p/ iniciar conversa fora da janela (só pode: template Meta aprovado)
  cold_template text,
  cold_template_lang text NOT NULL DEFAULT 'pt_BR',
  status text NOT NULL DEFAULT 'connected'
    CHECK (status IN ('connected', 'disconnected')),
  connected_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_conn_env
  ON public.whatsapp_connections (environment)
  WHERE status = 'connected';
CREATE INDEX IF NOT EXISTS whatsapp_conn_env_idx
  ON public.whatsapp_connections (environment);

ALTER TABLE public.whatsapp_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_conn_select ON public.whatsapp_connections;
CREATE POLICY whatsapp_conn_select ON public.whatsapp_connections
  FOR SELECT TO authenticated
  USING (is_env_staff((select auth.uid()), environment));

DROP POLICY IF EXISTS whatsapp_conn_write ON public.whatsapp_connections;
CREATE POLICY whatsapp_conn_write ON public.whatsapp_connections
  FOR INSERT TO authenticated
  WITH CHECK (is_env_admin((select auth.uid()), environment));

DROP POLICY IF EXISTS whatsapp_conn_update ON public.whatsapp_connections;
CREATE POLICY whatsapp_conn_update ON public.whatsapp_connections
  FOR UPDATE TO authenticated
  USING (is_env_admin((select auth.uid()), environment))
  WITH CHECK (is_env_admin((select auth.uid()), environment));

DROP POLICY IF EXISTS whatsapp_conn_delete ON public.whatsapp_connections;
CREATE POLICY whatsapp_conn_delete ON public.whatsapp_connections
  FOR DELETE TO authenticated
  USING (is_env_admin((select auth.uid()), environment));

-- Token inacessível via REST para authenticated (igual instagram_connections)
REVOKE ALL ON public.whatsapp_connections FROM authenticated;
GRANT SELECT (id, environment, waba_id, phone_number_id, display_phone, cold_template, cold_template_lang, status, connected_by, created_at, updated_at)
  ON public.whatsapp_connections TO authenticated;
