/* ─── WhatsApp Cloud API (oficial Meta) — envio por ambiente ───
   Padrão do telegram_connections: worker chama pelo service role.
   Janela 24h: mensagem livre free (respostas ao inbound);
   for da janela: template aprovado obrigatório (cold/follow-up). */

import { serviceClient } from './google.ts';

const GRAPH = 'https://graph.facebook.com/v21.0';

export interface WhatsAppConnection {
  phone_number_id: string;
  access_token: string;
  cold_template: string | null;
  cold_template_lang: string;
  waba_id: string | null;
  display_phone: string | null;
}

export type WhatsAppSendCode =
  | 'invalid_number'     // 131026/131047/... → lead descartável
  | 'no_template'        // fora da janela sem template configurado
  | 'send_fail'          // erro transitório
  | 'no_connection';

export interface WhatsAppCloudResult {
  ok: boolean;
  status: number;
  wamid?: string;
  error_code?: WhatsAppSendCode;
  detail?: string;
}

export async function loadWhatsAppConnection(
  admin: ReturnType<typeof serviceClient>,
  environment: string,
): Promise<WhatsAppConnection | null> {
  const { data: conn } = await admin
    .from('whatsapp_connections')
    .select('phone_number_id, access_token, cold_template, cold_template_lang, waba_id, display_phone, status')
    .eq('environment', environment)
    .eq('status', 'connected')
    .maybeSingle();
  return (conn as unknown as WhatsAppConnection) ?? null;
}

export async function sendWAtext(
  conn: WhatsAppConnection,
  to: string,
  text: string,
): Promise<WhatsAppCloudResult> {
  return postCloud(conn, { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text.slice(0, 3500) } });
}

export async function sendWAaudio(
  conn: WhatsAppConnection,
  to: string,
  audioUrl: string,
): Promise<WhatsAppCloudResult> {
  return postCloud(conn, { messaging_product: 'whatsapp', to, type: 'audio', audio: { link: audioUrl } });
}

/** Template para conversa iniciada pelo negócio (fora da janela 24h). */
export async function sendWAtemplate(
  conn: WhatsAppConnection,
  to: string,
  bodyText: string,
): Promise<WhatsAppCloudResult> {
  if (!conn.cold_template) {
    return { ok: false, status: 409, error_code: 'no_template', detail: 'Sem janela de conversa e sem template aprovado configurado' };
  }
  return postCloud(conn, {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: conn.cold_template,
      language: { code: conn.cold_template_lang || 'pt_BR' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: bodyText.slice(0, 1000) }] }],
    },
  });
}

async function postCloud(conn: WhatsAppConnection, payload: Record<string, unknown>): Promise<WhatsAppCloudResult> {
  const res = await fetch(`${GRAPH}/${conn.phone_number_id}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${conn.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const rawText = await res.text();
  if (!res.ok) return mapCloudError(res.status, rawText);
  const body = JSON.parse(rawText || '{}') as { messages?: Array<{ id?: string }> };
  return { ok: true, status: 200, wamid: body.messages?.[0]?.id };
}

/** Erros oficiais → classes acionáveis (131026 = não entregável; 131047 = fora da janela; 131048 = spam limiar) */
function mapCloudError(status: number, raw: string): WhatsAppCloudResult {
  let code = '';
  let message = '';
  try {
    const err = (JSON.parse(raw) as { error?: { code?: number | string; message?: string; details?: string } }).error ?? {};
    code = String(err.code ?? status);
    message = err.message ?? err.details ?? raw.slice(0, 200);
  } catch {
    message = raw.slice(0, 200);
  }
  const lower = `${code} ${message}`.toLowerCase();
  if (code === '131026' || code === '131047' || lower.includes('re-engagement') || lower.includes('não pertence') ||
      lower.includes('does not exist') || lower.includes('invalid recipient') || lower.includes('not a whatsapp')) {
    return { ok: false, status, error_code: 'invalid_number', detail: `${code}: ${message}` };
  }
  return { ok: false, status, error_code: 'send_fail', detail: `${code}: ${message}` };
}

/** Registra a send na timeline + move o lead + timestamp da janela (inbound). */
export async function logWhatsAppSent(
  admin: ReturnType<typeof serviceClient>,
  leadId: string,
  channel: string,
  message: string,
): Promise<void> {
  const { error } = await admin.from('crm_lead_activities').insert({
    lead_id: leadId,
    type: 'outreach_sent',
    content: `🤖 ${channel} pela esteira do agente: ${message.slice(0, 280) || '(conteúdo no job)'}`,
  });
  if (error) console.error('[whatsapp-cloud] atividade falhou:', error.message);
}
