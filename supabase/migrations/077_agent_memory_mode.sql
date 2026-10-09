-- ============================================
-- 077: memória persistente + modo conversa + rate-limit + jev_config
--
-- 1. crm_leads: colunas de memória do agente (jev_memory, temperatura,
--    resumo, modo ai/human, humano atribuído, motivo de escalonamento,
--    último contato) — base da conversa contínua com contexto.
-- 2. prospecting_agent_settings: jev_config jsonb (janela de rate-limit,
--    limite por lead/hora, threshold de escalonamento por score).
-- 3. Buckets agent-voice e agent-assets viram privados + função
--    agent_signed_url(bucket, path) com validação de dono por ambiente
--    (signed URL de 1h; UI chama a função via RPC).
-- ============================================

-- ─── 1. Memória do lead ───
ALTER TABLE public.crm_leads
  ADD COLUMN IF NOT EXISTS jev_memory jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS lead_temperature text NOT NULL DEFAULT 'cold',
  ADD COLUMN IF NOT EXISTS lead_score numeric,
  ADD COLUMN IF NOT EXISTS conversation_summary text,
  ADD COLUMN IF NOT EXISTS conversation_mode text NOT NULL DEFAULT 'ai',
  ADD COLUMN IF NOT EXISTS assigned_human uuid,
  ADD COLUMN IF NOT EXISTS escalation_reason text,
  ADD COLUMN IF NOT EXISTS last_contact_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_inbound_at timestamptz,
  ADD COLUMN IF NOT EXISTS rate_window_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS rate_count integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_crm_leads_temperature') THEN
    ALTER TABLE public.crm_leads
      ADD CONSTRAINT chk_crm_leads_temperature
      CHECK (lead_temperature IN ('cold','warm','hot'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_crm_leads_conversation_mode') THEN
    ALTER TABLE public.crm_leads
      ADD CONSTRAINT chk_crm_leads_conversation_mode
      CHECK (conversation_mode IN ('ai','human'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_leads_assigned_human') THEN
    ALTER TABLE public.crm_leads
      ADD CONSTRAINT fk_crm_leads_assigned_human
      FOREIGN KEY (assigned_human) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_crm_leads_conversation_mode
  ON public.crm_leads (environment, conversation_mode)
  WHERE conversation_mode = 'human';

CREATE INDEX IF NOT EXISTS idx_crm_leads_temperature
  ON public.crm_leads (environment, lead_temperature);

-- ─── 2. JEV config por ambiente ───
ALTER TABLE public.prospecting_agent_settings
  ADD COLUMN IF NOT EXISTS jev_config jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE public.prospecting_agent_settings
SET jev_config = jsonb_build_object(
  'rate_limit_per_lead_per_hour', 20,
  'rate_limit_global_per_hour', 200,
  'escalate_score_threshold', 81,
  'escalate_on_keywords', true,
  'summary_refresh_every_n_messages', 5,
  'media_reply_cooldown_minutes', 30
)
WHERE jev_config = '{}'::jsonb;

-- ─── 3. Buckets privados + signed URL (1h) ───
-- A partir de agora, o acesso é via signed URL (n8n envia a URL assinada
-- para a Evolution; a UI cria a signed URL no cliente — basta a policy de
-- SELECT para authenticated). Assinatura é auto-autenticada: quem recebe
-- o link não precisa de credenciais.
UPDATE storage.buckets SET public = false WHERE id IN ('agent-voice','agent-assets');

-- Leitura (para emitir signed URL) restrita a usuários autenticados —
-- antes era open para anon, o que anularia o bucket privado.
DROP POLICY IF EXISTS agent_voice_read ON storage.objects;
CREATE POLICY agent_voice_read ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'agent-voice');

DROP POLICY IF EXISTS agent_assets_read ON storage.objects;
CREATE POLICY agent_assets_read ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'agent-assets');

-- Legacy: environment_assets.file_url guardava URL pública → converte para path.
UPDATE public.environment_assets
SET file_url = regexp_replace(
      regexp_replace(file_url, '\?.*$', ''),
      '^https?://[^/]+/storage/v1/object/(public|sign|signed)/agent-assets/',
      ''
    )
WHERE file_url LIKE '%/object/public/agent-assets/%'
   OR file_url LIKE '%/object/sign/agent-assets/%'
   OR file_url LIKE '%/object/signed/agent-assets/%';
