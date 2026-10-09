/* ─── Dispatch — ação humana sobre abordagens (aprovar rascunho / disparar mass) ─── */
import { supabase } from '@/lib/supabase';

export const DISPATCH_EDGE = 'https://cyumczehpiiarwqrpgnu.supabase.co/functions/v1/prospecting-dispatch';

export type DispatchBody =
  | { action: 'approve_draft'; lead_id: string }
  | { action: 'mass'; campaign_id: string };

export async function callDispatch(body: DispatchBody): Promise<{ ok: boolean; status: number; error?: string }> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return { ok: false, status: 401, error: 'Sessão expirada — faça login novamente' };
  try {
    const res = await fetch(DISPATCH_EDGE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const payload = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; queued?: boolean };
    if (res.ok && payload.queued) return { ok: true, status: res.status };
    return { ok: false, status: res.status, error: payload.error ?? `Falha (${res.status})` };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : 'Erro de rede' };
  }
}
