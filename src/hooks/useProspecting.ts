import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import type {
  CampaignPayload, CampaignStatus, ProspectingCampaign, ProspectingEnvironment,
  ProspectingJob, ProspectingStatus,
} from '@/lib/prospecting/types';

export type { ProspectingEnvironment };

const CAMPAIGN_SELECT =
  '*, products:prospecting_campaign_products(product:environment_products(id, name)), assigned_to_user:prospecting_campaigns_assigned_to_fkey(id, full_name, avatar_url)';

async function syncCampaignProducts(campaignId: string, productIds: string[]): Promise<void> {
  const { error: delErr } = await supabase
    .from('prospecting_campaign_products')
    .delete()
    .eq('campaign_id', campaignId);
  if (delErr) throw new Error(delErr.message);
  if (productIds.length > 0) {
    const { error: insErr } = await supabase
      .from('prospecting_campaign_products')
      .insert(productIds.map(pid => ({ campaign_id: campaignId, product_id: pid })));
    if (insErr) throw new Error(insErr.message);
  }
}

/* ─── Campanhas (com realtime) ─── */
export function useProspectingCampaigns(environment: ProspectingEnvironment | null) {
  const [campaigns, setCampaigns] = useState<ProspectingCampaign[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    let query = supabase
      .from('prospecting_campaigns')
      .select(CAMPAIGN_SELECT)
      .order('created_at', { ascending: false });
    if (environment) query = query.eq('environment', environment);

    const { data, error } = await query;
    if (error) console.error('[prospecting] campaigns load error:', error.message);
    const rows = ((data ?? []) as unknown) as ProspectingCampaign[];
    const seen = new Set<string>();
    setCampaigns(rows.filter(x => !seen.has(x.id) && seen.add(x.id)));
    setLoading(false);
  }, [environment]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const channel = supabase
      .channel(`prospecting-campaigns-${environment ?? 'all'}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'prospecting_campaigns' },
        () => { load(); },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load, environment]);

  const createCampaign = async (
    environment: ProspectingEnvironment,
    payload: CampaignPayload,
    userId: string | null,
  ): Promise<void> => {
    const { product_ids, ...rest } = payload;
    const { data, error } = await supabase
      .from('prospecting_campaigns')
      .insert({
        ...rest,
        environment,
        created_by: userId,
        assigned_to: payload.assigned_to ?? userId,
      })
      .select('id')
      .single();
    if (error) throw new Error(error.message);
    if (Array.isArray(product_ids)) await syncCampaignProducts(data.id, product_ids);
    await load();
  };

  const updateCampaign = async (id: string, patch: Partial<CampaignPayload>): Promise<void> => {
    const { product_ids, ...update } = patch;
    const { error } = await supabase
      .from('prospecting_campaigns')
      .update(update)
      .eq('id', id);
    if (error) throw new Error(error.message);
    if (Array.isArray(product_ids)) await syncCampaignProducts(id, product_ids);
    await load();
  };

  const deleteCampaign = async (id: string): Promise<void> => {
    const { error } = await supabase.from('prospecting_campaigns').delete().eq('id', id);
    if (error) throw new Error(error.message);
    setCampaigns(prev => prev.filter(c => c.id !== id));
  };

  const setStatus = async (id: string, status: CampaignStatus): Promise<void> => {
    await updateCampaign(id, { status });
  };

  return { campaigns, loading, createCampaign, updateCampaign, deleteCampaign, setStatus };
}

/* ─── Atividade do agente: jobs recentes do ambiente ─── */
export function useProspectingJobs(environment: ProspectingEnvironment | null) {
  const [jobs, setJobs] = useState<ProspectingJob[]>([]);

  useEffect(() => {
    if (!environment) {
      setJobs([]);
      return;
    }
    let active = true;
    const load = async () => {
      const { data, error } = await supabase
        .from('prospecting_jobs')
        .select('*, campaign:prospecting_campaigns!inner(id, name)')
        .eq('campaign.environment', environment)
        .order('created_at', { ascending: false })
        .limit(30);
      if (!active) return;
      if (error) {
        console.error('[prospecting] jobs error:', error.message);
        return;
      }
      setJobs(((data ?? []) as unknown) as ProspectingJob[]);
    };

    load();

    const channel = supabase
      .channel(`prospecting-jobs-${environment}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'prospecting_jobs' },
        () => { load(); },
      )
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [environment]);

  return jobs;
}

/* ─── Personalidade & Parâmetros do agente (por ambiente) ─── */
export interface AgentVoiceSettings {
  mode: 'text' | 'audio' | 'both';
  voice_id: string;
}

export interface AgentSettings {
  personality: {
    agent_name: string;
    tone: string;
    language: string;
    persona: string;
    brand_voice_rules: string;
    signature: string;
    greeting_style: string;
    voice: AgentVoiceSettings;
  };
  params: {
    fit_draft_threshold: number;
    fit_discard_threshold: number;
    confidence_auto: number;
    confidence_review: number;
    max_companies_per_run: number;
    max_messages_per_day: number;
    glm_temperature: number;
    follow_up_days: number;
  };
}

const DEFAULT_SETTINGS: AgentSettings = {
  personality: {
    agent_name: 'Agente', tone: 'amigavel', language: 'pt-BR', persona: '',
    brand_voice_rules: '', signature: '', greeting_style: 'curto, com pergunta aberta',
    voice: { mode: 'text', voice_id: '' },
  },
  params: {
    fit_draft_threshold: 0.75, fit_discard_threshold: 0.5, confidence_auto: 0.7,
    confidence_review: 0.4, max_companies_per_run: 20, max_messages_per_day: 50,
    glm_temperature: 0.7, follow_up_days: 3,
  },
};

export function useAgentSettings(environment: ProspectingEnvironment | null) {
  const [settings, setSettings] = useState<AgentSettings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!environment) { setSettings(DEFAULT_SETTINGS); setLoading(false); return; }
    let active = true;
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from('prospecting_agent_settings')
        .select('personality, params')
        .eq('environment', environment)
        .maybeSingle();
      if (!active) return;
      if (error) console.error('[prospecting] settings error:', error.message);
      const row = (data ?? {}) as { personality?: Partial<AgentSettings['personality']>; params?: Partial<AgentSettings['params']> };
      setSettings({
        personality: {
          ...DEFAULT_SETTINGS.personality,
          ...(row.personality ?? {}),
          voice: { ...DEFAULT_SETTINGS.personality.voice, ...(row.personality?.voice ?? {}) },
        },
        params: { ...DEFAULT_SETTINGS.params, ...(row.params ?? {}) },
      });
      setLoading(false);
    })();
    return () => { active = false; };
  }, [environment]);

  const saveSettings = async (next: AgentSettings, userId: string | null): Promise<void> => {
    if (!environment) throw new Error('Ambiente não definido');
    const { error } = await supabase
      .from('prospecting_agent_settings')
      .update({ personality: next.personality, params: next.params, updated_by: userId })
      .eq('environment', environment);
    if (error) throw new Error(error.message);
    setSettings(next);
  };

  return { settings, loading, saveSettings };
}

/* ─── Abordagens em tempo real (atividades de outreach do agente) ─── */
export interface ApproachFeedItem {
  id: string;
  lead_id: string;
  type: 'outreach_draft' | 'outreach_sent' | 'reply_received';
  content: string;
  metadata: { audio_url?: string; audio_path?: string; audio_provider?: string } | null;
  created_at: string;
  lead: { id: string; name: string; social_instagram: string | null } | null;
}

const APPROACH_TYPES = "('outreach_draft','outreach_sent','reply_received')";

export function useApproaches(environment: ProspectingEnvironment | null) {
  const [items, setItems] = useState<ApproachFeedItem[]>([]);

  useEffect(() => {
    if (!environment) {
      setItems([]);
      return;
    }
    let active = true;
    const load = async () => {
      const { data, error } = await supabase
        .from('crm_lead_activities')
        .select('id, lead_id, type, content, metadata, created_at, lead:crm_lead_activities_lead_id_fkey!inner(id, name, environment, social_instagram)')
        .eq('lead.environment', environment)
        .in('type', ['outreach_draft', 'outreach_sent', 'reply_received'])
        .order('created_at', { ascending: false })
        .limit(50);
      if (!active) return;
      if (error) {
        console.error('[prospecting] approaches error:', error.message);
        return;
      }
      setItems(((data ?? []) as unknown) as ApproachFeedItem[]);
    };

    load();

    const channel = supabase
      .channel(`crm-outreach-${environment}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'crm_lead_activities' },
        () => { load(); },
      )
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [environment]);

  return items;
}

/* ─── Conexão do Instagram do ambiente (migration 074) ─── */
export interface InstagramConnection {
  id: string;
  ig_user_id: string;
  username: string | null;
  page_id: string | null;
  page_name: string | null;
  status: string;
  created_at: string;
}

const IG_COLUMNS = 'id, ig_user_id, username, page_id, page_name, status, created_at';

export function useInstagramConnection(environment: ProspectingEnvironment | null) {
  const [connection, setConnection] = useState<InstagramConnection | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!environment) { setConnection(null); setLoading(false); return; }
    let active = true;
    const load = async () => {
      const { data, error } = await supabase
        .from('instagram_connections')
        .select(IG_COLUMNS)
        .eq('environment', environment)
        .eq('status', 'connected')
        .maybeSingle();
      if (!active) return;
      if (error) console.error('[prospecting] instagram conn:', error.message);
      setConnection(((data ?? null) as unknown) as InstagramConnection | null);
      setLoading(false);
    };
    load();
    const channel = supabase
      .channel(`ig-conn-${environment}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'instagram_connections' }, () => { load(); })
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [environment]);

  return { connection, loading };
}

/* ─── Status dos canais de integração (Edge prospecting-status) ─── */export interface ChannelStatus {
  decision_ai: boolean;
  generative_ai: boolean;
  google_places: boolean;
  meta: boolean;
  n8n: boolean;
  speech: boolean;
}

const EMPTY_CHANNELS: ChannelStatus = {
  decision_ai: false, generative_ai: false, google_places: false, meta: false, n8n: false, speech: false,
};

export function useChannelStatus(enabled: boolean) {
  const [channels, setChannels] = useState<ChannelStatus>(EMPTY_CHANNELS);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    (async () => {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;
        if (!token) return;
        const res = await fetch('https://cyumczehpiiarwqrpgnu.supabase.co/functions/v1/prospecting-status', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const body = (await res.json()) as { channels: ChannelStatus };
        if (active) setChannels(body.channels);
      } catch (e) {
        console.error('[prospecting] canais status:', e);
      }
    })();
    return () => { active = false; };
  }, [enabled]);

  return channels;
}

/* ─── Métricas: leads vindos do agente (origin + prospecting_status) ─── */
export interface ProspectingMetrics {
  found: number;
  qualified: number;
  approach: number;
  interested: number;
  meetings: number;
  /** contadores por campanha (lista) */
  byCampaign: Record<string, { found: number; qualified: number }>;
}

const EMPTY_METRICS: ProspectingMetrics = {
  found: 0, qualified: 0, approach: 0, interested: 0, meetings: 0, byCampaign: {},
};

export function useProspectingMetrics(environment: ProspectingEnvironment | null) {
  const [metrics, setMetrics] = useState<ProspectingMetrics>(EMPTY_METRICS);

  useEffect(() => {
    if (!environment) {
      setMetrics(EMPTY_METRICS);
      return;
    }
    let active = true;
    const load = async () => {
      const { data, error } = await supabase
        .from('crm_leads')
        .select('id, prospecting_status, prospecting_campaign_id')
        .eq('environment', environment)
        .eq('origin', 'prospecting_agent');
      if (!active) return;
      if (error) {
        console.error('[prospecting] metrics error:', error.message);
        return;
      }
      const rows = ((data ?? []) as unknown) as Array<{
        id: string;
        prospecting_status: ProspectingStatus | null;
        prospecting_campaign_id: string | null;
      }>;

      const byCampaign: ProspectingMetrics['byCampaign'] = {};
      const m: ProspectingMetrics = { found: rows.length, qualified: 0, approach: 0, interested: 0, meetings: 0, byCampaign };
      for (const r of rows) {
        const cid = r.prospecting_campaign_id ?? 'sem-campanha';
        byCampaign[cid] ??= { found: 0, qualified: 0 };
        byCampaign[cid].found += 1;
        if (r.prospecting_status === 'qualified') {
          m.qualified += 1;
          byCampaign[cid].qualified += 1;
        }
        if (r.prospecting_status === 'contacted' || r.prospecting_status === 'replied') m.approach += 1;
        if (r.prospecting_status === 'interested') m.interested += 1;
      }
      // Reuniões: estrutura comercial específica chega na F5 — por ora sempre 0
      setMetrics(m);
    };

    load();

    const channel = supabase
      .channel(`prospecting-leads-${environment}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'crm_leads', filter: 'origin=eq.prospecting_agent' },
        () => { load(); },
      )
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [environment]);

  return metrics;
}
