-- ============================================
-- 075: IG-2 — gatilhos por campanha + assets de IA do ambiente
--
-- 1. trigger_keywords (text[]): palavras que ativa o agente quando o
--    prospect comenta ou manda DM com o termo (matching no ingest).
-- 2. environment_assets: provas sociais, portfólio, cases, FAQ e
--    scripts por ambiente, com arquivo opcional (bucket agent-assets)
--    e vínculo N:N com environment_products — insumo dos prompts do GLM.
-- ============================================

-- ---------- 1. Gatilhos por campanha ----------
ALTER TABLE public.prospecting_campaigns
  ADD COLUMN IF NOT EXISTS trigger_keywords text[] NOT NULL DEFAULT '{}';

-- ---------- 2. Assets de IA ----------
CREATE TABLE IF NOT EXISTS public.environment_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment public.environment_type NOT NULL,
  type text NOT NULL DEFAULT 'case'
    CHECK (type IN ('prova_social','portfolio','case','faq','script')),
  title text NOT NULL,
  content text NOT NULL,
  file_url text,
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS environment_assets_env_idx
  ON public.environment_assets (environment);

CREATE TABLE IF NOT EXISTS public.environment_asset_products (
  asset_id uuid NOT NULL REFERENCES public.environment_assets(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.environment_products(id) ON DELETE CASCADE,
  PRIMARY KEY (asset_id, product_id)
);
CREATE INDEX IF NOT EXISTS env_asset_products_product_idx
  ON public.environment_asset_products (product_id);

ALTER TABLE public.environment_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS env_assets_select ON public.environment_assets;
CREATE POLICY env_assets_select ON public.environment_assets
  FOR SELECT TO authenticated
  USING (is_env_staff((select auth.uid()), environment));

DROP POLICY IF EXISTS env_assets_insert ON public.environment_assets;
CREATE POLICY env_assets_insert ON public.environment_assets
  FOR INSERT TO authenticated
  WITH CHECK (is_env_admin((select auth.uid()), environment));

DROP POLICY IF EXISTS env_assets_update ON public.environment_assets;
CREATE POLICY env_assets_update ON public.environment_assets
  FOR UPDATE TO authenticated
  USING (is_env_admin((select auth.uid()), environment))
  WITH CHECK (is_env_admin((select auth.uid()), environment));

DROP POLICY IF EXISTS env_assets_delete ON public.environment_assets;
CREATE POLICY env_assets_delete ON public.environment_assets
  FOR DELETE TO authenticated
  USING (is_env_admin((select auth.uid()), environment));

-- vínculo segue o asset (staff pode criar vínculo só em asset visível)
ALTER TABLE public.environment_asset_products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS env_asset_products_all ON public.environment_asset_products;
CREATE POLICY env_asset_products_all ON public.environment_asset_products
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.environment_assets a
      WHERE a.id = asset_id AND is_env_staff((select auth.uid()), a.environment)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.environment_assets a
      WHERE a.id = asset_id AND is_env_admin((select auth.uid()), a.environment)
    )
  );

-- ---------- 3. Bucket de assets (links públicos para prospects) ----------
INSERT INTO storage.buckets (id, name, public)
VALUES ('agent-assets', 'agent-assets', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS agent_assets_read ON storage.objects;
CREATE POLICY agent_assets_read ON storage.objects
  FOR SELECT TO authenticated, anon
  USING (bucket_id = 'agent-assets');

DROP POLICY IF EXISTS agent_assets_write ON storage.objects;
CREATE POLICY agent_assets_write ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'agent-assets');
