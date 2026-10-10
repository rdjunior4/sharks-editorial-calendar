-- ============================================
-- 082: higiene de datas estratégicas
--
-- Cada workspace guarda a SUA cópia das datas nacionais (wizard),
-- mas nunca pode haver 2 linhas do MESMO título no MESMO dia do
-- MESMO workspace — índice único impede qualquer futuro re-duplicado.
-- (Hoje: 18 cópias = 1 por workspace, nenhuma intra-workspace.)
-- ============================================

-- Duplicatas reais encontradas (ex.: 'Aniversário de João Pessoa' ×2 no mesmo
-- workspace) → mantém a mais antiga e descarta as demais (mesma ws+title+date)
DELETE FROM public.strategic_dates a USING public.strategic_dates b
WHERE a.workspace_id IS NOT DISTINCT FROM b.workspace_id
  AND a.title = b.title
  AND a.date = b.date
  AND a.id <> b.id
  AND (a.created_at, a.id) > (b.created_at, b.id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_strategic_dates_ws_title_date
  ON public.strategic_dates (COALESCE(workspace_id::text, ''), title, date);
