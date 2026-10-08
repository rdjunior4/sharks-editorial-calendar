import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { CrmEnvironment } from '@/hooks/useLeads';

/* ─── Parceiros do ambiente (migration 076) ─── */
export interface Partner {
  id: string;
  environment: string;
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  social_instagram: string | null;
  notes: string | null;
  status: 'active' | 'inactive';
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PartnerPayload {
  name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  social_instagram: string | null;
  notes: string | null;
  status: 'active' | 'inactive';
}

const PARTNER_SELECT = 'id, environment, name, contact_name, contact_email, contact_phone, social_instagram, notes, status, created_by, created_at, updated_at';

export function usePartners(environment: CrmEnvironment | null) {
  const [partners, setPartners] = useState<Partner[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!environment) { setPartners([]); setLoading(false); return; }
    let active = true;
    const load = async () => {
      const { data, error } = await supabase
        .from('partners')
        .select(PARTNER_SELECT)
        .eq('environment', environment)
        .order('created_at', { ascending: false });
      if (!active) return;
      if (error) console.error('[partners] load:', error.message);
      setPartners(((data ?? []) as unknown) as Partner[]);
      setLoading(false);
    };
    load();
    const channel = supabase
      .channel(`partners-${environment}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'partners' }, () => { load(); })
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [environment]);

  return { partners, loading };
}

/* ─── Marcos do calendário (lead cadastrado + eventos com parceiro) ─── */
export type MarcoKind = 'lead_cadastrado' | 'reuniao_parceiro' | 'acao_parceiro';

export interface CalendarMarco {
  id: string;
  environment: string;
  kind: MarcoKind;
  title: string;
  description: string | null;
  event_date: string;
  event_time: string | null;
  partner_id: string | null;
  lead_id: string | null;
  responsible_id: string | null;
  status: 'planned' | 'done' | 'canceled';
  created_by: string | null;
  created_at: string;
  partner?: { id: string; name: string } | null;
  responsible?: { id: string; full_name: string; avatar_url: string | null } | null;
}

export interface MarcoPayload {
  environment: string;
  kind: MarcoKind;
  title: string;
  description?: string | null;
  event_date: string;
  event_time?: string | null;
  partner_id?: string | null;
  lead_id?: string | null;
  responsible_id?: string | null;
  status?: 'planned' | 'done' | 'canceled';
}

const MARCO_SELECT = 'id, environment, kind, title, description, event_date, event_time, partner_id, lead_id, responsible_id, status, created_by, created_at, partner:partners!calendar_marcos_partner_id_fkey(id, name), responsible:users!calendar_marcos_responsible_id_fkey(id, full_name, avatar_url)';

export function useCalendarMarcos(environment: CrmEnvironment | null) {
  const [marcos, setMarcos] = useState<CalendarMarco[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!environment) { setMarcos([]); setLoading(false); return; }
    let active = true;
    const load = async () => {
      const { data, error } = await supabase
        .from('calendar_marcos')
        .select(MARCO_SELECT)
        .eq('environment', environment)
        .order('event_date');
      if (!active) return;
      if (error) console.error('[marcos] load:', error.message);
      setMarcos(((data ?? []) as unknown) as CalendarMarco[]);
      setLoading(false);
    };
    load();
    const channel = supabase
      .channel(`marcos-${environment}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'calendar_marcos' }, () => { load(); })
      .subscribe();
    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [environment]);

  return { marcos, loading };
}

export async function createMarco(payload: MarcoPayload): Promise<void> {
  const { error } = await supabase.from('calendar_marcos').insert(payload);
  if (error) throw new Error(error.message);
}

export async function updateMarcoStatus(id: string, status: 'planned' | 'done' | 'canceled'): Promise<void> {
  const { error } = await supabase.from('calendar_marcos').update({ status }).eq('id', id);
  if (error) throw new Error(error.message);
}
