-- ============================================
-- 087: LGPD opt-out — suppression de outreach por lead
-- Lead diz "SAIR/REMOVER/PARE/DESCADASTRAR/STOP" → suppress_outreach=true:
--   sem disparo em massa, sem cold send, sem follow-up (conversa segue
--   permitida — o lead pode reengajar; staff reseta ao aprovar manualmente).
-- ============================================

ALTER TABLE public.crm_leads
  ADD COLUMN IF NOT EXISTS suppress_outreach boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_crm_leads_suppressed
  ON public.crm_leads (environment)
  WHERE suppress_outreach;
