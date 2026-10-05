// ==========================================
// prospecting-ingest — captura de leads inbound + interações Meta + conversa
//
// 1) Verificação de webhook Meta: GET hub.challenge (META_VERIFY_TOKEN)
// 2) POST com assinatura Meta (X-Hub-Signature-256 + META_APP_SECRET):
//    - leadgen   → Graph API → lead no CRM (dedup por contato)
//    - comments  → dedup por @handle → lead descoberto + PRIVATE REPLY
//    - messages  → atividade reply_received no lead (por @handle)
// 3) POST genérico assinado (x-worker-secret):
//    - { source, environment, name/email/phone, message } → lead inbound
//    - { event: outreach_sent|reply_received, environment, lead_ref, content }
//      → atividade no lead + transição de prospecting_status
// ==========================================

import { serviceClient, corsHeaders } from '../_shared/google.ts';
import { matchesTriggers, shouldProcessEvent } from '../_shared/prospecting/ingest.ts';

/** Token do canal Instagram: conexão in-app (074) tem prioridade; fallback: segredo META_PAGE_TOKEN */
async function loadPageToken(admin: ReturnType<typeof serviceClient>, environment: string): Promise<string | null> {
  const { data: conn } = await admin
    .from('instagram_connections')
    .select('access_token')
    .eq('environment', environment)
    .eq('status', 'connected')
    .maybeSingle();
  const dbTok = (conn as { access_token?: string } | null)?.access_token;
  return dbTok || Deno.env.get('META_PAGE_TOKEN') || null;
}

const CORS: Record<string, string> = {};
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ENVS = ['sharks_company', 'estrategos'];
const VALID_SOURCES = ['meta_ads', 'meta_interaction', 'google', 'website', 'api'];
const GRAPH_VERSION = 'v21.0';

async function verifyMetaSignature(raw: string, signature: string, appSecret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
  const expected = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
  return signature === `sha256=${expected}`;
}

function normalizeEmail(email: string | null | undefined): string | null {
  const v = (email ?? '').trim().toLowerCase();
  return v.includes('@') ? v : null;
}

function normalizePhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= 8 ? digits : null;
}

interface Contact {
  name: string;
  email: string | null;
  phone: string | null;
  social_instagram: string | null;
}

function cleanHandle(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().replace(/^@/, '');
  return /^[A-Za-z0-9._]{2,30}$/.test(v) ? v : null;
}

async function findLead(
  admin: ReturnType<typeof serviceClient>,
  environment: string,
  ref: { email?: string | null; phone?: string | null; social_instagram?: string | null },
) {
  const filters: string[] = [];
  if (ref.email) filters.push(`contact_email.eq.${ref.email}`);
  if (ref.phone) filters.push(`contact_phone.eq.${ref.phone}`);
  if (ref.social_instagram) filters.push(`social_instagram.eq.${ref.social_instagram}`);
  if (filters.length === 0) return null;
  const { data } = await admin
    .from('crm_leads')
    .select('id, name, prospecting_status, ai_data')
    .eq('environment', environment)
    .or(filters.join(','))
    .limit(1)
    .maybeSingle();
  return (data as unknown as { id: string; name: string; prospecting_status: string | null; ai_data?: Record<string, unknown> }) ?? null;
}

async function createLead(
  admin: ReturnType<typeof serviceClient>,
  environment: string,
  source: string,
  contact: Contact,
  campaignId: string | null,
  message: string | null,
): Promise<{ leadId: string }> {
  const { data: lead, error } = await admin
    .from('crm_leads')
    .insert({
      environment,
      name: contact.name || (contact.social_instagram ? `@${contact.social_instagram}` : 'Lead inbound'),
      contact_name: contact.name || null,
      contact_email: contact.email,
      contact_phone: contact.phone,
      social_instagram: contact.social_instagram,
      source,
      origin: 'inbound',
      prospecting_status: 'discovered',
      notes: message || null,
      ...(campaignId ? { prospecting_campaign_id: campaignId } : {}),
    })
    .select('id')
    .single();
  if (error) throw new Error(`Criar lead: ${error.message}`);
  await admin.from('crm_lead_activities').insert({
    lead_id: lead.id,
    type: 'system',
    content: `Lead captado via ${source}.`,
  });
  return { leadId: lead.id as string };
}

async function logActivity(admin: ReturnType<typeof serviceClient>, leadId: string, type: string, content: string) {
  const { error } = await admin.from('crm_lead_activities').insert({ lead_id: leadId, type, content });
  if (error) console.error('[ingest] atividade falhou:', error.message);
}

async function registerReengagement(admin: ReturnType<typeof serviceClient>, leadId: string, src: string, message: string | null) {
  await logActivity(admin, leadId, 'system', `Reengajou via ${src}.${message ? ` Mensagem: ${message}` : ''}`);
}

/* ─── IG-2: dedupe idempotente + gatilhos por campanha ─── */
async function mergeAiData(
  admin: ReturnType<typeof serviceClient>,
  leadId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { data: cur } = await admin.from('crm_leads').select('ai_data').eq('id', leadId).maybeSingle();
  const base = (((cur as { ai_data?: object } | null)?.ai_data ?? {}) as object);
  await admin.from('crm_leads').update({ ai_data: { ...base, ...patch } }).eq('id', leadId);
}

async function loadCampaignTriggers(
  admin: ReturnType<typeof serviceClient>,
  campaignId: string,
): Promise<string[]> {
  const { data } = await admin
    .from('prospecting_campaigns')
    .select('trigger_keywords')
    .eq('id', campaignId)
    .maybeSingle();
  const kws = (data as { trigger_keywords?: string[] } | null)?.trigger_keywords ?? [];
  return Array.isArray(kws) ? kws : [];
}

async function handleMeta(
  admin: ReturnType<typeof serviceClient>,
  payload: Record<string, unknown>,
  environment: string,
  campaignId: string | null,
): Promise<Response> {
  const pageToken = await loadPageToken(admin, environment);
  if (!pageToken) return json(400, { error: 'Instagram/Página não conectada neste ambiente (conecte na aba Agente IA > Canais)' });

  const entries = (payload?.entry ?? []) as Array<Record<string, unknown>>;
  const results: Array<{ kind: string; lead_id?: string; created?: boolean; skipped?: string }> = [];

  for (const entry of entries) {
    const changes = (entry?.changes ?? []) as Array<Record<string, unknown>>;
    for (const change of changes) {
      const field = String(change?.field ?? '');
      const value = (change?.value ?? {}) as Record<string, unknown>;

      // ── Lead Ads ──
      if (field === 'leadgen' && value?.lead_id) {
        const leadId = String(value.lead_id);
        const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${leadId}?access_token=${encodeURIComponent(pageToken)}`);
        if (!res.ok) { console.error('[ingest] Graph leadgen:', res.status); continue; }
        const leadData = (await res.json()) as { field_data?: Array<{ name?: string; values?: string[] }> };
        const get = (k: string) => (leadData.field_data ?? []).find(f => (f.name ?? '').toLowerCase() === k)?.values?.[0] ?? '';
        const contact: Contact = {
          name: (get('full_name') || [get('first_name'), get('last_name')].filter(Boolean).join(' ')).trim(),
          email: normalizeEmail(get('email')),
          phone: normalizePhone(get('phone_number') || get('phone')),
          social_instagram: null,
        };
        const existing = await findLead(admin, environment, contact);
        if (existing) {
          await logActivity(admin, existing.id, 'system', `Reengajou via Meta Lead Ads.`);
          results.push({ kind: 'leadgen', lead_id: existing.id, created: false });
          continue;
        }
        const { leadId: newId } = await createLead(admin, environment, 'meta_ads', contact, campaignId, null);
        results.push({ kind: 'leadgen', lead_id: newId, created: true });
        continue;
      }

      // ── Comentário → private reply + lead por @handle ──
      if (field === 'comments' && value?.comment_id) {
        const username = cleanHandle(String(value?.from?.username ?? ''));
        const commentId = String(value.comment_id);
        const text = String(value.text ?? '');
        if (!username) continue;
        const contact: Contact = { name: `@${username}`, email: null, phone: null, social_instagram: username };
        const existing = await findLead(admin, environment, { social_instagram: username });
        // dedupe idempotente: webhook Meta reenvia eventos em retry
        if (existing && !shouldProcessEvent(existing.ai_data, 'comment', commentId, 'last_comment_id')) {
          results.push({ kind: 'comment', skipped: 'evento duplicado' });
          continue;
        }
        let leadId: string;
        let created: boolean;
        if (existing) {
          leadId = existing.id;
          created = false;
        } else {
          const r = await createLead(admin, environment, 'meta_interaction', contact, campaignId, text);
          leadId = r.leadId;
          created = true;
        }
        await mergeAiData(admin, leadId, { last_comment_id: commentId });

        // gatilho por palavra-chave da campanha → agente entra
        let triggered = false;
        if (campaignId) {
          const keywords = await loadCampaignTriggers(admin, campaignId);
          triggered = matchesTriggers(text, keywords);
        }

        const pr = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${commentId}/private_replies`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: 'Obrigado pelo comentário! Acabei de te enviar uma mensagem aqui no direct 👋', access_token: pageToken }),
        });
        if (!pr.ok) console.error('[ingest] private reply falhou:', pr.status);

        if (triggered && campaignId) {
          await logActivity(admin, leadId, 'reply_received', `🔵 Comentário com GATILHO no post: "${text.slice(0, 160)}" — private reply ${pr.ok ? 'enviada' : 'falhou'}.`);
          await admin.from('prospecting_jobs').insert({
            campaign_id: campaignId,
            lead_id: leadId,
            type: 'generate_message',
            dedupe_key: `comment-${commentId}`,
            input: { lead_id: leadId, context: `Comentário do prospect no Instagram (bateu no gatilho): "${text.slice(0, 300)}" — responda de forma personalizada e convide para conversar melhor.` },
          });
          if (['discovered', 'queued'].includes(String(existing?.prospecting_status ?? ''))) {
            await admin.from('crm_leads').update({ prospecting_status: 'replied' }).eq('id', leadId);
          }
        } else {
          await logActivity(admin, leadId, 'system', `Comentou no post — private reply ${pr.ok ? 'enviada' : 'falhou'}: "${text.slice(0, 120)}"`);
        }
        results.push({ kind: 'comment', lead_id: leadId, created, triggered });
        continue;
      }

      // ── DM recebida ──
      if (field === 'messages') {
        const message = ((value?.message ?? {}) as Record<string, unknown>);
        const text = String(message?.text ?? '').slice(0, 500);
        const mid = String(message?.mid ?? '');
        const senderSid = String((value?.sender as Record<string, unknown>)?.id ?? '') || String((value?.from as Record<string, unknown>)?.id ?? '');
        const handle = cleanHandle(String((value?.from as Record<string, unknown>)?.username ?? ''));
        if (!handle) continue;
        const existing = await findLead(admin, environment, { social_instagram: handle });
        if (!existing) { results.push({ kind: 'message', skipped: 'lead nao encontrado' }); continue; }
        if (mid && !shouldProcessEvent(existing.ai_data, 'dm', mid, 'last_message_mid')) {
          results.push({ kind: 'message', skipped: 'evento duplicado' });
          continue;
        }
        // guarda o IGSID do prospect — habilita DM futura (instagram-send-dm)
        if (senderSid) {
          await mergeAiData(admin, existing.id, { ig_sid: senderSid });
        }
        if (mid) {
          await mergeAiData(admin, existing.id, { last_message_mid: mid });
        }
        // gatilho também na DM (075)
        let triggered = false;
        if (campaignId) {
          const keywords = await loadCampaignTriggers(admin, campaignId);
          triggered = matchesTriggers(text, keywords);
        }
        await logActivity(
          admin,
          existing.id,
          'reply_received',
          `DM recebida${triggered ? ' — ⚡ GATILHO' : ''}: ${text || '(midia)'}`,
        );
        if (existing.prospecting_status === 'contacted' || existing.prospecting_status === 'queued' || existing.prospecting_status === 'discovered') {
          await admin.from('crm_leads').update({ prospecting_status: 'replied' }).eq('id', existing.id);
        }
        if (campaignId) {
          await admin.from('prospecting_jobs').insert({
            campaign_id: campaignId,
            lead_id: existing.id,
            type: 'generate_message',
            ...(mid ? { dedupe_key: `dm-${mid}` } : {}),
            input: { lead_id: existing.id, context: `Resposta do prospect no Instagram${triggered ? ' (gatilho)' : ''}: ${text}` },
          });
        }
        results.push({ kind: 'message', lead_id: existing.id, triggered });
      }
    }
  }
  return json(200, { ok: true, results });
}

Deno.serve(async req => {
  Object.assign(CORS, corsHeaders(req));
  try {
    const admin = serviceClient();
    const url = new URL(req.url);
    const workerSecret = Deno.env.get('WORKER_SECRET');

    // ── Verificação do webhook Meta ──
    if (req.method === 'GET') {
      if (url.searchParams.get('hub.mode') === 'subscribe') {
        const verifyToken = Deno.env.get('META_VERIFY_TOKEN');
        if (verifyToken && url.searchParams.get('hub.verify_token') === verifyToken) {
          return new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200, headers: { ...CORS, 'Content-Type': 'text/plain' } });
        }
        return json(403, { error: 'Verify token invalido' });
      }
      return json(405, { error: 'Use POST' });
    }

    if (req.method !== 'POST') return json(405, { error: 'Use POST' });

    const raw = await req.text();
    const signature = req.headers.get('x-hub-signature-256');
    let payload: Record<string, unknown>;
    let isMeta = false;

    if (signature) {
      const appSecret = Deno.env.get('META_APP_SECRET');
      if (!appSecret) return json(401, { error: 'META_APP_SECRET nao configurado' });
      if (!(await verifyMetaSignature(raw, signature, appSecret))) return json(401, { error: 'Assinatura Meta invalida' });
      payload = JSON.parse(raw);
      isMeta = true;
    } else {
      if (!workerSecret || req.headers.get('x-worker-secret') !== workerSecret) {
        return json(401, { error: 'Assinatura ausente: informe X-Hub-Signature-256 (Meta) ou x-worker-secret' });
      }
      payload = JSON.parse(raw);
    }

    // ── Payload de conversa do n8n (outreach/reply) ──
    const eventType = String(payload?.event ?? '');
    if (eventType === 'outreach_sent' || eventType === 'reply_received') {
      const environment = String(payload?.environment ?? '');
      if (!VALID_ENVS.includes(environment)) return json(400, { error: `env invalido. Use: ${VALID_ENVS.join(', ')}` });
      const ref = (payload?.lead_ref ?? {}) as { email?: string; phone?: string; social_instagram?: string };
      const lead = await findLead(admin, environment, {
        email: normalizeEmail(ref.email),
        phone: normalizePhone(ref.phone),
        social_instagram: cleanHandle(ref.social_instagram),
      });
      if (!lead) return json(404, { error: 'Lead nao encontrado para o ref informado' });
      const content = String(payload?.content ?? '').slice(0, 800);
      await logActivity(admin, lead.id, eventType, content || (eventType === 'outreach_sent' ? 'Abordagem enviada.' : 'Resposta recebida.'));
      if (eventType === 'outreach_sent' && ['discovered', 'qualified', 'queued'].includes(lead.prospecting_status ?? '')) {
        await admin.from('crm_leads').update({ prospecting_status: 'contacted' }).eq('id', lead.id);
      }
      if (eventType === 'reply_received' && ['contacted', 'queued', 'discovered'].includes(lead.prospecting_status ?? '')) {
        await admin.from('crm_leads').update({ prospecting_status: 'replied' }).eq('id', lead.id);
      }
      return json(200, { ok: true, lead_id: lead.id, event: eventType });
    }

    // ── Ambiente/campanha (Meta + genérico) ──
    const environment = url.searchParams.get('env') ?? '';
    if (!VALID_ENVS.includes(environment)) {
      return json(400, { error: `env invalido. Use: ${VALID_ENVS.join(', ')} (ex.: ?env=sharks_company)` });
    }
    const campaignId = url.searchParams.get('campaign');
    if (campaignId && !UUID_RE.test(campaignId)) return json(400, { error: 'campaign invalido' });

    if (isMeta) return await handleMeta(admin, payload, environment, campaignId);

    // ── Genérico assinado (lead direto) ──
    const source = String(payload?.source ?? '');
    if (!VALID_SOURCES.includes(source)) return json(400, { error: `source invalido. Use: ${VALID_SOURCES.join(', ')}` });
    const contact: Contact = {
      name: String(payload?.name ?? '').trim(),
      email: normalizeEmail(payload?.email as string),
      phone: normalizePhone(payload?.phone as string),
      social_instagram: cleanHandle(payload?.instagram as string),
    };
    if (!contact.email && !contact.phone && !contact.social_instagram) {
      return json(400, { error: 'Informe email, phone ou instagram' });
    }
    const existing = await findLead(admin, environment, contact);
    if (existing) {
      await registerReengagement(admin, existing.id, source, payload?.message ? String(payload.message) : null);
      return json(200, { ok: true, created: false, lead_id: existing.id });
    }
    const { leadId } = await createLead(admin, environment, source, contact, campaignId, payload?.message ? String(payload.message) : null);
    return json(200, { ok: true, created: true, lead_id: leadId });
  } catch (e) {
    console.error('[prospecting-ingest] uncaught:', (e as Error)?.stack || e);
    return json(500, { error: `Erro interno: ${(e as Error)?.message || String(e)}` });
  }
});
