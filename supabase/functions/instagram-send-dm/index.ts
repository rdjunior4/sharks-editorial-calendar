// ==========================================
// instagram-send-dm — envia DM do Instagram do ambiente para o lead
//
// POST { lead_id, message }:
//   • Authorization: Bearer (staff) — chamada manual da UI
//   • x-worker-secret (autêntica interna) — esteira do agente (canal instagram)
//   → sendLeadInstagramDm shared (connection do ambiente + janela 24h)
//   → sucesso: atividade outreach_sent + prospecting_status → contacted
// ==========================================

import { serviceClient, corsHeaders } from '../_shared/google.ts';
import { sendLeadInstagramDm, logInstagramDmSent } from '../_shared/instagram.ts';

const CORS: Record<string, string> = {};
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LeadRow {
  id: string;
  environment: string;
  social_instagram: string | null;
  prospecting_status: string | null;
  ai_data: { ig_sid?: string } | null;
}

Deno.serve(async req => {
  Object.assign(CORS, corsHeaders(req));
  try {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return json(405, { error: 'Use POST' });

    const admin = serviceClient();
    const body = (await req.json().catch(() => null)) as { lead_id?: string; message?: string } | null;
    if (!body?.lead_id || !UUID_RE.test(body.lead_id) || !body.message?.trim()) {
      return json(400, { error: 'Informe lead_id (UUID) e message' });
    }
    const message = body.message.trim();

    const workerSecret = Deno.env.get('WORKER_SECRET');
    const isInternal = !!workerSecret && req.headers.get('x-worker-secret') === workerSecret;
    let userId: string | null = null;

    if (!isInternal) {
      const authHeader = req.headers.get('Authorization');
      if (!authHeader) return json(401, { error: 'Token ausente' });
      const { data: userData } = await admin.auth.getUser(authHeader.replace(/^Bearer /i, ''));
      if (!userData?.user) return json(401, { error: 'Token invalido' });
      userId = userData.user.id;
    }

    const { data: leadData, error: leadErr } = await admin
      .from('crm_leads')
      .select('id, environment, social_instagram, prospecting_status, ai_data')
      .eq('id', body.lead_id)
      .maybeSingle();
    if (leadErr || !leadData) return json(404, { error: 'Lead nao encontrado' });

    const lead = leadData as unknown as LeadRow;

    if (!isInternal) {
      // staff do ambiente (chamada manual)
      const { data: isStaff, error: staffErr } = await admin.rpc('is_env_staff', { user_uuid: userId, env: lead.environment });
      if (staffErr) {
        // fallback por adesão direta
        const { data: envRow } = await admin
          .from('user_environments')
          .select('environment')
          .eq('user_id', userId)
          .eq('environment', lead.environment)
          .maybeSingle();
        const { data: caller } = await admin.from('users').select('role, is_guardian').eq('id', userId).maybeSingle();
        const ok = !!envRow || !!caller?.is_guardian || caller?.role === 'oracullo_admin' ||
          (lead.environment === 'sharks_company' && ['admin_sharks', 'sharks_team'].includes(String(caller?.role ?? '')));
        if (!ok) return json(403, { error: 'Sem acesso a este ambiente' });
      } else if (!isStaff) {
        return json(403, { error: 'Sem acesso a este ambiente' });
      }
    }

    const result = await sendLeadInstagramDm(admin, lead, message);
    if (!result.ok) {
      const extra = result.error_code === 'no_window' && lead.social_instagram
        ? { profile_url: `https://ig.me/m/${lead.social_instagram}` }
        : {};
      return json(result.error_code === 'no_window' ? 409 : 502, {
        error: detail(result),
        ...(result.error_code === 'no_window'
          ? { message: 'Sem janela de conversa: o prospect ainda não interagiu (DM/comentário/Lead Ads). Abra a conversa manualmente pelo Instagram.' }
          : {}),
        ...extra,
      });
    }

    await logInstagramDmSent(admin, lead.id, message, userId);
    if (['discovered', 'qualified', 'queued'].includes(String(lead.prospecting_status ?? ''))) {
      await admin.from('crm_leads').update({ prospecting_status: 'contacted' }).eq('id', lead.id);
    }

    return json(200, { ok: true, sent_to: result.sent_to });
  } catch (e) {
    console.error('[instagram-send-dm] uncaught:', (e as Error)?.stack || e);
    return json(500, { error: `Erro interno: ${(e as Error)?.message || String(e)}` });
  }
});

function detail(r: { detail?: string; status: number }): string {
  return r.detail ?? `Envio falhou (${r.status})`;
}
