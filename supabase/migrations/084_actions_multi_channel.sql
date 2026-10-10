-- ============================================
-- 084: ações multi-canal
--
-- actions.channel era single-select. Nova coluna channels text[] para
-- múltiplos canais da mesma ação; `channel` continua (compat = 1º canal).
-- ============================================

ALTER TABLE public.actions
  ADD COLUMN IF NOT EXISTS channels text[] NOT NULL DEFAULT '{}';

-- Backfill: quem tinha canal único vira a lista com 1
UPDATE public.actions
SET channels = ARRAY[channel]
WHERE (channel IS NOT NULL AND channel <> '')
  AND channels = '{}';
