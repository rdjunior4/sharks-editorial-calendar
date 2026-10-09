// ==========================================
// prospecting-conversation — cérebro da conversa do agente (WH-1)
//
// Chamado pelo n8n (Conversation flow) com x-worker-secret:
//   action 'reply': mensagem do prospect → modo (ai/human) → rate-limit →
//     contexto rico (persona + ICP + produtos + assets + memória) → GLM
//     (saída JSON estruturada) → persiste memória → escalona/agenda/mídia
//     → resposta (+ áudio TTS se configurado, signed URL). Dedupe por mid.
//   action 'sent': confirmação do n8n após a Evolution enviar a resposta
//     → registra outreach_sent na timeline.
//   action 'error': falha no fluxo → registro silencioso (sem lead se
//     não houver).
// ==========================================

import { serviceClient, corsHeaders } from '../_shared/google.ts';
import { getGenerativeChatAI, hasRealGenerative, type CampaignICP, type AgentPersonality, type LeadTemperature, type ConversationAction, type MediaIntent } from '../_shared/prospecting/ai.ts';
import { getSpeechProvider, hasRealSpeech } from '../_shared/prospecting/speech.ts';
import { normalizePhone } from '../_shared/prospecting/ingest.ts';

const CORS: Record<string, string> = {};
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

const VALID_ENVS = ['sharks_company', 'estrategos'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LeadRow {
  id: string;
  environment: string;
  name: string;
  segment: string | null;
  location: string | null;
  company_size: string | null;
  notes: string | null;
  contact_phone: string | null;
  social_instagram: string | null;
  prospecting_status: string | null;
  prospecting_campaign_id: string | null;
  ai_data: Record<string, unknown> | null;
  jev_memory: Record<string, unknown> | null;
  lead_temperature: string | null;
  conversation_summary: string | null;
  conversation_mode: string | null;
  assigned_human: string | null;
  escalation_reason: string | null;
  last_contact_at: string | null;
  last_inbound_at: string | null;
  rate_window_started_at: string | null;
  rate_count: number | null;
}

async function findLead(
  admin: ReturnType<typeof serviceClient>,
  environment: string,
  contact: { phone?: string | null; social_instagram?: string | null },
): Promise<LeadRow | null> {
  const filters: string[] = [];
  if (contact.phone) filters.push(`contact_phone.eq.${contact.phone}`);
  if (contact.social_instagram) filters.push(`social_instagram.eq.${contact.social_instagram}`);
  if (filters.length === 0) return null;
  const { data } = await admin
    .from('crm_leads')
    .select('id, environment, name, segment, location, company_size, notes, contact_phone, social_instagram, prospecting_status, prospecting_campaign_id, ai_data, jev_memory, lead_temperature, conversation_summary, conversation_mode, assigned_human, escalation_reason, last_contact_at, last_inbound_at, rate_window_started_at, rate_count')
    .eq('environment', environment)
    .or(filters.join(','))
    .limit(1)
    .maybeSingle();
  return (data as unknown as LeadRow) ?? null;
}

async function mergeAiData(admin: ReturnType<typeof serviceClient>, leadId: string, patch: Record<string, unknown>) {
  const { data: cur } = await admin.from('crm_leads').select('ai_data').eq('id', leadId).maybeSingle();
  const base = (((cur as { ai_data?: object } | null)?.ai_data ?? {}) as object);
  await admin.from('crm_leads').update({ ai_data: { ...base, ...patch } }).eq('id', leadId);
}

async function logActivity(admin: ReturnType<typeof serviceClient>, leadId: string, type: string, content: string, metadata?: Record<string, unknown> | null) {
  const { error } = await admin.from('crm_lead_activities').insert({ lead_id: leadId, type, content, metadata: metadata ?? null });
  if (error) console.error('[conversation] atividade falhou:', error.message);
}

/* ─── Rate-limit por lead (janela de 1h, contador em colunas dedicadas) ─── */
function checkRateLimit(lead: LeadRow, limitPerHour: number): { ok: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const windowStart = lead.rate_window_started_at ? new Date(lead.rate_window_started_at).getTime() : 0;
  const count = lead.rate_count ?? 0;
  if (!windowStart || now - windowStart >= 3600_000) return { ok: true }; // janela expirou
  if (count >= limitPerHour) {
    const retryAfterSec = Math.ceil((windowStart + 3600_000 - now) / 1000);
    return { ok: false, retryAfterSec };
  }
  return { ok: true };
}

async function bumpRateCounter(admin: ReturnType<typeof serviceClient>, lead: LeadRow): Promise<void> {
  const now = Date.now();
  const windowStart = lead.rate_window_started_at ? new Date(lead.rate_window_started_at).getTime() : 0;
  const expired = !windowStart || now - windowStart >= 3600_000;
  await admin.from('crm_leads').update({
    rate_window_started_at: expired ? new Date(now).toISOString() : lead.rate_window_started_at,
    rate_count: expired ? 1 : (lead.rate_count ?? 0) + 1,
  }).eq('id', lead.id);
}

/* ─── Persistência de memória do lead (3 camadas: fatos + resumo + histórico bruto) ─── */
async function persistMemory(
  admin: ReturnType<typeof serviceClient>,
  lead: LeadRow,
  memoryUpdate: { temperature?: LeadTemperature; intents?: string[]; objection_handled?: string | null; summary?: string | null } | undefined,
  msgCount: number,
): Promise<{ temperature: LeadTemperature; summary: string | null }> {
  const cur = (lead.jev_memory ?? {}) as Record<string, unknown>;
  const curIntents = Array.isArray(cur.intents) ? (cur.intents as string[]) : [];
  const curObjections = Array.isArray(cur.objections_handled) ? (cur.objections_handled as string[]) : [];
  const newIntents = memoryUpdate?.intents?.length
    ? [...new Set([...curIntents, ...memoryUpdate.intents])].slice(-20)
    : curIntents;
  const newObjections = memoryUpdate?.objection_handled
    ? [...new Set([...curObjections, memoryUpdate.objection_handled])].slice(-20)
    : curObjections;
  const temperature = memoryUpdate?.temperature ?? (lead.lead_temperature as LeadTemperature) ?? 'cold';
  const summary = memoryUpdate?.summary ?? lead.conversation_summary ?? null;

  const patch: Record<string, unknown> = {
    jev_memory: {
      ...cur,
      intents: newIntents,
      objections_handled: newObjections,
      message_count: msgCount,
      last_updated: new Date().toISOString(),
    },
    lead_temperature: temperature,
    conversation_summary: summary,
  };
  await admin.from('crm_leads').update(patch).eq('id', lead.id);
  return { temperature, summary };
}

/* ─── Mídia: escolhe asset do ambiente por media_intent ─── */
async function pickMediaAsset(
  admin: ReturnType<typeof serviceClient>,
  environment: string,
  productIdSet: Set<string>,
  intent: MediaIntent,
): Promise<{ url: string; title: string } | null> {
  if (!intent) return null;
  const typeMap: Record<string, string[]> = {
    social_proof: ['prova_social', 'case', 'depoimento'],
    product_image: ['imagem', 'portfolio', 'demo'],
    pdf: ['pdf', 'material', 'apresentacao'],
  };
  const types = typeMap[intent] ?? [];
  const toUrl = async (v: string): Promise<string | null> => {
    if (/^https?:\/\//.test(v)) return v; // URL externa (não storage)
    const signed = await admin.storage.from('agent-assets').createSignedUrl(v, 3600);
    return signed.data?.signedUrl ?? null;
  };
  try {
    let query = admin
      .from('environment_assets')
      .select('id, type, title, content, file_url, environment_asset_products(product_id)')
      .eq('environment', environment)
      .not('file_url', 'is', null);
    if (types.length) query = query.in('type', types);
    const { data: rows } = await query.limit(10);
    const assets = (rows ?? []) as Array<{ file_url: string | null; title: string | null; environment_asset_products?: Array<{ product_id: string }> }>;
    // prioriza asset vinculado a produto da campanha
    const linked = assets.find(a => (a.environment_asset_products ?? []).some(p => productIdSet.has(p.product_id)) && a.file_url);
    const any = assets.find(a => a.file_url);
    const chosen = linked ?? any;
    if (!chosen?.file_url) return null;
    const url = await toUrl(chosen.file_url);
    return url ? { url, title: chosen.title ?? intent } : null;
  } catch (e) {
    console.error('[conversation] pickMediaAsset falhou:', e);
    return null;
  }
}

async function loadAgentContext(admin: ReturnType<typeof serviceClient>, lead: LeadRow) {
  const settingsRow = await admin
    .from('prospecting_agent_settings')
    .select('personality, params, jev_config')
    .eq('environment', lead.environment)
    .maybeSingle();
  const personality = (settingsRow.data as { personality?: object } | null)?.personality ?? {};
  const jevConfig = ((settingsRow.data as { jev_config?: Record<string, unknown> } | null)?.jev_config ?? {}) as Record<string, unknown>;

  let campaignName: string | undefined;
  let icp: CampaignICP | undefined;
  let products: string[] = [];
  const assets: string[] = [];
  const productIdSet = new Set<string>();

  if (lead.prospecting_campaign_id) {
    const cid = lead.prospecting_campaign_id;
    const { data: camp } = await admin
      .from('prospecting_campaigns')
      .select('name, segment, location, company_size, icp_description')
      .eq('id', cid)
      .maybeSingle();
    if (camp) {
      const c = camp as { name?: string; segment?: string | null; location?: string | null; company_size?: string | null; icp_description?: string | null };
      campaignName = c.name;
      icp = {
        campaign_name: c.name ?? null,
        segment: c.segment ?? null,
        location: c.location ?? null,
        company_size: c.company_size ?? null,
        icp_description: c.icp_description ?? null,
      };
    }
    const { data: prodRows } = await admin
      .from('prospecting_campaign_products')
      .select('product:environment_products(id, name)')
      .eq('campaign_id', cid);
    const links = ((prodRows ?? []) as unknown as Array<{ product?: { id?: string; name?: string } }>);
    products = links.map(r => r.product?.name).filter((n): n is string => !!n);
    for (const r of links) {
      if (r.product?.id) productIdSet.add(r.product.id);
    }
    if (productIdSet.size > 0) {
      const { data: assetRows } = await admin
        .from('environment_asset_products')
        .select('asset:environment_asset_products_asset_id_fkey(title, content, file_url)')
        .in('product_id', [...productIdSet]);
      for (const r of ((assetRows ?? []) as unknown as Array<{ asset?: { title?: string; content?: string; file_url?: string } } | null>)) {
        const a = r?.asset;
        if (!a) continue;
        const parts: string[] = [];
        if (a.title) parts.push(a.title);
        if (a.content) parts.push(a.content.slice(0, 300));
        if (a.file_url) parts.push(`materia: ${a.file_url}`);
        assets.push(parts.join(' — '));
      }
    }
  }

  // histórico recente da timeline
  const { data: acts } = await admin
    .from('crm_lead_activities')
    .select('type, content')
    .eq('lead_id', lead.id)
    .order('created_at', { ascending: false })
    .limit(8);
  const history = ((acts ?? []) as Array<{ type: string; content: string }>)
    .map(a => `${a.type === 'outreach_sent' ? 'enviada' : a.type === 'reply_received' ? 'recebida' : 'registro'}: ${a.content.slice(0, 160)}`)
    .reverse();

  return { personality, campaignName, icp, products, assets, history, jevConfig, productIdSet };
}

/* ─── Voz: mesma esteira do rascunho (agent-voice) — signed URL (bucket privado) ─── */
async function synthesizeReply(
  admin: ReturnType<typeof serviceClient>,
  lead: LeadRow,
  reply: string,
  personality: Record<string, unknown>,
  environment: string,
): Promise<string | null> {
  const voice = (personality as { voice?: { mode?: string; voice_id?: string } }).voice;
  const wantsAudio = voice?.mode === 'audio' || voice?.mode === 'both';
  if (!wantsAudio || !hasRealSpeech()) return null;
  try {
    const audio = await getSpeechProvider().synthesize(reply.slice(0, 800), voice?.voice_id);
    if (!audio) return null;
    const bytes = Uint8Array.from(atob(audio.audioBase64), c => c.charCodeAt(0));
    const path = `${environment}/${lead.id}/conversa-${Date.now()}.mp3`;
    const up = await admin.storage.from('agent-voice').upload(path, bytes, { contentType: audio.mimeType, upsert: true });
    if (up.error) {
      console.error('[conversation] upload voz:', up.error.message);
      return null;
    }
    // bucket é privado → signed URL de 1h para o n8n enviar via Evolution
    const signed = await admin.storage.from('agent-voice').createSignedUrl(path, 3600);
    return signed.data?.signedUrl ?? null;
  } catch (e) {
    console.error('[conversation] TTS falhou (seguindo em texto):', e);
    return null;
  }
}

Deno.serve(async req => {
  Object.assign(CORS, corsHeaders(req));
  try {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return json(405, { error: 'Use POST' });

    const workerSecret = Deno.env.get('WORKER_SECRET');
    const authHeader = req.headers.get('Authorization');
    if (!workerSecret || req.headers.get('x-worker-secret') !== workerSecret) {
      return json(401, { error: 'Worker secret invalido' });
    }
    void authHeader;

    const admin = serviceClient();
    const body = (await req.json().catch(() => null)) as
      | {
          action?: 'reply' | 'sent' | 'error';
          environment?: string;
          channel?: string;
          text?: string;
          mid?: string;
          contact?: { phone?: string; social_instagram?: string };
          lead_id?: string;
        }
      | null;
    if (!body?.environment || !VALID_ENVS.includes(body.environment)) {
      return json(400, { error: 'env invalido' });
    }
    const environment = body.environment;
    const action = body.action ?? 'reply';

    /* ── 'sent': n8n confirma envio → timeline ── */
    if (action === 'sent') {
      if (!body.lead_id || !UUID_RE.test(body.lead_id)) return json(400, { error: 'lead_id invalido' });
      await logActivity(
        admin,
        body.lead_id,
        'outreach_sent',
        body.text
          ? `🤖 Resposta enviada no WhatsApp: ${body.text.slice(0, 300)}`
          : '🤖 Resposta enviada no WhatsApp.',
      );
      return json(200, { ok: true, action: 'sent' });
    }

    /* ── 'reply': mensagem do prospect → resposta do agente ── */
    if (action === 'error') {
      console.error('[conversation] fluxo do n8n reportou erro:', body.text ?? '');
      return json(200, { ok: true, action: 'error' });
    }

    const text = String(body.text ?? '').slice(0, 1000).trim();
    const contact = {
      phone: normalizePhone(body.contact?.phone ?? null),
      social_instagram: body.contact?.social_instagram?.replace(/^@/, '') || null,
    };
    if (!contact.phone && !contact.social_instagram) return json(400, { error: 'Informe contact.phone ou contact.social_instagram' });

    const lead = await findLead(admin, environment, contact);
    if (!lead) return json(404, { error: 'lead_nao_encontrado', detail: 'Cadastra o lead no CRM ou conecta o canal antes de conversar.' });

    // dedupe idempotente por mid (Evolution reenvia em retry)
    const mid = body.mid ? String(body.mid) : '';
    if (mid && typeof (lead.ai_data ?? {}).last_inbound_mid === 'string' && (lead.ai_data as { last_inbound_mid?: string }).last_inbound_mid === mid) {
      return json(200, { ok: true, duplicated: true });
    }
    if (mid) await mergeAiData(admin, lead.id, { last_inbound_mid: mid });

    await logActivity(admin, lead.id, 'reply_received', `💬 WhatsApp do prospect: ${text || '(midia)'}`);
    if (['discovered', 'qualified', 'queued', 'contacted'].includes(lead.prospecting_status ?? '')) {
      await admin.from('crm_leads').update({ prospecting_status: 'replied' }).eq('id', lead.id);
    }

    // ── Modo conversa: human → não responde com IA ──
    const conversationMode = lead.conversation_mode ?? 'ai';
    if (conversationMode === 'human') {
      return json(200, {
        ok: true,
        mode: 'human',
        action: 'skip',
        note: 'Conversa em modo humano — agente IA não respondeu.',
        lead_id: lead.id,
        environment,
      });
    }

    // ── Rate-limit por lead ──
    const ctx = await loadAgentContext(admin, lead);
    const limitPerLead = Number(ctx.jevConfig.rate_limit_per_lead_per_hour ?? 20);
    const rl = checkRateLimit(lead, limitPerLead);
    if (!rl.ok) {
      return json(429, {
        ok: false,
        error: 'rate_limited',
        retry_after_sec: rl.retryAfterSec ?? 3600,
        lead_id: lead.id,
      });
    }

    if (!hasRealGenerative()) {
      await logActivity(admin, lead.id, 'system', 'Falha ao gerar resposta: GLM não configurado.');
      return json(200, { ok: false, error: 'GLM não configurado — defina GLM_API_KEY no Edge' });
    }

    // ── Memória do lead ──
    const mem = (lead.jev_memory ?? {}) as Record<string, unknown>;
    const msgCount = Number(mem.message_count ?? 0) + 1;
    const summaryRefreshEvery = Number(ctx.jevConfig.summary_refresh_every_n_messages ?? 5);
    const refreshSummary = msgCount % summaryRefreshEvery === 0;

    // ── GLM (saída JSON estruturada) ──
    const result = await getGenerativeChatAI().generateConversation({
      lead: { name: lead.name, segment: lead.segment, location: lead.location, company_size: lead.company_size, notes: lead.notes },
      campaignName: ctx.campaignName,
      products: ctx.products,
      personality: (ctx.personality ?? {}) as AgentPersonality,
      icpDescription: ctx.icp?.icp_description ?? null,
      assets: ctx.assets,
      conversationHistory: ctx.history,
      incomingMessage: text,
      memory: {
        temperature: (lead.lead_temperature as LeadTemperature) ?? 'cold',
        intents: Array.isArray(mem.intents) ? (mem.intents as string[]) : undefined,
        objections_handled: Array.isArray(mem.objections_handled) ? (mem.objections_handled as string[]) : undefined,
        summary: lead.conversation_summary ?? null,
        message_count: msgCount - 1,
      },
      refreshSummary,
    });

    // ── Persiste memória ──
    const memSaved = await persistMemory(admin, lead, result.memory, msgCount);
    await bumpRateCounter(admin, lead);
    await admin.from('crm_leads').update({ last_contact_at: new Date().toISOString(), last_inbound_at: new Date().toISOString() }).eq('id', lead.id);

    // ── Áudio (signed URL) ──
    const audioUrl = await synthesizeReply(admin, lead, result.message, ctx.personality, environment);

    // ── Mídia rica (media_intent → asset do ambiente) ──
    let media: { url: string; title: string } | null = null;
    if (result.media_intent) {
      media = await pickMediaAsset(admin, environment, ctx.productIdSet, result.media_intent);
    }

    // ── Escalonamento / agendamento ──
    const convAction: ConversationAction = result.action ?? 'continue';
    const escalateThreshold = Number(ctx.jevConfig.escalate_score_threshold ?? 81);
    let escalated = false;
    let scheduled = false;
    if (convAction === 'escalate') {
      escalated = true;
      await admin.from('crm_leads').update({
        conversation_mode: 'human',
        assigned_human: null,
        escalation_reason: result.escalate_reason ?? 'GLM sinalizou escalonamento',
      }).eq('id', lead.id);
      await logActivity(admin, lead.id, 'system', `🔔 Escalonado para humano: ${result.escalate_reason ?? 'sem motivo detalhado'}`);
    } else if (convAction === 'schedule_meeting') {
      scheduled = true;
      await logActivity(admin, lead.id, 'system', '📅 Lead pediu agendamento — sugerir slots e criar evento no calendário.');
    }

    // ── Atualiza score JEV de forma leve (se score existe, marca temperatura) ──
    // (score JEV completo continua sendo feito pelo worker de discovery/qualificação)

    return json(200, {
      ok: true,
      lead_id: lead.id,
      mode: 'ai',
      reply: result.message,
      audio_url: audioUrl,
      media_url: media?.url ?? null,
      media_title: media?.title ?? null,
      action: convAction,
      escalated,
      scheduled,
      escalate_reason: result.escalate_reason ?? null,
      memory: {
        temperature: memSaved.temperature,
        message_count: msgCount,
        summary: memSaved.summary,
      },
      mid,
      environment,
    });
  } catch (e) {
    console.error('[prospecting-conversation] uncaught:', (e as Error)?.stack || e);
    return json(500, { error: `Erro interno: ${(e as Error)?.message || String(e)}` });
  }
});
