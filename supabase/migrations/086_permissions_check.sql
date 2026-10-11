-- ============================================
-- 086: chk_permission atualizada — inclui crm e prospecting
-- (permissões do CRM 064 e da Prospecção IA 067 que a UI já envia)
-- ============================================

ALTER TABLE public.team_member_access
  DROP CONSTRAINT IF EXISTS chk_permission;
ALTER TABLE public.team_member_access
  ADD CONSTRAINT chk_permission
  CHECK (permission = ANY (ARRAY[
    'calendar'::text, 'campaigns'::text, 'editorial'::text, 'templates'::text,
    'history'::text, 'chat'::text, 'crm'::text, 'prospecting'::text,
    'clients'::text, 'integrations'::text, 'team'::text
  ]));
