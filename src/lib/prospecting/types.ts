/* ─── Prospecção IA — domínio (migration 067) ───
   Jobs (tipos/estados) e abstrações de IA ficam documentados na
   própria migration e em docs/ARQUITETURA.md — entram no código na F2. */

export type ProspectingEnvironment = 'sharks_company' | 'estrategos';

export type CampaignStatus = 'draft' | 'running' | 'paused' | 'completed' | 'failed';
export const CAMPAIGN_STATUS_META: Record<CampaignStatus, { label: string; badgeClass: string }> = {
  draft:     { label: 'Rascunho',    badgeClass: 'bg-gray-100 text-gray-600' },
  running:   { label: 'Em execução', badgeClass: 'bg-emerald-100 text-emerald-700' },
  paused:    { label: 'Pausada',     badgeClass: 'bg-amber-100 text-amber-700' },
  completed: { label: 'Concluída',   badgeClass: 'bg-sky-100 text-sky-700' },
  failed:    { label: 'Falhou',      badgeClass: 'bg-red-100 text-red-600' },
};

/* Estado de prospecção — separado do estágio comercial (crm_leads.stage) */
export type ProspectingStatus =
  | 'discovered'
  | 'researching'
  | 'qualified'
  | 'discarded'
  | 'queued'
  | 'contacted'
  | 'replied'
  | 'interested'
  | 'converted_to_pipeline';

/* ─── Jobs do Prospecting Engine (migration 067) ─── */
export type JobType =
  | 'discover_companies'
  | 'enrich_company'
  | 'analyze_company'
  | 'score_company'
  | 'generate_message'
  | 'send_message'
  | 'follow_up';
export const JOB_TYPE_META: Record<JobType, { label: string }> = {
  discover_companies: { label: 'Descobrir empresas' },
  enrich_company:     { label: 'Enriquecer empresa' },
  analyze_company:    { label: 'Analisar empresa' },
  score_company:      { label: 'Pontuar empresa' },
  generate_message:   { label: 'Gerar mensagem' },
  send_message:       { label: 'Enviar mensagem' },
  follow_up:          { label: 'Follow-up' },
};

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'retry';
export const JOB_STATUS_META: Record<JobStatus, { label: string; badgeClass: string }> = {
  pending:    { label: 'Pendente',     badgeClass: 'bg-gray-100 text-gray-600' },
  processing: { label: 'Processando',  badgeClass: 'bg-sky-100 text-sky-700' },
  completed:  { label: 'Concluído',    badgeClass: 'bg-emerald-100 text-emerald-700' },
  failed:     { label: 'Falhou',       badgeClass: 'bg-red-100 text-red-600' },
  retry:      { label: 'Reagendado',   badgeClass: 'bg-amber-100 text-amber-700' },
};

export interface ProspectingJob {
  id: string;
  campaign_id: string;
  lead_id: string | null;
  type: JobType;
  status: JobStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  dedupe_key: string | null;
  scheduled_at: string;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  campaign?: { id: string; name: string } | null;
}

export const PROSPECTING_CHANNELS = ['whatsapp', 'instagram', 'email'] as const;
export const CHANNEL_META: Record<ProspectingChannel, { label: string; hint: string }> = {
  whatsapp:  { label: 'WhatsApp',  hint: 'Via Evolution — precisa de telefone no lead' },
  instagram: { label: 'Instagram', hint: 'DM oficial — lead precisa ter interagido (janela 24h)' },
  email:     { label: 'E-mail',    hint: 'Via Resend — precisa de e-mail no lead' },
};
export type ProspectingChannel = typeof PROSPECTING_CHANNELS[number];

export type DiscoveryProvider = 'auto' | 'places' | 'firecrawl';
export const DISCOVERY_PROVIDERS: DiscoveryProvider[] = ['auto', 'places', 'firecrawl'];
export const DISCOVERY_META: Record<DiscoveryProvider, { label: string; hint: string }> = {
  auto:      { label: 'Auto',       hint: 'Google Places primeiro; cai para Firecrawl se falhar' },
  places:    { label: 'Google Places', hint: 'Billing do Google — mais direto' },
  firecrawl: { label: 'Firecrawl',  hint: 'Busca na web + leitura dos sites — sem Places' },
};

export const AUTOMATION_LEVELS = ['assisted', 'semi_auto', 'auto'] as const;
export type AutomationLevel = typeof AUTOMATION_LEVELS[number];
export const AUTOMATION_META: Record<AutomationLevel, { label: string }> = {
  assisted:  { label: 'Assistido' },
  semi_auto: { label: 'Semi-automático' },
  auto:      { label: 'Automático' },
};

export const COMPANY_SIZES = ['Micro', 'Pequeno', 'Médio', 'Grande'] as const;

export interface ProspectingCampaign {
  id: string;
  environment: ProspectingEnvironment;
  name: string;
  objective: string | null;
  offer: string | null;
  segment: string | null;
  location: string | null;
  company_size: string | null;
 icp_description: string | null;
  trigger_keywords: string[] | null;
  target_count: number;
  channels: string[];
  discovery_provider: DiscoveryProvider;
  automation_level: AutomationLevel;
  status: CampaignStatus;
  created_by: string | null;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
  products: Array<{ product: { id: string; name: string } }> | null;
  assigned_to_user?: { id: string; full_name: string; avatar_url: string | null } | null;
}

export interface CampaignPayload {
  name: string;
  objective: string | null;
  offer: string | null;
  segment: string | null;
  location: string | null;
  company_size: string | null;
  icp_description: string | null;
  trigger_keywords?: string[];
  target_count: number;
  channels: string[];
  discovery_provider: DiscoveryProvider;
  automation_level: AutomationLevel;
  assigned_to: string | null;
  product_ids?: string[];
  status?: CampaignStatus;
}
