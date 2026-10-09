// ==========================================
// prospecting-run — worker do Prospecting Engine
//
// Chamado pelo pg_cron (a cada 5 min) com x-worker-secret.
// Executa por tipo de job, sempre lendo os parâmetros do agente
// (prospecting_agent_settings) do ambiente da campanha:
//   discover_companies → Google Places (Edge direto, sem n8n)
//   analyze_company / score_company → JEV (decisão) + qualificação automática
//   generate_message → GLM (geração, gate híbrido por fit)
//   enrich_company / send_message / follow_up → despacha ao n8n (F4)
// ==========================================

import { serviceClient, corsHeaders } from '../_shared/google.ts';
import { getDecisionAI, getGenerativeAI, getGenerativeChatAI, hasRealAI, hasRealGenerative, type CompanyProfile, type AgentPersonality, type CampaignICP } from '../_shared/prospecting/ai.ts';
import { getSpeechProvider, hasRealSpeech } from '../_shared/prospecting/speech.ts';
import { normalizePhone } from '../_shared/prospecting/ingest.ts';

const CORS: Record<string, string> = {};
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

interface JobRow {
  id: string;
  campaign_id: string;
  lead_id: string | null;
  type: string;
  status: string;
  input: Record<string, unknown>;
}

interface AgentSettings {
  personality: AgentPersonality;
  params: {
    fit_draft_threshold: number;
    fit_discard_threshold: number;
    confidence_auto: number;
    confidence_review: number;
    max_companies_per_run: number;
    max_messages_per_day: number;
    glm_temperature: number;
    follow_up_days: number;
  };
}

const DEFAULT_PARAMS: AgentSettings['params'] = {
  fit_draft_threshold: 0.75,
  fit_discard_threshold: 0.5,
  confidence_auto: 0.7,
  confidence_review: 0.4,
  max_companies_per_run: 20,
  max_messages_per_day: 50,
  glm_temperature: 0.7,
  follow_up_days: 3,
};

async function loadSettings(admin: ReturnType<typeof serviceClient>, environment: string): Promise<AgentSettings> {
  const { data } = await admin
    .from('prospecting_agent_settings')
    .select('personality, params')
    .eq('environment', environment)
    .maybeSingle();
  const row = (data ?? {}) as { personality?: Partial<AgentPersonality>; params?: Partial<AgentSettings['params']> };
  return {
    personality: { ...(row.personality ?? {}) },
    params: { ...DEFAULT_PARAMS, ...(row.params ?? {}) },
  };
}

async function failJob(admin: ReturnType<typeof serviceClient>, jobId: string, error: string) {
  await admin.from('prospecting_jobs').update({ status: 'failed', error, completed_at: new Date().toISOString() }).eq('id', jobId);
}

async function completeJob(admin: ReturnType<typeof serviceClient>, jobId: string, output: Record<string, unknown>) {
  await admin.from('prospecting_jobs').update({ status: 'completed', output, error: null, completed_at: new Date().toISOString() }).eq('id', jobId);
}

async function logActivity(admin: ReturnType<typeof serviceClient>, leadId: string, type: string, content: string, metadata?: Record<string, unknown>) {
  const { error } = await admin.from('crm_lead_activities').insert({ lead_id: leadId, type, content, metadata: metadata ?? null });
  if (error) console.error('[prospecting-run] atividade falhou:', error.message);
}

/* ─── ICP da campanha — score/geração medem contra o público-alvo ─── */
async function loadCampaignIcp(admin: ReturnType<typeof serviceClient>, campaignId: string): Promise<CampaignICP | undefined> {
  const { data } = await admin
    .from('prospecting_campaigns')
    .select('name, segment, location, company_size, icp_description')
    .eq('id', campaignId)
    .maybeSingle();
  if (!data) return undefined;
  const c = data as { name?: string; segment?: string | null; location?: string | null; company_size?: string | null; icp_description?: string | null };
  return {
    campaign_name: c.name ?? null,
    segment: c.segment ?? null,
    location: c.location ?? null,
    company_size: c.company_size ?? null,
    icp_description: c.icp_description ?? null,
  };
}

/* ─── DECISÃO: analisa o lead com JEV e qualifica automaticamente ─── */
async function processAnalysis(admin: ReturnType<typeof serviceClient>, job: JobRow, settings: AgentSettings, environment: string) {
  const leadId = job.lead_id ?? (typeof job.input?.lead_id === 'string' ? job.input.lead_id : null);
  if (!leadId) throw new Error('Job de análise sem lead_id');

  const { data: lead, error: leadErr } = await admin
    .from('crm_leads')
    .select('id, name, segment, location, company_size, notes, contact_email, contact_phone')
    .eq('id', leadId)
    .maybeSingle();
  if (leadErr) throw new Error(`Buscar lead: ${leadErr.message}`);
  if (!lead) throw new Error('Lead não encontrado para análise');

  const { data: prodRows } = await admin
    .from('prospecting_campaign_products')
    .select('product:environment_products(name)')
    .eq('campaign_id', job.campaign_id);
  const products = ((prodRows ?? []) as Array<{ product?: { name?: string } }>).map(r => r.product?.name).filter((n): n is string => !!n);

  const company: CompanyProfile = {
    name: lead.name,
    segment: lead.segment,
    location: lead.location,
    company_size: lead.company_size,
    signals: (Array.isArray(job.input?.signals) ? job.input.signals : []) as string[],
    notes: lead.notes,
  };

  const icp = await loadCampaignIcp(admin, job.campaign_id);
  const analysis = await getDecisionAI().analyzeCompany(company, products, icp);

  // Qualificação automática conforme parâmetros do ambiente
  const nextStatus = analysis.icpFit >= settings.params.fit_discard_threshold ? 'qualified' : 'discarded';
  const { error: upErr } = await admin
    .from('crm_leads')
    .update({
      ai_fit: analysis.icpFit,
      ai_priority: analysis.priority,
      ai_next_step: analysis.nextAction,
      ai_data: {
        confidence: analysis.confidence,
        product_scores: analysis.productScores,
        rationale: analysis.rationale ?? null,
        provider: getDecisionAI().name,
      },
      ai_analyzed_at: new Date().toISOString(),
      prospecting_status: nextStatus,
      ...(nextStatus === 'discarded' ? { lost_reason: `IA: sem encaixe (fit ${(analysis.icpFit * 100).toFixed(0)}%)` } : {}),
    })
    .eq('id', leadId);
  if (upErr) throw new Error(`Atualizar ai_*: ${upErr.message}`);

  await logActivity(
    admin,
    leadId,
    'system',
    `Score calculado pela IA — fit ${(analysis.icpFit * 100).toFixed(0)}%, prioridade ${analysis.priority}, próximo passo: ${analysis.nextAction.replace(/_/g, ' ')}. Lead ${nextStatus === 'qualified' ? 'qualificado' : 'descartado'}.`,
  );

  // Gate híbrido: fit alto + IA generativa real → rascunho automático
  if (analysis.icpFit >= settings.params.fit_draft_threshold && analysis.nextAction !== 'descartar') {
    await admin.from('prospecting_jobs').insert({
      campaign_id: job.campaign_id,
      lead_id: leadId,
      type: 'generate_message',
      dedupe_key: `draft-${leadId}`,
      input: { icp_fit: analysis.icpFit },
    });
  }

  await completeJob(admin, job.id, {
    icp_fit: analysis.icpFit,
    priority: analysis.priority,
    next_action: analysis.nextAction,
    product_scores: analysis.productScores,
    lead_status: nextStatus,
  });
}

/* ─── GERAÇÃO: rascunho de abordagem com GLM + personalidade ─── */
async function processGeneration(admin: ReturnType<typeof serviceClient>, job: JobRow, settings: AgentSettings, environment: string) {
  const leadId = job.lead_id ?? (typeof job.input?.lead_id === 'string' ? job.input.lead_id : null);
  if (!leadId) throw new Error('Job de geração sem lead_id');

  const { data: lead, error: leadErr } = await admin
    .from('crm_leads')
    .select('id, name, segment, location, company_size, notes, ai_fit')
    .eq('id', leadId)
    .maybeSingle();
  if (leadErr) throw new Error(`Buscar lead: ${leadErr.message}`);
  if (!lead) throw new Error('Lead não encontrado para geração');

  const { data: prodRows } = await admin
    .from('prospecting_campaign_products')
    .select('product:environment_products(id, name)')
    .eq('campaign_id', job.campaign_id);
  const prodLinks = ((prodRows ?? []) as unknown as Array<{ product?: { id?: string; name?: string } }>);
  const products = prodLinks.map(r => r.product?.name).filter((n): n is string => !!n);
  const productIds = prodLinks.map(r => r.product?.id).filter((id): id is string => !!id);

  const { data: camp } = await admin.from('prospecting_campaigns').select('name, icp_description, offer').eq('id', job.campaign_id).maybeSingle();

  // ─── Assets de IA vinculados aos produtos da campanha (075) ───
  const assets: string[] = [];
  if (productIds.length > 0) {
    const { data: assetRows } = await admin
      .from('environment_asset_products')
      .select('asset:environment_asset_products_asset_id_fkey(title, content, file_url)')
      .in('product_id', productIds);
    for (const r of ((assetRows ?? []) as unknown as Array<{ asset?: { title?: string; content?: string; file_url?: string } } | null>)) {
      const a = r?.asset;
      if (!a) continue;
      const parts: string[] = [];
      if (a.title) parts.push(a.title);
      if (a.content) parts.push(a.content.slice(0, 400));
      if (a.file_url) parts.push(`materia: ${a.file_url}`);
      assets.push(parts.join(' — '));
    }
  }

  const icpDescription = (camp as { icp_description?: string | null } | null)?.icp_description ?? null;
  const campaignOffer = (camp as { offer?: string | null } | null)?.offer ?? null;
  const draft = await getGenerativeAI().generateApproach({
    lead: { name: lead.name, segment: lead.segment, location: lead.location, company_size: lead.company_size, notes: lead.notes },
    campaignName: (camp as { name?: string } | null)?.name,
    products,
    personality: settings.personality,
    icpDescription,
    offer: campaignOffer,
    assets,
  });

  // ─── Voz: response_mode=audio/both → TTS → bucket agent-voice (privado, signed URL) → metadata ───
  let audioUrl: string | null = null;
  let audioPath: string | null = null;
  const voice = settings.personality.voice;
  const wantsAudio = voice?.mode === 'audio' || voice?.mode === 'both';
  if (wantsAudio && hasRealSpeech()) {
    try {
      const speechText = draft.message.slice(0, 800);
      const audio = await getSpeechProvider().synthesize(speechText, voice?.voice_id);
      if (audio) {
        const bytes = Uint8Array.from(atob(audio.audioBase64), c => c.charCodeAt(0));
        const path = `${environment}/${leadId}/${job.id}.mp3`;
        const up = await admin.storage.from('agent-voice').upload(path, bytes, { contentType: audio.mimeType, upsert: true });
        if (!up.error) {
          // bucket privado → signed URL de 1h na metadata (player usa audio_path para re-assinar)
          const signed = await admin.storage.from('agent-voice').createSignedUrl(path, 3600);
          audioUrl = signed.data?.signedUrl ?? null;
          audioPath = path;
        } else {
          console.error('[prospecting-run] upload de voz falhou:', up.error.message);
        }
      }
    } catch (voiceErr) {
      console.error('[prospecting-run] TTS falhou (seguindo em modo texto):', voiceErr);
    }
  }

  await logActivity(
    admin,
    leadId,
    'outreach_draft',
    `${draft.subject ? `Assunto: ${draft.subject}\n\n` : ''}${draft.message}`,
    audioUrl ? { audio_url: audioUrl, audio_path: audioPath, audio_provider: 'elevenlabs' } : null,
  );
  await completeJob(admin, job.id, { subject: draft.subject, message: draft.message, audio_url: audioUrl });
}

/* ─── ENVIO: prepara e despacha a mensagem real para o n8n/Evolution ─── */
/* Router espera input.{to, message, audio_url}; callback encerra o job. */
async function processSend(admin: ReturnType<typeof serviceClient>, job: JobRow, environment: string) {
  const leadId = job.lead_id ?? (typeof job.input?.lead_id === 'string' ? job.input.lead_id : null);
  if (!leadId) throw new Error('Job de envio sem lead_id');
  const { data: lead, error: leadErr } = await admin
    .from('crm_leads')
    .select('id, name, contact_phone, conversation_mode')
    .eq('id', leadId)
    .maybeSingle();
  if (leadErr) throw new Error(`Buscar lead: ${leadErr.message}`);
  if (!lead) throw new Error('Lead não encontrado para envio');
  if ((lead as { conversation_mode?: string } | null)?.conversation_mode === 'human') {
    throw new Error('Lead em modo humano — conversa manual, envio automático cancelado');
  }
  const phone = normalizePhone((lead as { contact_phone?: string | null } | null)?.contact_phone ?? null);
  if (!phone) throw new Error('Lead sem telefone válido para envio no WhatsApp');

  // Mensagem: input.message (approve/follow-up) ou último rascunho do lead
  let message = typeof job.input?.message === 'string' ? String(job.input.message) : '';
  let audioPath: string | null = typeof job.input?.audio_path === 'string' ? String(job.input.audio_path) : null;
  if (!message) {
    const { data: draft } = await admin
      .from('crm_lead_activities')
      .select('content, metadata')
      .eq('lead_id', leadId)
      .eq('type', 'outreach_draft')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const content = (draft as { content?: string; metadata?: { audio_path?: string } | null } | null)?.content ?? '';
    if (!content) throw new Error('Nenhum rascunho de abordagem para enviar');
    // Remove o cabeçalho "Assunto: ..." do e-mail-style draft
    const m = content.match(/^Assunto:\s*.+\r?\n\s*([\s\S]*)$/i);
    message = m ? m[1].trim() : content.trim();
    audioPath = ((draft?.metadata as { audio_path?: string } | null)?.audio_path) ?? null;
  }
  if (!message) throw new Error('Mensagem vazia para envio');

  // URL do áudio assinada agora (bucket privado; o n8n baixa imediatamente)
  let audioUrl: string | null = null;
  if (audioPath) {
    try {
      const signed = await admin.storage.from('agent-voice').createSignedUrl(audioPath, 3600);
      audioUrl = signed.data?.signedUrl ?? null;
    } catch (e) {
      console.error('[prospecting-run] assinar áudio falhou:', e);
    }
  }

  // Prefixo do país se faltar (Evolution espera DDI no jid)
  const to = phone.length >= 12 ? phone : `55${phone}`;

  // Guard: lead já respondeu? → não mandar por cima da conversa
  const { data: sentRecent } = await admin
    .from('crm_lead_activities')
    .select('id', { count: 'exact', head: true })
    .eq('lead_id', leadId)
    .eq('type', 'outreach_sent')
    .limit(1);
  if ((sentRecent as unknown as { length?: number } | null)?.length) {
    throw new Error('Lead já recebeu abordagem nesta esteira (dedupe de envio)');
  }

  const enrichedPayload = {
    job_id: job.id, type: 'send_message', campaign_id: job.campaign_id, lead_id: leadId,
    input: { ...job.input, message, to, audio_url: audioUrl, channel: 'whatsapp' },
  };
  const n8nUrl = Deno.env.get('N8N_WEBHOOK_URL');
  if (!n8nUrl) throw new Error('Integrador externo (n8n) não configurado — defina N8N_WEBHOOK_URL');
  await fetch(n8nUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-worker-secret': Deno.env.get('WORKER_SECRET') ?? '' },
    body: JSON.stringify(enrichedPayload),
  });
  // permanece 'processing' até o callback
}

/* ─── FOLLOW-UP: toque suave para lead sem resposta ─── */
async function processFollowUp(admin: ReturnType<typeof serviceClient>, job: JobRow, settings: AgentSettings, environment: string) {
  const leadId = job.lead_id ?? (typeof job.input?.lead_id === 'string' ? job.input.lead_id : null);
  if (!leadId) throw new Error('Job de follow-up sem lead_id');
  const { data: lead, error: leadErr } = await admin
    .from('crm_leads')
    .select('id, name, contact_phone, conversation_mode, conversation_summary, lead_temperature, prospecting_status, ai_data')
    .eq('id', leadId)
    .maybeSingle();
  if (leadErr) throw new Error(`Buscar lead: ${leadErr.message}`);
  if (!lead) throw new Error('Lead não encontrado para follow-up');
  const row = lead as { prospecting_status?: string; conversation_mode?: string };
  if (row.conversation_mode === 'human') {
    throw new Error('Lead em modo humano — follow-up cancelado (time cuida)');
  }
  if (row.prospecting_status !== 'contacted') {
    throw new Error(`Follow-up só para status contacted (atual: ${row.prospecting_status ?? '—'})`);
  }

  const icp = await loadCampaignIcp(admin, job.campaign_id);
  const result = await getGenerativeChatAI().generateConversation({
    lead: { name: (lead as { name?: string }).name ?? '' },
    campaignName: icp?.campaign_name,
    products: [],
    personality: settings.personality,
    icpDescription: icp?.icp_description ?? null,
    conversationHistory: [],
    incomingMessage: '(toque de follow-up: este lead não respondeu o primeiro contato; faça um toque leve e curto reabrindo a conversa, sem repetir o conteúdo original)',
    memory: {
      temperature: ((lead as { lead_temperature?: string | null }).lead_temperature === 'hot' || (lead as { lead_temperature?: string | null }).lead_temperature === 'warm')
        ? ((lead as { lead_temperature?: string | null }).lead_temperature as 'warm' | 'hot')
        : 'cold',
      summary: (lead as { conversation_summary?: string | null }).conversation_summary ?? null,
      message_count: 1,
    },
  });

  await admin.from('prospecting_jobs').insert({
    campaign_id: job.campaign_id,
    lead_id: leadId,
    type: 'send_message',
    dedupe_key: `send-${leadId}-${Date.now()}`,
    input: { message: sanitizeOutbound(result.message), source: 'follow_up', follow_up_job: job.id },
    scheduled_at: new Date(Date.now() + 60 * 1000).toISOString(),
  });
  await completeJob(admin, job.id, { followup_message: result.message });
}

/** remove linhas tipo "resposta mock" / reforço do guard de prompt */
function sanitizeOutbound(text: string): string {
  return text.replace(/\(resposta mock[^)]*\)/gi, '').trim().slice(0, 1000);
}

/* ─── MASS DISPATCH: coordenador do disparo da campanha ─── */
async function processMass(admin: ReturnType<typeof serviceClient>, job: JobRow, settings: AgentSettings, environment: string) {
  const { data: camp, error: campErr } = await admin
    .from('prospecting_campaigns')
    .select('name, automation_level, status')
    .eq('id', job.campaign_id)
    .maybeSingle();
  if (campErr) throw new Error(`Buscar campanha: ${campErr.message}`);
  if (!camp) throw new Error('Campanha não encontrada para disparo');
  const campaign = camp as { name?: string; automation_level?: string; status?: string };
  if (campaign.status !== 'running') throw new Error(`Campanha não está running (${campaign.status ?? '—'})`);
  const level = campaign.automation_level ?? 'assisted';

  const { data: leadRows } = await admin
    .from('crm_leads')
    .select('id, name, contact_phone, conversation_mode, ai_data')
    .eq('prospecting_campaign_id', job.campaign_id)
    .eq('prospecting_status', 'qualified')
    .not('contact_phone', 'is', null)
    .neq('conversation_mode', 'human')
    .order('ai_fit', { ascending: false })
    .limit(200);
  const candidates = ((leadRows ?? []) as unknown as Array<{
    id: string; name: string; contact_phone: string | null; ai_data: Record<string, unknown> | null;
  }>).filter(l => normalizePhone(l.contact_phone));
  if (candidates.length === 0) {
    await completeJob(admin, job.id, { note: 'Nenhum lead qualificado com telefone na fila do disparo', candidates: 0 });
    return;
  }

  // Já respondidos / já enviados → fora
  const ids = candidates.map(l => l.id);
  const { data: actRows } = await admin
    .from('crm_lead_activities')
    .select('lead_id, type')
    .in('lead_id', ids);
  const sentSet = new Set<string>();
  const draftedSet = new Set<string>();
  for (const a of ((actRows ?? []) as Array<{ lead_id: string; type: string }>)) {
    if (a.type === 'outreach_sent') sentSet.add(a.lead_id);
    if (a.type === 'outreach_draft') draftedSet.add(a.lead_id);
  }

  // Cap diário: sends completos hoje + pendentes na fila
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const { count: completedToday } = await admin
    .from('prospecting_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('type', 'send_message')
    .eq('status', 'completed')
    .gte('completed_at', todayStart.toISOString());
  const { count: pendingSends } = await admin
    .from('prospecting_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('type', 'send_message')
    .in('status', ['pending', 'processing', 'retry']);
  let slack = settings.params.max_messages_per_day
    - (completedToday ?? 0) - (pendingSends ?? 0);

  let sendEnqueued = 0;
  let draftEnqueued = 0;
  let skippedCount = 0;
  const staggerMs = 45 * 1000;

  // Regra semi_auto: só dispara sozinho após a primeira mensagem da campanha ter sido aprovada
  let campaignHasFirstSend = false;
  for (const l of candidates) {
    if (sentSet.has(l.id)) { campaignHasFirstSend = true; break; }
  }

  for (const l of candidates) {
    if (sentSet.has(l.id)) { skippedCount++; continue; }
    if (!draftedSet.has(l.id)) {
      // sem rascunho: gera primeiro (auto/semi_auto); assisted espera rascunho da esteira normal
      const { error: genErr } = await admin.from('prospecting_jobs').insert({
        campaign_id: job.campaign_id,
        lead_id: l.id,
        type: 'generate_message',
        dedupe_key: `draft-${l.id}`,
        input: { icp_fit: null, from_mass: true },
      });
      if (!genErr) draftEnqueued++;
      continue;
    }
    const autoSend =
      level === 'auto' ||
      (level === 'semi_auto' && campaignHasFirstSend);
    if (!autoSend || slack <= 0) { skippedCount++; continue; }
    const scheduledAt = new Date(Date.now() + sendEnqueued * staggerMs + 30 * 1000).toISOString();
    const { error: sendErr } = await admin.from('prospecting_jobs').insert({
      campaign_id: job.campaign_id,
      lead_id: l.id,
      type: 'send_message',
      dedupe_key: `send-${l.id}`,
      input: { from_mass: true, mass_job: job.id },
      scheduled_at: scheduledAt,
    });
    if (sendErr) {
      console.error('[prospecting-run] enqueue send (mass):', sendErr.message);
      skippedCount++;
      continue;
    }
    sendEnqueued++;
    slack--;
  }

  await completeJob(admin, job.id, {
    campaign: campaign.name ?? job.campaign_id,
    automation_level: level,
    candidates: candidates.length,
    sent_already: sentSet.size,
    send_enqueued: sendEnqueued,
    draft_enqueued: draftEnqueued,
    skipped: skippedCount,
    daily_cap_slack: Math.max(0, slack),
  });
}

/* ─── DESCOBERTA: Google Places direto do Edge (sem n8n) ─── */
async function processDiscovery(admin: ReturnType<typeof serviceClient>, job: JobRow, settings: AgentSettings, environment: string) {
  const apiKey = Deno.env.get('GOOGLE_PLACES_API_KEY');
  if (!apiKey) throw new Error('GOOGLE_PLACES_API_KEY não configurada (defina no Edge para o discovery funcionar)');

  const input = (job.input ?? {}) as { query?: string; segment?: string; location?: string };
  const textQuery = input.query || [input.segment, input.location].filter(Boolean).join(' em ') || 'empresas';
  const max = Math.min(settings.params.max_companies_per_run, 20);

  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ textQuery, pageSize: max, languageCode: 'pt-BR' }),
  });
  if (!res.ok) throw new Error(`Places falhou (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as {
    places?: Array<{ id: string; displayName?: { text?: string }; formattedAddress?: string; nationalPhoneNumber?: string; websiteUri?: string }>;
  };
  const places = (body.places ?? []).slice(0, settings.params.max_companies_per_run);

  let created = 0;
  let skipped = 0;
  const details: Array<{ name: string; phone: string | null; website: string | null }> = [];

  for (const p of places) {
    const name = p.displayName?.text?.trim();
    if (!name) { skipped++; continue; }
    const phone = (p.nationalPhoneNumber ?? '').replace(/\D/g, '') || null;

    // Dedup por telefone OU nome exato dentro do ambiente
    const filters: string[] = [];
    if (phone) filters.push(`contact_phone.eq.${phone}`);
    filters.push(`name.eq.${name.replace(/'/g, "''")}`);
    const { data: existing } = await admin
      .from('crm_leads')
      .select('id')
      .eq('environment', environment)
      .or(filters.join(','))
      .limit(1)
      .maybeSingle();
    if (existing) { skipped++; continue; }

    const { data: nl, error: insErr } = await admin
      .from('crm_leads')
      .insert({
        environment,
        name,
        contact_phone: phone,
        source: 'google_places',
        origin: 'prospecting_agent',
        prospecting_status: 'discovered',
        prospecting_campaign_id: job.campaign_id,
        notes: p.formattedAddress ?? null,
      })
      .select('id')
      .single();
    if (insErr) { console.error('[prospecting-run] criar lead descoberto:', insErr.message); skipped++; continue; }

    await logActivity(admin, nl.id as string, 'system', `Lead descoberto pelo agente via Google Places (campanha).`);
    await admin.from('prospecting_jobs').insert({
      campaign_id: job.campaign_id,
      lead_id: nl.id as string,
      type: 'score_company',
      dedupe_key: nl.id as string,
      input: { lead_id: nl.id },
    });
    details.push({ name, phone, website: p.websiteUri ?? null });
    created++;
  }

  await completeJob(admin, job.id, { query: textQuery, found: places.length, created, skipped, details });
}

Deno.serve(async req => {
  Object.assign(CORS, corsHeaders(req));
  try {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return json(405, { error: 'Use POST' });

    const workerSecret = Deno.env.get('WORKER_SECRET');
    if (!workerSecret || req.headers.get('x-worker-secret') !== workerSecret) {
      return json(401, { error: 'Worker secret invalido' });
    }

    const admin = serviceClient();

    // 1. Reencolar jobs travados em processing (> 15 min sem callback)
    const stuckBefore = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    await admin
      .from('prospecting_jobs')
      .update({ status: 'retry', error: 'Timeout do processador' })
      .eq('status', 'processing')
      .lt('started_at', stuckBefore);

    // 2. Auto-loop: campanhas running com meta não batida → discovery sozinho
    let autoEnqueued = 0;
    let massEnqueued = 0;
    let followupsEnqueued = 0;
    const settingsCache = new Map<string, AgentSettings>();
    const loadCached = async (env: string) => {
      if (!settingsCache.has(env)) settingsCache.set(env, await loadSettings(admin, env));
      return settingsCache.get(env)!;
    };
    if (Deno.env.get('GOOGLE_PLACES_API_KEY')) {
      const { data: running } = await admin
        .from('prospecting_campaigns')
        .select('id, environment, segment, location, target_count')
        .eq('status', 'running')
        .order('created_at', { ascending: false })
        .limit(10);
      const throttleAt = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      for (const camp of ((running ?? []) as Array<{ id: string; environment: string; segment: string | null; location: string | null; target_count: number }>)) {
        if (!camp.segment && !camp.location) continue; // sem o que buscar
        // meta já batida?
        const { count: found } = await admin
          .from('crm_leads')
          .select('id', { count: 'exact', head: true })
          .eq('prospecting_campaign_id', camp.id);
        if ((found ?? 0) >= camp.target_count) continue;
        // job ativo ou discovery recente (throttle 15 min — concluído OU falho)?
        const { count: active } = await admin
          .from('prospecting_jobs')
          .select('id', { count: 'exact', head: true })
          .eq('campaign_id', camp.id)
          .eq('type', 'discover_companies')
          .in('status', ['pending', 'processing', 'retry']);
        if ((active ?? 0) > 0) continue;
        const { count: recent } = await admin
          .from('prospecting_jobs')
          .select('id', { count: 'exact', head: true })
          .eq('campaign_id', camp.id)
          .eq('type', 'discover_companies')
          .in('status', ['completed', 'failed'])
          .gte('completed_at', throttleAt);
        if ((recent ?? 0) > 0) continue;
        const { error: enqErr } = await admin.from('prospecting_jobs').insert({
          campaign_id: camp.id,
          type: 'discover_companies',
          dedupe_key: `auto-discover-${camp.id}-${Date.now()}`, // único por enfileiramento (uq é global)
          input: { segment: camp.segment, location: camp.location },
        });
        if (enqErr) console.error('[prospecting-run] auto-discovery enqueue falhou:', enqErr.message);
        else autoEnqueued++;
      }
    }

    // 2b. Disparo em massa auto: campanhas semi_auto/auto → 1 mass_dispatch por dia
    //     (assisted depende de aprovação manual — nada automático)
    {
      const { data: runningAll } = await admin
        .from('prospecting_campaigns')
        .select('id, environment, automation_level')
        .eq('status', 'running')
        .in('automation_level', ['semi_auto', 'auto'])
        .order('created_at', { ascending: false })
        .limit(10);
      const today = new Date().toISOString().slice(0, 10); // UTC — janela diária estável
      for (const camp of ((runningAll ?? []) as Array<{ id: string; environment: string; automation_level: string }>)) {
        const { count: active } = await admin
          .from('prospecting_jobs')
          .select('id', { count: 'exact', head: true })
          .eq('campaign_id', camp.id)
          .eq('type', 'mass_dispatch')
          .in('status', ['pending', 'processing', 'retry']);
        if ((active ?? 0) > 0) continue;
        const dayKey = `mass-auto-${camp.id}-${today}`;
        const { count: todayDone } = await admin
          .from('prospecting_jobs')
          .select('id', { count: 'exact', head: true })
          .eq('campaign_id', camp.id)
          .eq('type', 'mass_dispatch')
          .eq('dedupe_key', dayKey);
        if ((todayDone ?? 0) > 0) continue;
        const { error: enqErr } = await admin.from('prospecting_jobs').insert({
          campaign_id: camp.id,
          type: 'mass_dispatch',
          dedupe_key: dayKey,
          input: { trigger: 'auto' },
        });
        if (enqErr) console.error('[prospecting-run] auto-mass enqueue falhou:', enqErr.message);
        else massEnqueued++;
      }
    }

    // 2c. Reaquecimento: follow-up para contacted sem resposta há follow_up_days
    {
      const now = Date.now();
      const { data: runningAll } = await admin
        .from('prospecting_campaigns')
        .select('id, environment')
        .eq('status', 'running')
        .order('created_at', { ascending: false })
        .limit(10);
      for (const camp of ((runningAll ?? []) as Array<{ id: string; environment: string }>)) {
        const s = await loadCached(camp.environment);
        const cutoff = new Date(now - s.params.follow_up_days * 86400000).toISOString();
        const { data: dueLeads } = await admin
          .from('crm_leads')
          .select('id, ai_data')
          .eq('prospecting_campaign_id', camp.id)
          .eq('prospecting_status', 'contacted')
          .eq('conversation_mode', 'ai')
          .not('contact_phone', 'is', null)
          .lt('last_contact_at', cutoff)
          .limit(10);
        for (const lead of ((dueLeads ?? []) as Array<{ id: string; ai_data: Record<string, unknown> | null }>)) {
          const fuCount = Number((lead.ai_data ?? {}).fu_count ?? 0);
          if (fuCount >= 3) continue; // esgota em 3 toques — humano assume nutrição
          const hasPending = await admin
            .from('prospecting_jobs')
            .select('id', { count: 'exact', head: true })
            .eq('campaign_id', camp.id)
            .eq('lead_id', lead.id)
            .eq('type', 'follow_up')
            .in('status', ['pending', 'processing', 'retry', 'completed'])
            .gte('created_at', cutoff);
          if ((hasPending.count ?? 0) > 0) continue;
          const { error: fuErr } = await admin.from('prospecting_jobs').insert({
            campaign_id: camp.id,
            lead_id: lead.id,
            type: 'follow_up',
            dedupe_key: `fu-${lead.id}-${fuCount + 1}`,
            input: { trigger: 'auto', fu_count: fuCount + 1 },
          });
          if (fuErr) continue;
          followupsEnqueued++;
          await admin.from('crm_leads').update({ ai_data: { ...(lead.ai_data ?? {}), fu_count: fuCount + 1 } }).eq('id', lead.id);
        }
      }
    }

    // 3. Claim atômico (FOR UPDATE SKIP LOCKED na função)
    const { data: jobs, error: claimErr } = await admin.rpc('claim_prospecting_jobs', { p_limit: 10 });
    if (claimErr) throw new Error(`Claim: ${claimErr.message}`);

    let analyzed = 0;
    let generated = 0;
    let discovered = 0;
    let dispatched = 0;
    let failed = 0;

    for (const job of ((jobs ?? []) as unknown as JobRow[])) {
      try {
        const { data: camp } = await admin
          .from('prospecting_campaigns')
          .select('environment')
          .eq('id', job.campaign_id)
          .maybeSingle();
        const environment = (camp as { environment?: string } | null)?.environment ?? 'sharks_company';
        const settings = await loadSettings(admin, environment);

        if (job.type === 'analyze_company' || job.type === 'score_company') {
          if (!hasRealAI()) {
            await failJob(admin, job.id, 'IA de decisão não configurada (defina TYPESAFE_API_KEY e AI_PROVIDER=jev)');
            failed++;
            continue;
          }
          await processAnalysis(admin, job, settings, environment);
          analyzed++;
        } else if (job.type === 'generate_message') {
          if (!hasRealGenerative()) {
            await failJob(admin, job.id, 'IA generativa não configurada (defina GLM_API_KEY)');
            failed++;
            continue;
          }
          await processGeneration(admin, job, settings, environment);
          generated++;
        } else if (job.type === 'send_message') {
          await processSend(admin, job, environment);
          dispatched++;
        } else if (job.type === 'follow_up') {
          if (!hasRealGenerative()) {
            await failJob(admin, job.id, 'IA generativa não configurada (defina GLM_API_KEY)');
            failed++;
            continue;
          }
          await processFollowUp(admin, job, settings, environment);
          generated++;
        } else if (job.type === 'mass_dispatch') {
          await processMass(admin, job, settings, environment);
          dispatched++; // coordenador conclui na hora (fila de sends é per-lead)
        } else if (job.type === 'discover_companies') {
          await processDiscovery(admin, job, settings, environment);
          discovered++;
        } else {
          // I/O externo (enrich/send_message/follow_up) → n8n (F4)
          const n8nUrl = Deno.env.get('N8N_WEBHOOK_URL');
          if (!n8nUrl) {
            await failJob(admin, job.id, 'Integrador externo (n8n) não configurado — defina N8N_WEBHOOK_URL');
            failed++;
            continue;
          }
          await fetch(n8nUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-worker-secret': workerSecret },
            body: JSON.stringify({ job_id: job.id, type: job.type, campaign_id: job.campaign_id, lead_id: job.lead_id, input: job.input }),
          });
          dispatched++; // permanece 'processing' até o callback
        }
      } catch (jobErr) {
        console.error('[prospecting-run] job falhou:', jobErr);
        await failJob(admin, job.id, jobErr instanceof Error ? jobErr.message : String(jobErr));
        failed++;
      }
    }

    return json(200, { ok: true, claimed: jobs?.length ?? 0, autoEnqueued, massEnqueued, followupsEnqueued, analyzed, generated, discovered, dispatched, failed });
  } catch (e) {
    console.error('[prospecting-run] uncaught:', (e as Error)?.stack || e);
    return json(500, { error: `Erro interno: ${(e as Error)?.message || String(e)}` });
  }
});
