// ==========================================
// whatsapp-connect — conecta a WhatsApp Cloud API (oficial) do ambiente
//
// POST { Authorization: Bearer JWT (admin do ambiente) }
//   { action: 'connect', access_token, phone_number_id, display_phone?,
//     cold_template?, cold_template_lang? }
//     → valida no Graph: GET /{phone_number_id}?fields=... com o token
//     → salva/202 atualiza conexão (1 ativa por ambiente, migration 080)
//   { action: 'disconnect' } → status disconnected
//   { action: 'status' } → conexão sem token (metadados)
// ==========================================

import { serviceClient, corsHeaders } from '../_shared/google.ts';

const CORS: Record<string, string> = {};
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

const GRAPH = 'https://graph.facebook.com/v21.0';

interface PhoneInfo {
  id?: string;
  display_phone_number?: string;
  verified_name?: string;
  name_status?: string;
}

Deno.serve(async req => {
  Object.assign(CORS, corsHeaders(req));
  try {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return json(405, { error: 'Use POST' });

    const admin = serviceClient();
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json(401, { error: 'Token ausente' });
    const { data: userData } = await admin.auth.getUser(authHeader.replace(/^Bearer /i, ''));
    if (!userData?.user) return json(401, { error: 'Token invalido' });
    const userId = userData.user.id;

    const body = (await req.json().catch(() => null)) as
      | {
          action?: 'connect' | 'disconnect' | 'status';
          environment?: string;
          access_token?: string;
          phone_number_id?: string;
          display_phone?: string;
          cold_template?: string;
          cold_template_lang?: string;
        }
      | null;
    const environment = body?.environment;
    if (!environment || !['sharks_company', 'estrategos'].includes(environment)) {
      return json(400, { error: 'environment invalido' });
    }

    const { data: isAdmin, error: adminErr } = await admin.rpc('is_env_admin', { user_uuid: userId, env: environment });
    if (adminErr || !isAdmin) return json(403, { error: 'Somente admin do ambiente' });

    /* ── status: metadados sem token ── */
    if (body?.action === 'status') {
      const { data: conn } = await admin
        .from('whatsapp_connections')
        .select('phone_number_id, display_phone, waba_id, cold_template, status, updated_at')
        .eq('environment', environment)
        .eq('status', 'connected')
        .maybeSingle();
      return json(200, { connection: conn ?? null });
    }

    /* ── disconnect ── */
    if (body?.action === 'disconnect') {
      await admin.from('whatsapp_connections').update({ status: 'disconnected', updated_at: new Date().toISOString() }).eq('environment', environment).eq('status', 'connected');
      return json(200, { ok: true, disconnected: true });
    }

    /* ── connect: valida o token no Graph antes de salvar ── */
    if (body?.action === 'connect') {
      const token = String(body.access_token ?? '').trim();
      const phoneId = String(body.phone_number_id ?? '').replace(/\D/g, '');
      if (!token || !phoneId) return json(400, { error: 'access_token e phone_number_id obrigatórios' });

      const res = await fetch(`${GRAPH}/${phoneId}?fields=id,display_phone_number,verified_name,name_status&access_token=${encodeURIComponent(token)}`);
      if (!res.ok) {
        const errTxt = (await res.text()).slice(0, 200);
        return json(res.status === 401 ? 401 : 400, { error: `Token/phone invalido (${res.status}): ${errTxt}` });
      }
      const info = (await res.json()) as PhoneInfo;
      const displayPhone = body.display_phone || info.display_phone_number || null;

      // substitui conexão ativa anterior
      await admin.from('whatsapp_connections').update({ status: 'disconnected', updated_at: new Date().toISOString() }).eq('environment', environment).eq('status', 'connected');
      const { data: existing } = await admin
        .from('whatsapp_connections')
        .select('id')
        .eq('environment', environment)
        .eq('phone_number_id', phoneId)
        .maybeSingle();

      const payload = {
        environment,
        phone_number_id: phoneId,
        display_phone: displayPhone,
        access_token: token,
        cold_template: (body.cold_template ?? '').trim() || null,
        cold_template_lang: (body.cold_template_lang ?? 'pt_BR') || 'pt_BR',
        waba_id: null,
        status: 'connected' as const,
        connected_by: userId,
        updated_at: new Date().toISOString(),
      };
      let errAnchor = null;
      if (existing) {
        const { error } = await admin.from('whatsapp_connections').update(payload).eq('id', (existing as { id: string }).id);
        errAnchor = error;
      } else {
        const { error } = await admin.from('whatsapp_connections').insert(payload);
        errAnchor = error;
      }
      if (errAnchor) return json(500, { error: `Salvar conexão: ${errAnchor.message}` });

      return json(200, {
        ok: true,
        phone_number_id: phoneId,
        display_phone: displayPhone,
        verified_name: info.verified_name ?? null,
        cold_template: payload.cold_template,
      });
    }

    return json(400, { error: 'action desconhecida' });
  } catch (e) {
    console.error('[whatsapp-connect] uncaught:', (e as Error)?.stack || e);
    return json(500, { error: `Erro interno: ${(e as Error)?.message || String(e)}` });
  }
});
