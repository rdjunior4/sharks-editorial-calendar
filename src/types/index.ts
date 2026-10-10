// ==========================================
// SHARKS EDITORIAL CALENDAR - TYPE DEFINITIONS
// ==========================================

// User & Auth
export type UserRole = 'oracullo_admin' | 'admin_sharks' | 'sharks_team' | 'client';

// Multi-ambiente (migration 023)
export type EnvironmentType = 'sharks_company' | 'estrategos';
export type EnvironmentRole = 'admin' | 'team' | 'client';

export interface UserEnvironment {
  user_id: string;
  environment: EnvironmentType;
  role: EnvironmentRole;
  created_at: string;
  updated_at: string;
}

export const ENVIRONMENT_META: Record<EnvironmentType, { label: string; short: string; color: string; emoji: string; home: string }> = {
  sharks_company: { label: 'Sharks Company', short: 'Sharks', color: 'blue', emoji: '🦈', home: '/sharks' },
  estrategos: { label: 'Estrategos', short: 'Estrategos', color: 'green', emoji: '📊', home: '/estrategos' },
};

export interface User {
  id: string;
  email: string;
  full_name: string;
  avatar_url: string | null;
  role: UserRole;
  created_at: string;
  updated_at: string;
  environments?: UserEnvironment[];
}

// Workspace
export interface Workspace {
  id: string;
  organization_id: string;
  name: string;
  slug: string;
  logo_url: string | null;
  segment: string | null;
  city: string | null;
  state: string | null;
  country: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  /** Ambiente da organizacao (join organizations.environment). */
  environment?: EnvironmentType;
}

// Membership
export type MembershipRole = 'owner' | 'member' | 'viewer';

export interface Membership {
  id: string;
  user_id: string;
  workspace_id: string;
  role: MembershipRole;
  created_at: string;
}

// Editorial
export type ActionStatus = 'draft' | 'briefing' | 'in_production' | 'sharks_review' | 'scheduled' | 'published' | 'completed' | 'cancelled' | 'overdue';

export type ActionType = 'content' | 'campaign' | 'production' | 'recording' | 'photo_session' | 'approval' | 'publication' | 'ad' | 'crm' | 'whatsapp' | 'email' | 'event' | 'meeting' | 'strategic_date' | 'commercial' | 'other' | 'implementation' | 'milestone' | 'onboarding' | 'review' | 'follow_up' | 'strategy' | 'training';

export type ContentFormat = 'reels' | 'story' | 'story_sequence' | 'carousel' | 'static_post' | 'photo' | 'video' | 'animation' | 'live' | 'whatsapp' | 'whatsapp_status' | 'email_marketing' | 'newsletter' | 'landing_page' | 'blog' | 'youtube' | 'ad' | 'commercial_material' | 'other';

export type FormatFrequencyZone = 'feed' | 'story' | 'reels';
export type FormatFrequency = Partial<Record<FormatFrequencyZone, number>>;

export type Objective = 'brand_awareness' | 'positioning' | 'authority' | 'educational' | 'engagement' | 'relationship' | 'traffic' | 'lead_conversion' | 'sale_conversion' | 'social_proof' | 'launch' | 'loyalty' | 'repurchase' | 'retention' | 'reactivation';

export type FunnelStage = 'discovery' | 'interest' | 'consideration' | 'conversion' | 'relationship' | 'repurchase';

export interface EditorialProfile {
  id: string;
  workspace_id: string;
  frequency_per_week: number;
  allowed_days: number[];
  preferred_times: string[];
  priority_formats: ContentFormat[];
  distribution: Record<string, number>;
  priority_objectives: Objective[];
  priority_products: string[];
  format_frequency: FormatFrequency;
  target_audience: string | null;
  restrictions: string | null;
  max_weekly: number;
  created_at: string;
  updated_at: string;
}

export interface EditorialPillar {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  color: string;
  percentage: number;
  sort_order: number;
  is_active: boolean;
  created_at: string;
}

// Campaign
export type CampaignStatus = 'active' | 'paused' | 'completed' | 'draft';

export interface Campaign {
  id: string;
  workspace_id: string;
  name: string;
  objective: string | null;
  start_date: string | null;
  end_date: string | null;
  description: string | null;
  audience: string | null;
  product: string | null;
  priority: string;
  status: CampaignStatus;
  color: string | null;
  created_at: string;
  updated_at: string;
}

// Channel
export interface Channel {
  id: string;
  workspace_id: string;
  name: string;
  icon: string | null;
  is_active: boolean;
  created_at: string;
}

// Action
export type SyncStatus = 'not_synced' | 'synced' | 'modified_after_sync' | 'sync_error';

export interface Action {
  id: string;
  workspace_id: string;
  campaign_id: string | null;
  editorial_pillar_id: string | null;
  responsible_id: string | null;
  title: string;
  description: string | null;
  action_date: string;
  action_time: string | null;
  action_type: ActionType;
  format: ContentFormat | null;
  channel: string | null;
  /** Múltiplos canais da ação (084) — channel fica com o 1º (compat) */
  channels?: string[];
  objective: Objective | null;
  funnel_stage: FunnelStage | null;
  audience: string | null;
  product: string | null;
  theme: string | null;
  hook: string | null;
  main_message: string | null;
  copy_text: string | null;
  cta: string | null;
  internal_deadline: string | null;
  status: ActionStatus;
  observations: string | null;
  reference_urls: string[];
  sync_status: SyncStatus;
  is_auto_generated: boolean;
  environment: EnvironmentType;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Joined data
  campaign?: Campaign;
  editorial_pillar?: EditorialPillar;
  responsible?: User;
  workspace?: Workspace;
  /** Todos os responsáveis (N:N) — responsible_id é o principal (1º) */
  responsibles?: User[];
  product_id?: string | null;
  product_ref?: { id: string; name: string; image_url?: string | null } | null;
  /** Produtos vinculados (N:N) — product_id/product_ref ficam com o 1º (compat) */
  products?: Array<{ id: string; name: string; image_url?: string | null }>;
}

// Template
export interface CalendarTemplate {
  id: string;
  organization_id: string;
  name: string;
  segment: string | null;
  num_contents: number;
  allowed_days: number[];
  formats: ContentFormat[];
  objectives: Objective[];
  pillar_distribution: Record<string, number>;
  distribution: Record<string, number>;
  rules: Record<string, unknown>;
  description: string | null;
  created_at: string;
}

// Strategic Date
export type DateRelevance = 'high' | 'medium' | 'low';

export interface StrategicDate {
  id: string;
  workspace_id: string;
  title: string;
  date: string;
  start_date: string | null;
  end_date: string | null;
  locality: string | null;
  category: string | null;
  relevance: DateRelevance;
  description: string | null;
  is_recurring: boolean;
  created_at: string;
}

// Chat
export type MessageType = 'message' | 'doubt' | 'suggestion';
export type MessageStatus = 'sent' | 'read';

export interface ChatThread {
  id: string;
  workspace_id: string;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  thread_id: string;
  sender_id: string;
  content: string;
  message_type: MessageType;
  action_id: string | null;
  created_at: string;
  status: MessageStatus;
  sender?: User;
  action?: Action;
}

// Attachment
export interface Attachment {
  id: string;
  action_id: string;
  file_url: string;
  file_name: string;
  file_type: string | null;
  uploaded_by: string | null;
  created_at: string;
}

// Google Calendar
export interface CalendarIntegration {
  id: string;
  workspace_id: string;
  google_calendar_id: string | null;
  google_calendar_name: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  is_connected: boolean;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
  sync_mode?: 'unified' | 'split';
  env_calendar_ids?: Record<string, string> | null;
  env_auto_sync?: Record<string, boolean> | null;
}

// Multi-ambiente sync (migration 025)
export type SyncMode = 'unified' | 'split';
export type QueueSource = 'sharks_action' | 'estrategos_meeting' | 'estrategos_implementation';

// Estrategos (migration 024)
export type EstrategosProjectStatus = 'planning' | 'active' | 'paused' | 'completed' | 'cancelled';
export type EstrategosMeetingStatus = 'scheduled' | 'completed' | 'cancelled';
export type EstrategosImplementationStatus = 'pending' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';

export interface EstrategosProject {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  status: EstrategosProjectStatus;
  start_date: string | null;
  end_date: string | null;
  responsible_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface EstrategosMeeting {
  id: string;
  workspace_id: string;
  project_id: string | null;
  title: string;
  description: string | null;
  meeting_date: string;
  meeting_time: string | null;
  duration_minutes: number;
  location: string | null;
  attendees: string[];
  status: EstrategosMeetingStatus;
  sync_status: SyncStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface EstrategosImplementation {
  id: string;
  workspace_id: string;
  project_id: string | null;
  name: string;
  description: string | null;
  system_name: string | null;
  status: EstrategosImplementationStatus;
  target_date: string | null;
  completed_at: string | null;
  sync_status: SyncStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CalendarEventLink {
  id: string;
  action_id: string;
  workspace_id: string;
  google_event_id: string | null;
  last_synced_at: string | null;
  sync_status: SyncStatus;
  created_at: string;
}

// Audit Log
export interface AuditLog {
  id: string;
  workspace_id: string;
  user_id: string | null;
  entity_type: string;
  entity_id: string;
  action: string;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  created_at: string;
}

// Notification
export type NotificationType =
  | 'message'
  | 'suggestion'
  | 'calendar_generated'
  | 'action_upcoming'
  | 'action_overdue'
  | 'campaign_starting'
  | 'sync_error'
  | 'calendar_undefined'
  | 'action_assigned'
  | 'action_status_changed'
  | 'access_request';

export interface Notification {
  id: string;
  user_id: string;
  workspace_id: string | null;
  title: string;
  message: string | null;
  type: NotificationType;
  is_read: boolean;
  action_id: string | null;
  created_at: string;
}

// Calendar View Types
export type CalendarViewType = 'month' | 'week' | 'day' | 'agenda' | 'list';

// Filters
export interface ActionFilters {
  workspaceId?: string;
  campaignId?: string;
  format?: ContentFormat;
  objective?: Objective;
  pillarId?: string;
  status?: ActionStatus;
  responsibleId?: string;
  channel?: string;
  actionType?: ActionType;
  startDate?: string;
  endDate?: string;
  environment?: EnvironmentType;
}

// Week Generator
export interface GeneratedAction {
  title: string;
  description: string;
  action_date: string;
  action_time: string;
  action_type: ActionType;
  format: ContentFormat;
  channel: string;
  editorial_pillar_id: string;
  objective: Objective;
  funnel_stage: FunnelStage;
  campaign_id: string | null;
  status: 'draft' | 'briefing';
  /** Por que esta ação foi escolhida (transparência p/ usuário) */
  reasons?: string[];
  /** Deadline interno antes da publicação (YYYY-MM-DD) */
  internal_deadline?: string | null;
  /** ID do responsável (membro do workspace) */
  responsible_id?: string | null;
}

export interface WeekGeneratorResult {
  actions: GeneratedAction[];
  summary: string;
  /** Estatísticas de cobertura de pilares */
  coverage?: Record<string, { target: number; assigned: number; pct: number }>;
  /** Alertas e justificativas não visuais */
  warnings?: string[];
}

// Onboarding Wizard
export interface OnboardingData {
  // Step 1: Company
  name: string;
  logo_url: string;
  segment: string;
  // Step 2: Location
  country: string;
  state: string;
  city: string;
  // Step 3: Editorial
  pillars: { name: string; percentage: number }[];
  objectives: Objective[];
  // Step 4: Frequency
  frequency_per_week: number;
  allowed_days: number[];
  priority_formats: ContentFormat[];
  // Step 5: Strategic Dates
  strategic_dates: { title: string; date: string; category: string; relevance: DateRelevance }[];
  // Step 6: Google Calendar
  google_calendar_id: string;
}

// Dashboard Stats
export interface DashboardStats {
  activeClients: number;
  actionsThisWeek: number;
  scheduledContent: number;
  pendingActions: number;
  overdueActions: number;
}

export interface ClientSummary {
  id: string;
  name: string;
  logo_url: string | null;
  segment: string | null;
  actionsThisWeek: number;
  pendingActions: number;
  progress: number;
}
