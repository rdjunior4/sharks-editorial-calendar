import { normalizeAction } from './actionNormalization';
import { localDate } from './localDate';
import { Action, ActionFilters } from '@/types';
import { supabase, authState } from '@/lib/supabase';
import { notifyActionChanged } from '@/lib/googleSync';
import { registerRealtimeReset } from '@/lib/realtimeCleanup';

// ==========================================
// ACTIONS SERVICE - Supabase-backed cache
// Synchronous reads from local cache,
// write-through mutations to Supabase.
// ==========================================

let actionsStore: Action[] = [];
let currentScope: string | null | undefined = undefined; // undefined = not loaded yet
let loadStatus: 'idle' | 'loading' | 'success' | 'error' = 'idle';
let loadSeq = 0;
let listeners: (() => void)[] = [];
let realtimeChannel: ReturnType<typeof supabase.channel> | null = null;

function notifyListeners() {
  listeners.forEach(fn => fn());
}

function applyLocalFilters(filters?: ActionFilters): Action[] {
  let result = [...actionsStore];

  if (filters?.workspaceId) {
    result = result.filter(a => a.workspace_id === filters.workspaceId);
  }
  if (filters?.campaignId) {
    result = result.filter(a => a.campaign_id === filters.campaignId);
  }
  if (filters?.format) {
    result = result.filter(a => a.format === filters.format);
  }
  if (filters?.objective) {
    result = result.filter(a => a.objective === filters.objective);
  }
  if (filters?.pillarId) {
    result = result.filter(a => a.editorial_pillar_id === filters.pillarId);
  }
  if (filters?.status) {
    result = result.filter(a => a.status === filters.status);
  }
  if (filters?.actionType) {
    result = result.filter(a => a.action_type === filters.actionType);
  }
  if (filters?.responsibleId) {
    result = result.filter(a => a.responsible_id === filters.responsibleId || a.responsibles?.some(r => r.id === filters.responsibleId));
  }
  if (filters?.channel) {
    result = result.filter(a => a.channel === filters.channel);
  }
  if (filters?.startDate) {
    result = result.filter(a => a.action_date >= filters.startDate!);
  }
  if (filters?.endDate) {
    result = result.filter(a => a.action_date <= filters.endDate!);
  }
  if (filters?.environment) {
    result = result.filter(a => a.environment === filters.environment);
  }

  return result.sort((a, b) =>
    a.action_date === b.action_date
      ? (a.action_time || '').localeCompare(b.action_time || '')
      : a.action_date.localeCompare(b.action_date)
  );
}

export function subscribeToActions(listener: () => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter(l => l !== listener);
  };
}

const SELECT_WITH_JOINS = 'id,workspace_id,product_id,channels,campaign_id,editorial_pillar_id,responsible_id,title,description,action_date,action_time,action_type,format,channel,objective,funnel_stage,audience,product,theme,hook,main_message,copy_text,cta,internal_deadline,status,observations,reference_urls,sync_status,is_auto_generated,environment,created_by,created_at,updated_at, campaign:campaigns(id,workspace_id,name,objective,start_date,end_date,description,audience,product,priority,status,color,created_at,updated_at), editorial_pillar:editorial_pillars(id,workspace_id,name,description,color,percentage,sort_order,is_active,created_at), workspace:workspaces(name), responsible:users!actions_responsible_id_fkey(id, full_name, avatar_url), responsibles:action_responsibles(users(id, full_name, avatar_url)), product_ref:environment_products!actions_product_id_fkey(id, name), products:action_products(product:environment_products!action_products_product_id_fkey(id, name))';

export async function loadActions(workspaceId?: string | null, environment?: string | null): Promise<void> {
  currentScope = workspaceId ?? null;
  const seq = ++loadSeq;
  loadStatus = 'loading';
  notifyListeners();
  let query = supabase.from('actions').select(SELECT_WITH_JOINS);
  if (workspaceId) {
    query = query.eq('workspace_id', workspaceId);
  }
  if (environment) {
    query = query.eq('environment', environment);
  }
  const { data, error } = await query.order('action_date');

  if (seq !== loadSeq) return;

  if (error) {
    console.error('[actions] load error:', error.message);
    loadStatus = 'error';
    notifyListeners();
    return;
  }

  actionsStore = (data ?? []).map(normalizeAction);
  loadStatus = 'success';
  notifyListeners();

  // Realtime: single global channel, reload scope on any change
  if (!realtimeChannel) {
    realtimeChannel = supabase
      .channel('realtime-actions')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'actions' },
        () => {
          if (currentScope !== undefined) {
            loadActions(currentScope);
          }
        }
      )
      .subscribe();
  }
}

/** Logout: limpa channel + cache (registered em realtimeCleanup). */
export function resetActionsRealtime(): void {
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  actionsStore = [];
  currentScope = undefined;
  loadStatus = 'idle';
  loadSeq++;
  notifyListeners();
}
registerRealtimeReset(resetActionsRealtime);

export async function reloadActions(): Promise<void> {
  if (currentScope !== undefined) {
    await loadActions(currentScope);
  }
}

export function getCurrentScope(): string | null | undefined {
  return currentScope;
}

export function getActionsLoadStatus(): 'idle' | 'loading' | 'success' | 'error' {
  return loadStatus;
}

export function getActions(filters?: ActionFilters): Action[] {
  return applyLocalFilters(filters);
}

export function getActionById(id: string): Action | undefined {
  return actionsStore.find(a => a.id === id);
}

export interface ActionResult {
  ok: boolean;
  data?: Action;
  error?: string;
  warning?: string;
}

/** Grava os responsáveis (N:N) via RPC e re-carrega a linha com os joins. */
async function syncResponsibles(actionId: string, userIds: string[]): Promise<Action | null> {
  try {
    const { error } = await supabase.rpc('set_action_responsibles', {
      p_action_id: actionId,
      p_user_ids: userIds,
    });
    if (error) {
      console.error('[actions] set_action_responsibles error:', error.message);
      return null;
    }
    const { data, error: reloadError } = await supabase
      .from('actions')
      .select(SELECT_WITH_JOINS)
      .eq('id', actionId)
      .single();
    if (reloadError) throw new Error(reloadError.message);
    return data ? normalizeAction(data) : null;
  } catch (error) {
    console.error('[actions] responsible assignment failed:', error);
    return null;
  }
}

export async function createAction(data: Partial<Action> & { responsible_ids?: string[]; product_ids?: string[] }): Promise<ActionResult> {
  const productIds = (data as Partial<Action> & { product_ids?: string[] }).product_ids;
  // Compatibilidade: product_id fica com o 1º produto selecionado
  const legacyProductId = data.product_id || (Array.isArray(productIds) ? productIds[0] ?? null : null);
  const payload = {
    workspace_id: data.workspace_id || '',
    environment: data.environment || 'sharks_company',
    campaign_id: data.campaign_id || null,
    editorial_pillar_id: data.editorial_pillar_id || null,
    responsible_id: data.responsible_id || null,
    title: data.title || '',
    description: data.description || null,
    action_date: data.action_date || '',
    action_time: data.action_time || null,
    action_type: data.action_type || 'content',
    format: data.format || null,
    channel: data.channel || null,
    objective: data.objective || null,
    funnel_stage: data.funnel_stage || null,
    audience: data.audience || null,
    product_id: legacyProductId,
    product: data.product || null,
    theme: data.theme || null,
    hook: data.hook || null,
    main_message: data.main_message || null,
    copy_text: data.copy_text || null,
    cta: data.cta || null,
    internal_deadline: data.internal_deadline || null,
    status: data.status || 'draft',
    observations: data.observations || null,
    reference_urls: data.reference_urls || [],
    is_auto_generated: data.is_auto_generated || false,
    created_by: authState.userId,
  };

  const { data: inserted, error } = await supabase
    .from('actions')
    .insert(payload)
    .select(SELECT_WITH_JOINS)
    .single();

  if (error || !inserted) {
    console.error('[actions] create error:', error?.message);
    return { ok: false, error: error?.message || 'Erro ao criar ação' };
  }

  // Produtos (N:N) — gravação direta
  if (Array.isArray(productIds) && productIds.length > 0) {
    const pr = await supabase.from('action_products').insert(productIds.map(pid => ({ action_id: (inserted as { id: string }).id, product_id: pid })));
    if (pr.error) console.error('[actions] action_products error:', pr.error.message);
  }

  if (Array.isArray(productIds) && productIds.length > 0) {
    const rf = await supabase.from('actions').select(SELECT_WITH_JOINS).eq('id', (inserted as { id: string }).id).single();
    if (rf.data) {
      Object.assign(inserted as object, rf.data as object);
    }
  }

  // Múltiplos responsáveis (N:N) — RPC após o insert
  const respIds = (data as Partial<Action> & { responsible_ids?: string[] }).responsible_ids;
  let finalAction = normalizeAction(inserted);
  let warning: string | undefined;
  if (Array.isArray(respIds)) {
    const refreshed = await syncResponsibles(finalAction.id, respIds);
    if (refreshed) finalAction = refreshed;
    else warning = "Ação criada, mas os responsáveis não foram confirmados. Reabra a ação para conferir a atribuição.";
  }

  const idx = actionsStore.findIndex(a => a.id === finalAction.id);
  if (idx !== -1) actionsStore[idx] = finalAction;
  else actionsStore.push(finalAction);
  notifyListeners();
  notifyActionChanged(finalAction.workspace_id);
  return { ok: true, data: finalAction, warning };
}

export async function updateAction(id: string, data: Partial<Action> & { responsible_ids?: string[]; product_ids?: string[] }): Promise<ActionResult> {
  const oldAction = getActionById(id);

  // responsible_ids não é coluna — vai para a RPC após o update
  // product_ids/partner_ids não são colunas — vão para as junções após o update
  const { responsible_ids: respIdsRaw, product_ids: productIdsRaw, ...updatePayload } = data as Partial<Action> & { responsible_ids?: string[]; product_ids?: string[] };

  // Compatibilidade: product_id fica com o 1º produto selecionado
  if (Array.isArray(productIdsRaw)) {
    (updatePayload as { product_id?: string | null }).product_id = productIdsRaw[0] ?? null;
  }

  const { data: updated, error } = await supabase
    .from('actions')
    .update(updatePayload)
    .eq('id', id)
    .select(SELECT_WITH_JOINS)
    .single();

  if (error || !updated) {
    console.error('[actions] update error:', error?.message);
    return { ok: false, error: error?.message || 'Erro ao atualizar ação' };
  }

  // Mark as needing sync locally if date changed and was previously synced
  const result = normalizeAction(updated);
  let warning: string | undefined;

  // Múltiplos responsáveis (N:N) — RPC após o update
  if (Array.isArray(respIdsRaw)) {
    const refreshed = await syncResponsibles(id, respIdsRaw);
    if (refreshed) Object.assign(result, refreshed);
    else warning = "Ação atualizada, mas os responsáveis não foram confirmados. Reabra a ação para conferir a atribuição.";
  }

  // Produtos (N:N) — gravação direta
  if (Array.isArray(productIdsRaw)) {
    const del = await supabase.from('action_products').delete().eq('action_id', id);
    if (del.error) console.error('[actions] action_products delete error:', del.error.message);
    if (productIdsRaw.length > 0) {
      const ins = await supabase.from('action_products').insert(productIdsRaw.map(pid => ({ action_id: id, product_id: pid })));
      if (ins.error) console.error('[actions] action_products error:', ins.error.message);
    }
  }

  if (Array.isArray(productIdsRaw)) {
    const rf = await supabase.from('actions').select(SELECT_WITH_JOINS).eq('id', id).single();
    if (rf.data) Object.assign(result, rf.data as object);
  }

  if (
    data.action_date &&
    oldAction?.sync_status === 'synced' &&
    data.action_date !== oldAction.action_date
  ) {
    result.sync_status = 'modified_after_sync';
  }

  const index = actionsStore.findIndex(a => a.id === id);
  if (index !== -1) {
    actionsStore[index] = result;
  }
  notifyListeners();
  notifyActionChanged(result.workspace_id);
  return { ok: true, data: result, warning };
}

export async function deleteAction(id: string): Promise<{ ok: boolean; error?: string }> {
  const wsId = getActionById(id)?.workspace_id;
  const { error } = await supabase.from('actions').delete().eq('id', id);
  if (error) {
    console.error('[actions] delete error:', error.message, error);
    notifyListeners();
    return { ok: false, error: error.message };
  }
  actionsStore = actionsStore.filter(a => a.id !== id);
  notifyListeners();
  notifyActionChanged(wsId);
  return { ok: true };
}

export async function bulkCreateActions(rows: Partial<Action>[]): Promise<{ ok: boolean; count: number; warning?: string; error?: string }> {
  // responsible_ids/product_ids/partner_ids não são colunas — vão para
  // RPC/junções após o insert

  const payload = rows.map(r => {
    const {
      responsible_ids: _resp,
      product_ids: _prod,
      ...rest
    } = r as Partial<Action> & { responsible_ids?: string[]; product_ids?: string[] };
    return {
      ...rest,
      id: rest.id || crypto.randomUUID(),
      sync_status: rest.sync_status || 'not_synced',
      reference_urls: rest.reference_urls || [],
      created_by: authState.userId,
    };
  });

  const { data, error } = await supabase.from('actions').insert(payload).select('id');
  if (error) {
    console.error('[actions] bulk create error:', error.message);
    return { ok: false, count: 0, error: error.message };
  }

  // Junções (produtos do cliente + parceiros) por linha criada
  const productJunctions: Array<{ action_id: string; product_id: string }> = [];
  for (const row of (data ?? [])) {
    const src = rows.find((_, i) => payload[i]?.id === row.id) as (Partial<Action> & { product_ids?: string[] }) | undefined;
    for (const pid of src?.product_ids ?? []) productJunctions.push({ action_id: row.id, product_id: pid });
  }
  if (productJunctions.length > 0) {
    const pr = await supabase.from('action_products').insert(productJunctions);
    if (pr.error) console.error('[actions] bulk action_products error:', pr.error.message);
  }

  let warning: string | undefined;
  const assignments = await Promise.allSettled((data ?? []).map(row => {
    const index = payload.findIndex(item => item.id === row.id);
    const ids = (rows[index] as Partial<Action> & { responsible_ids?: string[] }).responsible_ids;
    return Array.isArray(ids)
      ? supabase.rpc('set_action_responsibles', { p_action_id: row.id, p_user_ids: ids })
      : Promise.resolve({ error: null });
  }));
  if (assignments.some(r => r.status === 'rejected' || r.value.error)) {
    warning = 'Ações criadas, mas houve falha ao atribuir responsáveis. Confira as ações antes de repetir a operação.';
  }

  await reloadActions();
  notifyActionChanged(rows[0]?.workspace_id || null);
  return { ok: true, count: data?.length || 0, warning };
}

export function getActionsByDate(date: string, workspaceId?: string): Action[] {
  return actionsStore.filter(a => {
    if (workspaceId && a.workspace_id !== workspaceId) return false;
    return a.action_date === date;
  });
}

export function getTodayActions(workspaceId?: string): Action[] {
  const today = localDate();
  return getActionsByDate(today, workspaceId).sort((a, b) =>
    (a.action_time || '').localeCompare(b.action_time || '')
  );
}

export function getWeekActions(startDate: string, endDate: string, workspaceId?: string): Action[] {
  return actionsStore
    .filter(a => {
      if (workspaceId && a.workspace_id !== workspaceId) return false;
      return a.action_date >= startDate && a.action_date <= endDate;
    })
    .sort((a, b) => a.action_date.localeCompare(b.action_date));
}

export function getOverdueActions(workspaceId?: string): Action[] {
  const today = localDate();
  return actionsStore.filter(a => {
    if (workspaceId && a.workspace_id !== workspaceId) return false;
    if (['published', 'completed', 'cancelled'].includes(a.status)) return false;
    return a.action_date < today;
  });
}

export function getPendingActions(workspaceId?: string): Action[] {
  return actionsStore.filter(a => {
    if (workspaceId && a.workspace_id !== workspaceId) return false;
    return ['draft', 'briefing'].includes(a.status);
  });
}
