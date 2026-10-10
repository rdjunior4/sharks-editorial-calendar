import { useState, useEffect, useCallback } from 'react';
import { StrategicDate } from '@/types';
import { supabase } from '@/lib/supabase';
import { registerRealtimeReset } from '@/lib/realtimeCleanup';

// ==========================================
// STRATEGIC DATES SERVICE
// Cache + realtime (single shared channel)
// ==========================================

const COLS = 'id, workspace_id, title, date, start_date, end_date, locality, category, relevance, description, is_recurring, created_at';

let store: StrategicDate[] = [];
let currentScope: string | null | undefined = undefined;
let loaded = false;
let loadingPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();
let channel: ReturnType<typeof supabase.channel> | null = null;

function notify() {
  listeners.forEach(fn => fn());
}

export function subscribeToStrategicDates(listener: () => void): () => void {
  listeners.add(listener);
  ensureChannel();
  return () => {
    listeners.delete(listener);
  };
}

async function fetchAll(workspaceId?: string | null): Promise<void> {
  currentScope = workspaceId ?? null;
  let query = supabase.from('strategic_dates').select(COLS);
  if (workspaceId) query = query.eq('workspace_id', workspaceId);
  const { data, error } = await query.order('date');
  if (error) {
    console.error('[strategic-dates] load error:', error.message);
    return;
  }
  store = (data as unknown as StrategicDate[]) || [];
  loaded = true;
  notify();
}

export async function loadStrategicDates(workspaceId?: string | null, force = false): Promise<void> {
  if (loaded && !force && currentScope === (workspaceId ?? null)) return;
  if (loadingPromise && !force) {
    await loadingPromise;
    if (currentScope === (workspaceId ?? null)) return;
  }
  loadingPromise = fetchAll(workspaceId).finally(() => {
    loadingPromise = null;
  });
  await loadingPromise;
}

export function getStrategicDates(workspaceId?: string | null): StrategicDate[] {
  if (workspaceId) return store.filter(d => d.workspace_id === workspaceId);
  // God-view (sem workspace): dedupe por título+data — 18 workstores têm a
  // MESMA data nacional replicada; calendário central mostra cada uma 1x.
  const seen = new Set<string>();
  return store.filter(d => {
    const key = `${d.title}|${d.date}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ensureChannel(): void {
  if (channel) return;
  channel = supabase
    .channel('realtime-strategic-dates')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'strategic_dates' },
      () => {
        if (currentScope !== undefined) fetchAll(currentScope);
      }
    )
    .subscribe();
}

/** Logout: limpa channel + cache (registered em realtimeCleanup). */
export function resetStrategicDatesRealtime(): void {
  if (channel) {
    supabase.removeChannel(channel);
    channel = null;
  }
  store = [];
  currentScope = undefined;
  loaded = false;
  loadingPromise = null;
  notify();
}
registerRealtimeReset(resetStrategicDatesRealtime);

// ---------- mutations ----------

export interface DateInput {
  title: string;
  date: string;
  start_date?: string | null;
  end_date?: string | null;
  locality?: string;
  category?: string;
  relevance?: string;
  description?: string | null;
  is_recurring?: boolean;
}

export async function createStrategicDates(workspaceId: string, rows: DateInput[]): Promise<number> {
  if (rows.length === 0) return 0;
  const payload = rows.map(r => ({
    workspace_id: workspaceId,
    title: r.title,
    date: r.date,
    start_date: r.start_date ?? null,
    end_date: r.end_date ?? null,
    locality: r.locality ?? 'national',
    category: r.category ?? 'commercial',
    relevance: r.relevance ?? 'medium',
    description: r.description ?? null,
    is_recurring: r.is_recurring ?? false,
  }));
  const { data, error } = await supabase.from('strategic_dates').insert(payload).select('id');
  if (error) throw new Error(error.message);
  await fetchAll(currentScope);
  return data?.length ?? 0;
}

export async function updateStrategicDate(id: string, data: Partial<DateInput>): Promise<void> {
  const { error } = await supabase.from('strategic_dates').update(data).eq('id', id);
  if (error) throw new Error(error.message);
  await fetchAll(currentScope);
}

export async function deleteStrategicDate(id: string): Promise<void> {
  const { error } = await supabase.from('strategic_dates').delete().eq('id', id);
  if (error) throw new Error(error.message);
  await fetchAll(currentScope);
}

// ---------- hook ----------

export function useStrategicDates(workspaceId?: string | null) {
  const [dates, setDates] = useState<StrategicDate[]>(() => getStrategicDates(workspaceId));

  useEffect(() => {
    let active = true;
    const sync = () => {
      if (active) setDates([...getStrategicDates(workspaceId)]);
    };
    sync();
    loadStrategicDates(workspaceId).then(sync);
    const unsubscribe = subscribeToStrategicDates(sync);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [workspaceId]);

  const create = useCallback(
    async (rows: DateInput[]) => {
      if (!workspaceId) throw new Error('Workspace não selecionado');
      return createStrategicDates(workspaceId, rows);
    },
    [workspaceId]
  );

  const update = useCallback(async (id: string, data: Partial<DateInput>) => {
    await updateStrategicDate(id, data);
  }, []);

  const remove = useCallback(async (id: string) => {
    await deleteStrategicDate(id);
  }, []);

  return { dates, create, update, remove };
}
