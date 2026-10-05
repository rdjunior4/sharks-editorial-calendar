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
import { getDecisionAI, getGenerativeAI, hasRealAI, type CompanyProfile, type AgentPersonality, type CampaignICP } from '../_shared/prospecting/ai.ts';
import { getSpeechProvider, hasRealSpeech } from '../_shared/prospecting/speech.ts';

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

  const { data: camp } = await admin.from('prospecting_campaigns').select('name, icp_description').eq('id', job.campaign_id).maybeSingle();

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
  const draft = await getGenerativeAI().generateApproach({
    lead: { name: lead.name, segment: lead.segment, location: lead.location, company_size: lead.company_size, notes: lead.notes },
    campaignName: (camp as { name?: string } | null)?.name,
    products,
    personality: settings.personality,
    icpDescription,
    assets,
  });

  // ─── Voz: response_mode=audio/both → TTS → bucket agent-voice → metadata.audio_url ───
  let audioUrl: string | null = null;
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
          audioUrl = admin.storage.from('agent-voice').getPublicUrl(path).data.publicUrl;
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
    audioUrl ? { audio_url: audioUrl, audio_provider: 'elevenlabs' } : null,
  );
  await completeJob(admin, job.id, { subject: draft.subject, message: draft.message, audio_url: audioUrl });
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
    if (Deno.env.get('GOOGLE_PLACES_API_KEY')) {
      const { data: running } = await admin
        .from('prospecting_campaigns')
        .select('id, segment, location, target_count')
        .eq('status', 'running')
        .order('created_at', { ascending: false })
        .limit(10);
      const throttleAt = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      for (const camp of ((running ?? []) as Array<{ id: string; segment: string | null; location: string | null; target_count: number }>)) {
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
          if (!Deno.env.get('GLM_API_KEY')) {
            await failJob(admin, job.id, 'IA generativa não configurada (defina GLM_API_KEY)');
            failed++;
            continue;
          }
          await processGeneration(admin, job, settings, environment);
          generated++;
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

    return json(200, { ok: true, claimed: jobs?.length ?? 0, autoEnqueued, analyzed, generated, discovered, dispatched, failed });
  } catch (e) {
    console.error('[prospecting-run] uncaught:', (e as Error)?.stack || e);
    return json(500, { error: `Erro interno: ${(e as Error)?.message || String(e)}` });
  }
});
