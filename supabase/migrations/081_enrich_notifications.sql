-- ============================================
-- 081: notificação de escalonamento + suporte ao enriquecimento
-- ============================================

ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'lead_escalated';

-- Enriquecimento não pode rodar infinito: 1 enrich por lead (dedupe própria
-- do jobs já controla por (campaign,type,key); aqui evita loop de análise)
CREATE INDEX IF NOT EXISTS prospecting_jobs_ledtype_idx
  ON public.prospecting_jobs (lead_id, type, status);
