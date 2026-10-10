-- ============================================
-- 083: FKs de produto migradas para o catálogo do ambiente
--
-- actions.product_id e action_products.product_id apontavam para a tabela
-- antiga `products` (legada). O catálogo real desde 065 é environment_products.
-- Consequências do legado:
--   - salvar ação com produto do catálogo novo → erro FK
--     'actions_product_id_fkey'
-- Migration:
--   1. Re-mapeia action_products restantes (products→environment_products)
--      por NOME dentre do ambiente; sem match → descarta linha (log).
--   2. Reponta actions.product_id para o 1º produto do vínculo (ou NULL).
--   3. FKs novas com ON DELETE compatível.
-- ============================================

-- ---------- 1. Re-mapeia action_products ----------
UPDATE public.action_products ap
SET product_id = m.ep_id
FROM (
  SELECT ap.action_id AS ap_action, ap.product_id AS ap_legado, ep.id AS ep_id
  FROM public.action_products ap
  JOIN public.products p ON p.id = ap.product_id
  JOIN public.actions a ON a.id = ap.action_id
  JOIN public.environment_products ep
    ON lower(ep.name) = lower(p.name)
    AND ep.environment = a.environment::environment_type
) m
WHERE ap.action_id = m.ap_action
  AND ap.product_id = m.ap_legado;

DELETE FROM public.action_products ap
USING public.products p
WHERE ap.product_id = p.id
  AND NOT EXISTS (SELECT 1 FROM public.environment_products ep WHERE ep.id = ap.product_id);

-- ---------- 2. actions.product_id = 1º vínculo do catálogo ----------
UPDATE public.actions a
SET product_id = (
  SELECT sab.product_id FROM action_products sab
  JOIN public.environment_products ep ON ep.id = sab.product_id
  WHERE sab.action_id = a.id
  LIMIT 1
)
WHERE a.product_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.environment_products ep WHERE ep.id = a.product_id);

UPDATE public.actions
SET product_id = NULL
WHERE product_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.environment_products ep WHERE ep.id = product_id);

-- ---------- 3. FKs novas → environment_products ----------
ALTER TABLE public.action_products
  DROP CONSTRAINT IF EXISTS action_products_product_id_fkey;
ALTER TABLE public.action_products
  ADD CONSTRAINT action_products_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES public.environment_products(id) ON DELETE CASCADE;

ALTER TABLE public.actions
  DROP CONSTRAINT IF EXISTS actions_product_id_fkey;
ALTER TABLE public.actions
  ADD CONSTRAINT actions_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES public.environment_products(id) ON DELETE SET NULL;
