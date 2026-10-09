/* ─── Instagram DM (compartilhado) ───
   Um único caminho para o envio de DM: web → instagram-send-dm (JWT staff)
   e worker (prospect segmento instagram) chamam a mesma lógica de envio.
   Requer IGSID do lead (ai_data.ig_sid) janela de conversa (24h). */

import { serviceClient } from './google.ts';

const GRAPH = 'https://graph.facebook.com/v21.0';

export interface InstagramSendResult {
  ok: boolean;
  status: number;
  detail?: string;
  sent_to?: string;
  error_code?: 'no_connection' | 'no_window' | 'send_fail';
}

export async function sendInstagramMessage(
  pageId: string,
  accessToken: string,
  recipientIgSid: string,
  text: string,
): Promise<InstagramSendResult> {
  const res = await fetch(`${GRAPH}/${pageId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: accessToken,
      recipient: { id: recipientIgSid },
      messaging_type: 'RESPONSE',
      message: { text: text.slice(0, 900) },
    }),
  });
  if (res.ok) return { ok: true, status: 200 };
  return { ok: false, status: res.status, detail: (await res.text()).slice(0, 200), error_code: 'send_fail' };
}

/**
 * Envia DM do ambiente para o lead via conexão conectada.
 * service-client (bypassa RLS) — chamadores já validaram permissão.
 */
export async function sendLeadInstagramDm(
  admin: ReturnType<typeof serviceClient>,
  lead: { id: string; environment: string; social_instagram: string | null; prospecting_status: string | null; ai_data?: { ig_sid?: string } | null },
  message: string,
): Promise<InstagramSendResult> {
  const { data: conn } = await admin
    .from('instagram_connections')
    .select('page_id, ig_user_id, access_token, username, status')
    .eq('environment', lead.environment)
    .eq('status', 'connected')
    .maybeSingle();
  if (!conn) {
    return { ok: false, status: 409, error_code: 'no_connection', detail: 'Instagram não conectado no ambiente' };
  }
  const igSid = (lead.ai_data as { ig_sid?: string } | null)?.ig_sid;
  if (!igSid) {
    return {
      ok: false,
      status: 409,
      error_code: 'no_window',
      detail: 'Sem janela de conversa (prospect não interagiu nas última 24h)',
    };
  }
  const result = await sendInstagramMessage(conn.page_id, conn.access_token, igSid, message);
  if (!result.ok) return result;
  return { ok: true, status: 200, sent_to: `@${lead.social_instagram ?? ''}` };
}

/** Registra envio de DM + move lead na esteira (chamar após ok) */
export async function logInstagramDmSent(
  admin: ReturnType<typeof serviceClient>,
  leadId: string,
  message: string,
  userId: string | null,
): Promise<void> {
  const { error } = await admin.from('crm_lead_activities').insert({
    lead_id: leadId,
    user_id: userId,
    type: 'outreach_sent',
    content: `DM enviada no Instagram:\n${message.slice(0, 300)}`,
  });
  if (error) console.error('[instagram] registrar atividade:', error.message);
}
