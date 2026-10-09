import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { STAGE_META, type LeadStage } from '@/lib/crmStages';

/* ─── Types ─── */
export type CrmEnvironment = 'sharks_company' | 'estrategos';

export interface Lead {
  id: string;
  environment: CrmEnvironment;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  source: string | null;
  segment: string | null;
  value: number | null;
  monthly_value: number | null;
  expected_close_date: string | null;
  stage: LeadStage;
  lost_reason: string | null;
  workspace_id: string | null;
  owner_id: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  origin?: 'manual' | 'inbound' | 'prospecting_agent' | 'import' | null;
  social_instagram?: string | null;
  prospecting_status?: string | null;
  prospecting_campaign_id?: string | null;
  owner: { id: string; full_name: string; avatar_url: string | null } | null;
  workspace: { id: string; name: string } | null;
  /** Produtos de interesse (N:N com o catálogo do ambiente) */
  products?: Array<{ product: { id: string; name: string } }> | null;
  /** Vendedores vinculados (N:N, opcional) */
  team?: Array<{ user: { id: string; full_name: string; avatar_url: string | null } }> | null;
  /** Análise do agente (preenchida por prospecting-run) */
  ai_fit?: number | null;
  ai_priority?: 'alta' | 'media' | 'baixa' | null;
  ai_next_step?: string | null;
  ai_analyzed_at?: string | null;
  /** Conversa contínua do agente (migration 077) */
  lead_temperature?: 'cold' | 'warm' | 'hot' | null;
  conversation_mode?: 'ai' | 'human' | null;
  escalation_reason?: string | null;
  conversation_summary?: string | null;
  jev_memory?: { message_count?: number; intents?: string[]; objections_handled?: string[] } | null;
}

export interface LeadActivity {
  id: string;
  lead_id: string;
  user_id: string | null;
  type: 'note' | 'call' | 'meeting' | 'email' | 'stage_change' | 'system'
    | 'outreach_draft' | 'outreach_sent' | 'reply_received';
  content: string;
  metadata: { audio_url?: string; audio_path?: string } | null;
  created_at: string;
  author: { id: string; full_name: string } | null;
}

type LeadPayload = Partial<Lead> & { name: string; product_ids?: string[]; team_ids?: string[] };

/* FKs nomeadas desambiguam os dois vínculos com users (owner_id, created_by) */
const LEAD_SELECT = '*, owner:crm_leads_owner_id_fkey(id, full_name, avatar_url), workspace:workspaces(id, name), products:crm_lead_products(product:environment_products(id, name)), team:crm_lead_team(user:users!crm_lead_team_user_id_fkey(id, full_name, avatar_url))';

/** Substitui a junção lead ↔ produtos do catálogo do ambiente. */
async function syncLeadProducts(leadId: string, productIds: string[]): Promise<void> {
  const { error: delErr } = await supabase.from('crm_lead_products').delete().eq('lead_id', leadId);
  if (delErr) throw new Error(delErr.message);
  if (productIds.length > 0) {
    const { error: insErr } = await supabase
      .from('crm_lead_products')
      .insert(productIds.map(pid => ({ lead_id: leadId, product_id: pid })));
    if (insErr) throw new Error(insErr.message);
  }
}

/** Substitui a junção lead ↔ vendedores do time. */
async function syncLeadTeam(leadId: string, userIds: string[]): Promise<void> {
  const { error: delErr } = await supabase.from('crm_lead_team').delete().eq('lead_id', leadId);
  if (delErr) throw new Error(delErr.message);
  if (userIds.length > 0) {
    const { error: insErr } = await supabase
      .from('crm_lead_team')
      .insert(userIds.map(uid => ({ lead_id: leadId, user_id: uid })));
    if (insErr) throw new Error(insErr.message);
  }
}

/* Mensagem legível de erro de Edge Function (context.response) */
export async function crmFunctionErrorMessage(error: unknown): Promise<string> {
  if (error && typeof error === 'object' && 'context' in error) {
    try {
      const body = await (error as { context: Response }).context.clone().json();
      if (body && typeof body.error === 'string') return body.error;
    } catch { /* */ }
  }
  return error instanceof Error ? error.message : 'Erro inesperado';
}

/* ─── Leads (com realtime) ─── */
export function useLeads(environment: CrmEnvironment | null) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    let query = supabase
      .from('crm_leads')
      .select(LEAD_SELECT)
      .order('created_at', { ascending: false });
    if (environment) query = query.eq('environment', environment);

    const { data, error } = await query;
    if (error) console.error('[crm] load error:', error.message);
    // Dedup defensivo: evento realtime + append manual podem correr em paralelo
    const rows = ((data ?? []) as unknown) as Lead[];
    const seen = new Set<string>();
    setLeads(rows.filter(l => !seen.has(l.id) && seen.add(l.id)));
    setLoading(false);
  }, [environment]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const channel = supabase
      .channel(`crm-leads-${environment ?? 'all'}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'crm_leads' },
        () => { load(); },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load, environment]);

  const createLead = async (payload: LeadPayload): Promise<Lead> => {
    const { data: auth } = await supabase.auth.getUser();
    const { product_ids, team_ids, ...insert } = payload;
    const { data, error } = await supabase
      .from('crm_leads')
      .insert({
        ...insert,
        owner_id: insert.owner_id ?? auth.user?.id ?? null,
        created_by: auth.user?.id ?? null,
      })
      .select(LEAD_SELECT)
      .single();
    if (error) throw new Error(error.message);
    const lead = data as unknown as Lead;

    if (Array.isArray(product_ids)) await syncLeadProducts(lead.id, product_ids);
    if (Array.isArray(team_ids)) await syncLeadTeam(lead.id, team_ids);

    if (Array.isArray(product_ids) || Array.isArray(team_ids)) {
      const { data: fresh, error: err2 } = await supabase
        .from('crm_leads')
        .select(LEAD_SELECT)
        .eq('id', lead.id)
        .single();
      if (err2) throw new Error(err2.message);
      const final = fresh as unknown as Lead;
      setLeads(prev => prev.some(x => x.id === final.id) ? prev.map(x => (x.id === final.id ? final : x)) : [final, ...prev]);
      return final;
    }

    // Append com guarda: o realtime pode já ter recarregado a lista com este lead
    setLeads(prev => prev.some(x => x.id === lead.id) ? prev : [lead, ...prev]);
    return lead;
  };

  const updateLead = async (id: string, patch: Partial<Lead> & { product_ids?: string[]; team_ids?: string[] }): Promise<Lead> => {
    const { product_ids, team_ids, ...update } = patch;
    const { data, error } = await supabase
      .from('crm_leads')
      .update(update)
      .eq('id', id)
      .select(LEAD_SELECT)
      .single();
    if (error) throw new Error(error.message);
    let lead = data as unknown as Lead;

    if (Array.isArray(product_ids)) await syncLeadProducts(id, product_ids);
    if (Array.isArray(team_ids)) await syncLeadTeam(id, team_ids);

    if (Array.isArray(product_ids) || Array.isArray(team_ids)) {
      const { data: fresh, error: err2 } = await supabase
        .from('crm_leads')
        .select(LEAD_SELECT)
        .eq('id', id)
        .single();
      if (err2) throw new Error(err2.message);
      lead = fresh as unknown as Lead;
    }

    setLeads(prev => prev.map(l => (l.id === id ? lead : l)));
    return lead;
  };

  const deleteLead = async (id: string): Promise<void> => {
    const { error } = await supabase.from('crm_leads').delete().eq('id', id);
    if (error) throw new Error(error.message);
    setLeads(prev => prev.filter(l => l.id !== id));
  };

  /** Move a etapa registrando a atividade de transição. */
  const moveStage = async (lead: Lead, stage: LeadStage): Promise<void> => {
    if (lead.stage === stage) return;
    const snapshot = leads;
    setLeads(ls => ls.map(l => (l.id === lead.id ? { ...l, stage } : l)));

    const { error } = await supabase.from('crm_leads').update({ stage }).eq('id', lead.id);
    if (error) {
      setLeads(snapshot);
      throw new Error(error.message);
    }

    const { data: auth } = await supabase.auth.getUser();
    await supabase.from('crm_lead_activities').insert({
      lead_id: lead.id,
      user_id: auth.user?.id ?? null,
      type: 'stage_change',
      content: `Etapa: ${STAGE_META[lead.stage].label} → ${STAGE_META[stage].label}`,
    });
  };

  /** Converte via edge function; recarrega o board (stage won + workspace). */
  const convertLead = async (leadId: string, workspaceName?: string, segment?: string) => {
    const { data, error } = await supabase.functions.invoke('crm-convert-lead', {
      body: {
        lead_id: leadId,
        ...(workspaceName?.trim() ? { workspace_name: workspaceName.trim() } : {}),
        ...(segment?.trim() ? { segment: segment.trim() } : {}),
      },
    });
    if (error) throw new Error(await crmFunctionErrorMessage(error));
    if (data?.error) throw new Error(data.error);
    await load();
    return data as { workspace_id: string; workspace_name: string };
  };

  return { leads, loading, load, createLead, updateLead, deleteLead, moveStage, convertLead };
}

/* ─── Atividades de um lead (com realtime) ─── */
export function useLeadActivities(leadId: string | null) {
  const [activities, setActivities] = useState<LeadActivity[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!leadId) {
      setActivities([]);
      return;
    }

    let active = true;
    const loadActivities = async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from('crm_lead_activities')
        .select('*, author:users(id, full_name)')
        .eq('lead_id', leadId)
        .order('created_at', { ascending: true });
      if (active) {
        if (error) console.error('[crm] activities error:', error.message);
        setActivities(((data ?? []) as unknown) as LeadActivity[]);
        setLoading(false);
      }
    };

    loadActivities();

    const channel = supabase
      .channel(`crm-activities-${leadId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'crm_lead_activities', filter: `lead_id=eq.${leadId}` },
        () => { loadActivities(); },
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [leadId]);

  const addActivity = async (type: LeadActivity['type'], content: string): Promise<void> => {
    if (!leadId || !content.trim()) return;
    const { data: auth } = await supabase.auth.getUser();
    const { error } = await supabase.from('crm_lead_activities').insert({
      lead_id: leadId,
      user_id: auth.user?.id ?? null,
      type,
      content: content.trim(),
    });
    if (error) throw new Error(error.message);
  };

  return { activities, loading, addActivity };
}

/* ─── Clientes ativos da agenda (workspaces) para o CRM ─── */
export interface CrmClient {
  id: string;
  name: string;
  segment: string | null;
  environment: string | null;
}

export function useCrmClients(environment: CrmEnvironment | null) {
  const [clients, setClients] = useState<CrmClient[]>([]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const [wsRes, mapRes] = await Promise.all([
        supabase.from('workspaces').select('id, name, segment').eq('is_active', true).order('name'),
        supabase.rpc('ws_env_map'),
      ]);
      if (!active) return;
      if (wsRes.error) console.error('[crm] clients error:', wsRes.error.message);
      const envByWs = new Map<string, string>(
        ((mapRes.data ?? []) as unknown as Array<{ id: string; environment: string }>).map(r => [r.id, r.environment]),
      );
      const list = (((wsRes.data ?? []) as unknown) as Array<{ id: string; name: string; segment: string | null }>)
        .filter(w => (environment ? envByWs.get(w.id) === environment : true))
        .map(w => ({ ...w, environment: envByWs.get(w.id) ?? null }));
      setClients(list);
    };

    load();

    const channel = supabase
      .channel('crm-clients')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'workspaces' },
        () => { load(); },
      )
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [environment]);

  return clients;
}

/* ─── Última atividade de cada lead (resumo para o card do pipeline) ─── */
export interface LeadActivitySummary {
  type: LeadActivity['type'];
  content: string;
  created_at: string;
}

export function useLeadActivitySummaries(environment: CrmEnvironment | null) {
  const [summaries, setSummaries] = useState<Map<string, LeadActivitySummary>>(new Map());

  useEffect(() => {
    let active = true;
    const load = async () => {
      const { data, error } = await supabase
        .from('crm_lead_activities')
        .select('lead_id, type, content, created_at, lead:crm_lead_activities_lead_id_fkey(environment)')
        .order('created_at', { ascending: false })
        .limit(3000);
      if (!active) return;
      if (error) {
        console.error('[crm] activity summaries error:', error.message);
        return;
      }
      const map = new Map<string, LeadActivitySummary>();
      for (const row of ((data ?? []) as unknown as Array<{
        lead_id: string;
        type: LeadActivity['type'];
        content: string;
        created_at: string;
        lead: { environment: CrmEnvironment } | null;
      }>)) {
        if (environment && row.lead?.environment !== environment) continue;
        // Lista ordenada por created_at desc → a primeira ocorrência é a mais recente
        if (!map.has(row.lead_id)) {
          map.set(row.lead_id, { type: row.type, content: row.content, created_at: row.created_at });
        }
      }
      setSummaries(map);
    };

    load();

    const channel = supabase
      .channel('crm-activity-summaries')
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

  return summaries;
}

/* ─── Staff do ambiente (opções de responsável) ─── */
export function useEnvStaff(environment: CrmEnvironment | null) {
  const [options, setOptions] = useState<{ value: string; label: string }[]>([]);

  useEffect(() => {
    if (!environment) {
      setOptions([]);
      return;
    }
    let active = true;
    (async () => {
      // user_environments não tem FK exposta para public.users — duas queries
      const { data: ue } = await supabase
        .from('user_environments')
        .select('user_id')
        .eq('environment', environment)
        .in('role', ['admin', 'team']);
      const ids = [...new Set(((ue ?? []) as Array<{ user_id: string }>).map(r => r.user_id))];
      if (!active) return;
      if (ids.length === 0) {
        setOptions([]);
        return;
      }
      const { data: us } = await supabase.from('users').select('id, full_name').in('id', ids);
      if (!active) return;
      setOptions(
        ((us ?? []) as Array<{ id: string; full_name: string }>)
          .map(u => ({ value: u.id, label: u.full_name }))
          .sort((a, b) => a.label.localeCompare(b.label)),
      );
    })();
    return () => { active = false; };
  }, [environment]);

  return options;
}
