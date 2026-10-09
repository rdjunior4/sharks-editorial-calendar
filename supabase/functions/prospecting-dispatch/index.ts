// ==========================================
// prospecting-dispatch — ação humana sobre as abordagens
//
// POST { Authorization: Bearer JWT }
//   action 'approve_draft' { lead_id } → enfileira send_message do rascunho
//   action 'mass' { campaign_id }      → enfileira mass_dispatch da campanha
// Staff-only por ambiente (rpc is_env_staff).
// ==========================================

import { serviceClient, corsHeaders } from '../_shared/google.ts';
import { normalizePhone } from '../_shared/prospecting/ingest.ts';

const CORS: Record<string, string> = {};
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async req => {
  Object.assign(CORS, corsHeaders(req));
  try {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return json(405, { error: 'Use POST' });

    const admin = serviceClient();
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!token) return json(401, { error: 'Token obrigatório' });
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData.user) return json(401, { error: 'Sessão inválida' });
    const userId = userData.user.id;

    const body = await req.json().catch(() => null) as
      | { action?: 'approve_draft' | 'mass'; lead_id?: string; campaign_id?: string }
      | null;
    if (!body?.action) return json(400, { error: 'action obrigatória' });

    /* ─── Aprovar e enviar rascunho de um lead ─── */
    if (body.action === 'approve_draft') {
      if (!body.lead_id || !UUID_RE.test(body.lead_id)) return json(400, { error: 'lead_id inválido' });
      const { data: lead, error: leadErr } = await admin
        .from('crm_leads')
        .select('id, environment, contact_phone, conversation_mode, prospecting_status, prospecting_campaign_id')
        .eq('id', body.lead_id)
        .maybeSingle();
      if (leadErr || !lead) return json(404, { error: 'Lead não encontrado' });
      const row = lead as { id: string; environment: string; contact_phone: string | null; conversation_mode: string | null; prospecting_status: string | null; prospecting_campaign_id: string | null };
      const { data: isStaff } = await admin.rpc('is_env_staff', { user_uuid: userId, env: row.environment });
      if (!isStaff) return json(403, { error: 'Sem permissão neste ambiente' });
      if (row.conversation_mode === 'human') return json(409, { error: 'Lead em modo humano — a conversa está com o time' });
      if (!normalizePhone(row.contact_phone)) return json(409, { error: 'Lead sem telefone válido para WhatsApp' });
      if (!row.prospecting_campaign_id) return json(409, { error: 'Lead sem campanha vinculada — use a conversa direta no WhatsApp' });

      const { data: draft } = await admin
        .from('crm_lead_activities')
        .select('id')
        .eq('lead_id', row.id)
        .eq('type', 'outreach_draft')
        .limit(1);
      if (!draft || draft.length === 0) return json(409, { error: 'Nenhum rascunho de abordagem para enviar' });

      const { error: enqErr } = await admin.from('prospecting_jobs').insert({
        campaign_id: row.prospecting_campaign_id,
        lead_id: row.id,
        type: 'send_message',
        dedupe_key: `send-${row.id}-manual-${Date.now()}`,
        input: { approved_by: userId, trigger: 'human_approved' },
      });
      if (enqErr) return json(500, { error: `Enfileirar envio: ${enqErr.message}` });
      return json(200, { ok: true, queued: true, lead_id: row.id });
    }

    /* ─── Disparo em massa manual da campanha ─── */
    if (body.action === 'mass') {
      if (!body.campaign_id || !UUID_RE.test(body.campaign_id)) return json(400, { error: 'campaign_id inválido' });
      const { data: camp, error: campErr } = await admin
        .from('prospecting_campaigns')
        .select('id, environment, status')
        .eq('id', body.campaign_id)
        .maybeSingle();
      if (campErr || !camp) return json(404, { error: 'Campanha não encontrada' });
      const c = camp as { id: string; environment: string; status: string };
      const { data: isStaff } = await admin.rpc('is_env_staff', { user_uuid: userId, env: c.environment });
      if (!isStaff) return json(403, { error: 'Sem permissão neste ambiente' });
      if (c.status !== 'running') return json(409, { error: 'Campanha precisa estar running para disparar' });

      const { count: active } = await admin
        .from('prospecting_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('campaign_id', c.id)
        .eq('type', 'mass_dispatch')
        .in('status', ['pending', 'processing', 'retry']);
      if ((active ?? 0) > 0) return json(409, { error: 'Já existe um disparo em andamento para esta campanha' });

      const { error: enqErr } = await admin.from('prospecting_jobs').insert({
        campaign_id: c.id,
        type: 'mass_dispatch',
        dedupe_key: `mass-${c.id}-${Date.now()}`,
        input: { trigger: 'human', by: userId },
      });
      if (enqErr) return json(500, { error: `Enfileirar disparo: ${enqErr.message}` });
      return json(200, { ok: true, queued: true, campaign_id: c.id });
    }

    return json(400, { error: 'action desconhecida' });
  } catch (e) {
    console.error('[prospecting-dispatch] uncaught:', (e as Error)?.stack || e);
    return json(500, { error: `Erro interno: ${(e as Error)?.message || String(e)}` });
  }
});
