-- ============================================
-- 079: canais dinâmicos + descoberta por fornecedor
--
-- 1. prospecting_campaigns.discovery_provider: auto (Places→Firecrawl
--    fallback) | places | firecrawl — campanha escolhe a fonte de leads.
-- 2. Canais: 'voice' sai do seletor (não é canal — é modo de resposta do
--    agente); limpa valores existentes.
-- ============================================

ALTER TABLE public.prospecting_campaigns
  ADD COLUMN IF NOT EXISTS discovery_provider text NOT NULL DEFAULT 'auto'
    CHECK (discovery_provider IN ('auto','places','firecrawl'));

UPDATE public.prospecting_campaigns
SET channels = array_remove(channels, 'voice')
WHERE 'voice' = ANY (channels);
