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
import { verifyWorker } from '../_shared/auth.ts';
import { sendLeadInstagramDm, logInstagramDmSent } from '../_shared/instagram.ts';
import { sendEmail, prospectionEmail } from '../_shared/email.ts';
import { loadWhatsAppConnection, sendWAtext, sendWAaudio, sendWAtemplate, logWhatsAppSent } from '../_shared/whatsapp.ts';

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
  jevConfig: Record<string, unknown>;
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
    .select('personality, params, jev_config')
    .eq('environment', environment)
    .maybeSingle();
  const row = (data ?? {}) as { personality?: Partial<AgentPersonality>; params?: Partial<AgentSettings['params']>; jev_config?: Record<string, unknown> };
  return {
    personality: { ...(row.personality ?? {}) },
    params: { ...DEFAULT_PARAMS, ...(row.params ?? {}) },
    jevConfig: row.jev_config ?? {},
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
    // Enriquecimento (M2): o resumo do site/CNPJ entra como nota para a JEV reavaliar
    notes: [lead.notes, typeof job.input?.research === 'string' ? String(job.input.research) : '']
      .filter(Boolean).join(' — ') || lead.notes,
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
      input: { icp_fit: analysis.icp_fit ?? analysis.icpFit },
    });
  } else if (
    !job.input?.from_enrich &&
    analysis.icpFit < settings.params.fit_draft_threshold &&
    analysis.nextAction !== 'descartar'
  ) {
    // M2: fit no meio (49–74%) → enriquece com o site (BrasilAPI/Firecrawl) e re-analisa 1x
    const { count: enrichTried } = await admin
      .from('prospecting_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', job.campaign_id)
      .eq('lead_id', leadId)
      .eq('type', 'enrich_company');
    if ((enrichTried ?? 0) === 0) {
      await admin.from('prospecting_jobs').insert({
        campaign_id: job.campaign_id,
        lead_id: leadId,
        type: 'enrich_company',
        dedupe_key: `enrich-${leadId}`,
        input: { lead_id: leadId, icp_fit: analysis.icpFit },
      });
    }
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

/* ─── ENVIO: roteia pelo canal da campanha (WH WhatsApp / IG DM / e-mail) ───
   Campanha escolhe canais; o contato do lead decide qual usar primeiro.
   WhatsApp → n8n/Evolution (callback encerra) · IG → API oficial (inline) ·
   e-mail → Resend (inline). */

interface DraftContent {
  subject: string | null;
  message: string;
  audioPath: string | null;
}

async function loadLatestDraft(admin: ReturnType<typeof serviceClient>, leadId: string): Promise<DraftContent | null> {
  const { data: draft } = await admin
    .from('crm_lead_activities')
    .select('content, metadata')
    .eq('lead_id', leadId)
    .eq('type', 'outreach_draft')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const content = (draft as { content?: string; metadata?: { audio_path?: string } | null } | null)?.content ?? '';
  if (!content) return null;
  const m = content.match(/^Assunto:\s*(.+)\r?\n\s*([\s\S]*)$/i);
  return {
    subject: m ? m[1].trim() : null,
    message: m ? m[2].trim() : content.trim(),
    audioPath: ((draft?.metadata as { audio_path?: string } | null)?.audio_path) ?? null,
  };
}

/** WhatsApp → n8n/Evolution (permanece 'processing' até callback) */
async function sendViaWhatsapp(admin: ReturnType<typeof serviceClient>, job: JobRow, leadId: string, message: string, audioPath: string | null): Promise<void> {
  let audioUrl: string | null = null;
  if (audioPath) {
    try {
      const signed = await admin.storage.from('agent-voice').createSignedUrl(audioPath, 3600);
      audioUrl = signed.data?.signedUrl ?? null;
    } catch (e) {
      console.error('[prospecting-run] assinar áudio falhou:', e);
    }
  }
  const n8nUrl = Deno.env.get('N8N_WEBHOOK_URL');
  if (!n8nUrl) throw new Error('Integrador externo (n8n) não configurado — defina N8N_WEBHOOK_URL');
  await fetch(n8nUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-worker-secret': Deno.env.get('WORKER_SECRET') ?? '' },
    body: JSON.stringify({ job_id: job.id, type: 'send_message', campaign_id: job.campaign_id, lead_id: leadId,
      input: { ...job.input, message, to: leadToPhone(admin, leadId), audio_url: audioUrl, channel: 'whatsapp' } }),
  });
}

async function leadToPhone(admin: ReturnType<typeof serviceClient>, leadId: string): Promise<string> {
  const { data: lead } = await admin.from('crm_leads').select('contact_phone').eq('id', leadId).maybeSingle();
  const phone = normalizePhone((lead as { contact_phone?: string | null } | null)?.contact_phone ?? null);
  if (!phone) throw new Error('Lead sem telefone válido para WhatsApp');
  return phone.length >= 12 ? phone : `55${phone}`;
}

/** WhatsApp Cloud (oficial): janela 24h → free-form; senão → template frio */
async function sendViaCloud(admin: ReturnType<typeof serviceClient>, job: JobRow, leadId: string, environment: string, lead: { last_inbound_at?: string | null }, message: string, audioPath: string | null): Promise<void> {
  const conn = await loadWhatsAppConnection(admin, environment);
  if (!conn) throw new Error('WhatsApp Cloud não conectado neste ambiente — conecte no Agente ou use Evolution');
  let audioUrl: string | null = null;
  if (audioPath) {
    try {
      const signed = await admin.storage.from('agent-voice').createSignedUrl(audioPath, 3600);
      audioUrl = signed.data?.signedUrl ?? null;
    } catch (e) {
      console.error('[prospecting-run] assinar áudio falhou:', e);
    }
  }
  const to = await leadToPhone(admin, leadId);
  const windowUntil = lead.last_inbound_at ? Date.parse(lead.last_inbound_at) + 24 * 3600 * 1000 : 0;
  const inWindow = Date.now() < windowUntil;

  const res = inWindow && audioUrl
    ? await sendWAaudio(conn, to, audioUrl)
    : inWindow
    ? await sendWAtext(conn, to, message)
    : await sendWAtemplate(conn, to, message);

  if (res.ok) {
    await logWhatsAppSent(admin, leadId, inWindow ? 'Resposta WhatsApp (oficial)' : 'Mensagem template WhatsApp (oficial)', message);
    if (['discovered', 'qualified', 'queued'].includes(String((lead as { prospecting_status?: string }).prospecting_status ?? ''))) {
      await admin.from('crm_leads').update({ prospecting_status: 'contacted', last_contact_at: new Date().toISOString() }).eq('id', leadId);
    }
    await completeJob(admin, job.id, { channel: 'whatsapp_cloud', wamid: res.wamid, in_window: inWindow });
    return;
  }
  if (res.error_code === 'invalid_number') {
    // Mesma mecânica do M4 — descarta o lead (sem follow-up)
    await admin
      .from('crm_leads')
      .update({ prospecting_status: 'discarded', lost_reason: `Número sem WhatsApp (oficial): ${res.detail?.slice(0, 120) ?? ''}` })
      .eq('id', leadId);
    await admin.from('crm_lead_activities').insert({
      lead_id: leadId,
      type: 'system',
      content: '📵 Número não é WhatsApp válido (API oficial) — lead descartado.',
    });
    throw new Error(`Número inexistente no WhatsApp: ${res.detail ?? ''}`);
  }
  throw new Error(`WhatsApp Cloud falhou (${res.error_code ?? 'send_fail'}): ${res.detail ?? ''}`);
}

async function processSend(admin: ReturnType<typeof serviceClient>, job: JobRow, environment: string, campaignChannels: string[], jevConfig: Record<string, unknown>) {
  const leadId = job.lead_id ?? (typeof job.input?.lead_id === 'string' ? job.input.lead_id : null);
  if (!leadId) throw new Error('Job de envio sem lead_id');
  const { data: lead, error: leadErr } = await admin
    .from('crm_leads')
    .select('id, name, contact_phone, contact_email, social_instagram, conversation_mode, prospecting_status, ai_data, prospecting_campaign_id, last_inbound_at')
    .eq('id', leadId)
    .maybeSingle();
  if (leadErr) throw new Error(`Buscar lead: ${leadErr.message}`);
  if (!lead) throw new Error('Lead não encontrado para envio');
  const row = lead as {
    id: string; name: string; contact_phone: string | null; contact_email: string | null; social_instagram: string | null;
    conversation_mode: string | null; prospecting_status: string | null; ai_data: Record<string, unknown> | null; prospecting_campaign_id: string | null;
  };
  if (row.conversation_mode === 'human') {
    throw new Error('Lead em modo humano — conversa manual, envio automático cancelado');
  }

  // Mensagem: input.message (approve/follow-up) ou último rascunho do lead
  let message = typeof job.input?.message === 'string' ? String(job.input.message) : '';
  let subject: string | null = null;
  let audioPath: string | null = typeof job.input?.audio_path === 'string' ? String(job.input.audio_path) : null;
  if (!message) {
    const draft = await loadLatestDraft(admin, leadId);
    if (!draft) throw new Error('Nenhum rascunho de abordagem para enviar');
    message = draft.message;
    subject = draft.subject;
    audioPath = draft.audioPath;
  }
  if (!message) throw new Error('Mensagem vazia para envio');

  // Guard: lead já recebeu abordagem nesta esteira (dedupe de envio)
  const { data: sentRecent } = await admin
    .from('crm_lead_activities')
    .select('id', { count: 'exact', head: true })
    .eq('lead_id', leadId)
    .eq('type', 'outreach_sent')
    .limit(1);
  if (((sentRecent as unknown as { count?: number } | null)?.count ?? 0) > 0) {
    throw new Error('Lead já recebeu abordagem nesta esteira (dedupe de envio)');
  }

  // ─── Resolução de canal: campanha marca; contato do lead viabiliza ───
  const channels = campaignChannels.length
    ? campaignChannels
    : ['whatsapp', 'instagram', 'email']; // campanha sem canal marcado → qualquer um
  const campaignFallback = !campaignChannels.length;

  if ((channels.includes('whatsapp') || campaignFallback) && normalizePhone(row.contact_phone)) {
    // ── Transporte WhatsApp: jev_config.whatsapp_priority = 'auto' (padrão:
    //    Cloud quando conectado E janela ativa — grátis e oficial; senão
    //    Evolution) | 'cloud' | 'evolution' ──
    const priority = String(jevConfig.whatsapp_priority ?? 'auto');
    const cloudConn = await loadWhatsAppConnection(admin, environment);
    const windowUntil = row.last_inbound_at ? Date.parse(row.last_inbound_at) + 24 * 3600 * 1000 : 0;
    const inWindow = Date.now() < windowUntil;

    if (cloudConn && (priority === 'cloud' || (priority === 'auto' && inWindow))) {
      await admin.from('prospecting_jobs').update({ input: { ...job.input, message, channel: 'whatsapp_cloud' } }).eq('id', job.id);
      await sendViaCloud(admin, { ...job, input: { ...job.input, message, channel: 'whatsapp_cloud' } }, leadId, environment, row, message, audioPath);
      return;
    }
    if (priority === 'cloud' && !cloudConn) {
      throw new Error('whatsapp_priority=cloud, mas WhatsApp Cloud não conectado no ambiente');
    }
    await admin.from('prospecting_jobs').update({ input: { ...job.input, message, channel: 'whatsapp' } }).eq('id', job.id);
    await sendViaWhatsapp(admin, { ...job, input: { ...job.input, message, channel: 'whatsapp' } }, leadId, message, audioPath);
    return; // callback encerra o job
  }

  if ((channels.includes('instagram') || campaignFallback) && row.social_instagram) {
    const ig = await sendLeadInstagramDm(admin,
      { id: row.id, environment, social_instagram: row.social_instagram, prospecting_status: row.prospecting_status, ai_data: row.ai_data as { ig_sid?: string } | null },
      message);
    if (!ig.ok) {
      throw new Error(ig.error_code === 'no_window'
        ? 'Instagram: sem janela de conversa (lead precisa interagir antes) — DM vai para o gatilho'
        : `Envio DM falhou (${ig.status}): ${ig.detail ?? ''}`);
    }
    await logInstagramDmSent(admin, leadId, message, null);
    if (['discovered', 'qualified', 'queued'].includes(String(row.prospecting_status ?? ''))) {
      await admin.from('crm_leads').update({ prospecting_status: 'contacted', last_contact_at: new Date().toISOString() }).eq('id', leadId);
    }
    await completeJob(admin, job.id, { channel: 'instagram', sent_to: ig.sent_to });
    return;
  }

  if ((channels.includes('email') || campaignFallback) && (row.contact_email ?? '').includes('@')) {
    const mail = prospectionEmail({ leadName: row.name, subject, message });
    const sent = await sendEmail({ to: row.contact_email!, subject: mail.subject, html: mail.html });
    if (!sent.ok) throw new Error(`E-mail não enviado: ${sent.error ?? 'Resend indisponível'}`);
    const { error: actErr } = await admin.from('crm_lead_activities').insert({
      lead_id: leadId,
      type: 'outreach_sent',
      content: `🤖 E-mail enviado pela esteira do agente:\n${message.slice(0, 280)}`,
    });
    if (actErr) console.error('[prospecting-run] atividade email:', actErr.message);
    if (['discovered', 'qualified', 'queued'].includes(String(row.prospecting_status ?? ''))) {
      await admin.from('crm_leads').update({ prospecting_status: 'contacted', last_contact_at: new Date().toISOString() }).eq('id', leadId);
    }
    await completeJob(admin, job.id, { channel: 'email', sent_to: row.contact_email });
    return;
  }

  const missing: string[] = [];
  if (channels.includes('whatsapp') && !normalizePhone(row.contact_phone)) missing.push('telefone (WhatsApp)');
  if (channels.includes('instagram') && !row.social_instagram) missing.push('@Instagram');
  if (channels.includes('email') && !(row.contact_email ?? '').includes('@')) missing.push('e-mail');
  throw new Error(`Nenhum canal envio do lead compatível com a campanha — faltando: ${missing.join(', ') || '(canal?)'}`);
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
async function processMass(admin: ReturnType<typeof serviceClient>, job: JobRow, settings: AgentSettings, environment: string, campaignChannels: string[]) {
  const { data: camp, error: campErr } = await admin
    .from('prospecting_campaigns')
    .select('name, automation_level, status, channels')
    .eq('id', job.campaign_id)
    .maybeSingle();
  if (campErr) throw new Error(`Buscar campanha: ${campErr.message}`);
  if (!camp) throw new Error('Campanha não encontrada para disparo');
  const campaign = camp as { name?: string; automation_level?: string; status?: string };
  if (campaign.status !== 'running') throw new Error(`Campanha não está running (${campaign.status ?? '—'})`);
  const level = campaign.automation_level ?? 'assisted';

  const { data: leadRows } = await admin
    .from('crm_leads')
    .select('id, name, contact_phone, contact_email, social_instagram, conversation_mode, ai_data')
    .eq('prospecting_campaign_id', job.campaign_id)
    .eq('prospecting_status', 'qualified')
    .neq('conversation_mode', 'human')
    .or('contact_phone.not.is.null,contact_email.not.is.null,social_instagram.not.is.null')
    .order('ai_fit', { ascending: false })
    .limit(200);
  // candidatos escolhidos: tem contato compatível com os canais da campanha
  const wants = (c: string) => campaignChannels.length === 0 || campaignChannels.includes(c);
  const candidates = ((leadRows ?? []) as unknown as Array<{
    id: string; name: string; contact_phone: string | null; contact_email: string | null; social_instagram: string | null; ai_data: Record<string, unknown> | null;
  }>).filter(l =>
    (wants('whatsapp') && normalizePhone(l.contact_phone)) ||
    (wants('instagram') && l.social_instagram) ||
    (wants('email') && (l.contact_email ?? '').includes('@')),
  );
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

/* ─── ENRIQUECIMENTO (M2): resumo do site/CNPJ → website_summary → re-análise ─── */
async function processEnrich(admin: ReturnType<typeof serviceClient>, job: JobRow, settings: AgentSettings, environment: string) {
  const leadId = job.lead_id ?? (typeof job.input?.lead_id === 'string' ? job.input.lead_id : null);
  if (!leadId) throw new Error('Job de enriquecimento sem lead_id');

  const { data: lead, error: leadErr } = await admin
    .from('crm_leads')
    .select('id, name, segment, location, environment, notes')
    .eq('id', leadId)
    .maybeSingle();
  if (leadErr) throw new Error(`Buscar lead: ${leadErr.message}`);
  if (!lead) throw new Error('Lead não encontrado para enriquecimento');
  const row = lead as { id: string; name: string; segment: string | null; location: string | null; environment: string; notes: string | null };

  let researched = '';
  let source = '';

  // 1) CNPJ no input/notes → BrasilAPI (sem custo)
  const cnpj = (String(job.input?.cnpj ?? '') + ' ' + String(row.notes ?? '')).match(/\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/)?.[0]?.replace(/\D/g, '');
  if (cnpj && cnpj.length === 14) {
    try {
      const res = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
      if (res.ok) {
        const c = await res.json() as {
          razao_social?: string; descricao_atividade?: string; cnae_fiscal_descricao?: string; municipio?: string; uf?: string; ddd_telefone_1?: string;
        };
        researched = [
          c.razao_social ? `Razão social: ${c.razao_social}` : '',
          (c.descricao_atividade || c.cnae_fiscal_descricao) ? `Atividade: ${c.descricao_atividade ?? c.cnae_fiscal_descricao}` : '',
          (c.municipio || c.uf) ? `Cidade: ${c.municipio ?? ''}/${c.uf ?? ''}` : '',
          c.ddd_telefone_1 ? `Telefone registrado: ${c.ddd_telefone_1}` : '',
        ].filter(Boolean).join(' · ');
        source = 'brasilapi';
      }
    } catch (e) {
      console.error('[prospecting-run] BrasilAPI falhou:', e);
    }
  }

  // 2) Sem CNPJ → Firecrawl do site (notes contém URL do discovery) / pesquisa por nome
  if (!researched) {
    const fireKey = Deno.env.get('FIRECRAWL_API_KEY');
    if (fireKey) {
      const siteUrl = (row.notes ?? '').startsWith('http') ? row.notes : null;
      try {
        const scrapeUrl = siteUrl ?? null;
        if (scrapeUrl) {
          const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${fireKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: scrapeUrl, formats: ['markdown'], onlyMainContent: true }),
          });
          if (res.ok) {
            const jb = await res.json() as { data?: { markdown?: string } };
            researched = (jb.data?.markdown ?? '').slice(0, 1200);
            source = 'firecrawl_site';
          }
        } else {
          const res = await fetch('https://api.firecrawl.dev/v2/search', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${fireKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query: [row.name, row.segment, row.location].filter(Boolean).join(' ') + ' o que faz a empresa',
              limit: 3,
              scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
            }),
          });
          if (res.ok) {
            const jb = await res.json() as { data?: { web?: Array<{ title?: string; description?: string; markdown?: string }> } };
            researched = (jb.data?.web ?? []).map(d => `${d.title ?? ''}: ${d.description ?? (d.markdown ?? '').slice(0, 300)}`).join(' | ').slice(0, 1200);
            source = 'firecrawl_search';
          }
        }
      } catch (e) {
        console.error('[prospecting-run] Firecrawl enrich falhou:', e);
      }
    }
  }

  if (!researched) {
    // Sem fonte disponível — não é falha da esteira: registra e conclui
    await logActivity(admin, leadId, 'system', 'Enriquecimento indisponível (sem CNPJ e Firecrawl não configurado) — seguindo com os dados atuais.');
    await completeJob(admin, job.id, { source: null, note: 'sem fonte de enriquecimento' });
    return;
  }

  const summary = researched.slice(0, 1200);
  await logActivity(admin, leadId, 'system', `🔎 Lead enriquecido via ${source} — re-análise agendada.`);
  await completeJob(admin, job.id, { source, chars: summary.length });

  // Re-análise única com o resumo (dedupe própria impede loop: from_enrich=true)
  await admin.from('prospecting_jobs').insert({
    campaign_id: job.campaign_id,
    lead_id: leadId,
    type: 'analyze_company',
    dedupe_key: `analyze-enrich-${leadId}`,
    input: { lead_id: leadId, from_enrich: true, research: summary },
  });
}

/* ─── DESCOBERTA: roteia por fornecedor — Places / Firecrawl / auto ─── */
async function processDiscovery(
  admin: ReturnType<typeof serviceClient>,
  job: JobRow,
  settings: AgentSettings,
  environment: string,
  provider: string,
): Promise<void> {
  const hasPlaces = !!Deno.env.get('GOOGLE_PLACES_API_KEY');
  const hasFirecrawl = !!Deno.env.get('FIRECRAWL_API_KEY');

  const usePlaces =
    provider === 'places' ||
    (provider === 'auto' && (hasPlaces || !hasFirecrawl));

  if (!usePlaces) {
    await processDiscoveryFirecrawl(admin, job, settings, environment);
    return;
  }
  try {
    await processDiscoveryPlaces(admin, job, settings, environment);
  } catch (e) {
    if (provider === 'auto' && hasFirecrawl) {
      console.error('[prospecting-run] Places falhou — fallback Firecrawl:', e);
      await processDiscoveryFirecrawl(admin, job, settings, environment);
      return;
    }
    throw e;
  }
}

/* ─── DESCOBERTA: Firecrawl — busca web + scrape dos sites (sem Places) ─── */
interface FirecrawlSearchDoc {
  title?: string;
  url?: string;
  description?: string;
  markdown?: string;
}

function extractBrazilPhones(text: string): string[] {
  const out = new Set<string>();
  const re = /\(?\d{2}\)?[\s-]?9?\d{4}[\s-]?\d{4}|\+55\s?\d{10,13}/g;
  for (const m of text.matchAll(re)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 10) out.add(digits);
  }
  return [...out];
}

function extractEmails(text: string): string[] {
  const out = new Set<string>();
  const re = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  for (const m of text.matchAll(re)) {
    if (/\.(png|jpe?g|webp|gif|css|js)$/i.test(m[0])) continue;
    out.add(m[0].toLowerCase());
  }
  return [...out];
}

async function processDiscoveryFirecrawl(admin: ReturnType<typeof serviceClient>, job: JobRow, settings: AgentSettings, environment: string) {
  const apiKey = Deno.env.get('FIRECRAWL_API_KEY');
  if (!apiKey) throw new Error('FIRECRAWL_API_KEY não configurada (defina no Edge para descoberta via Firecrawl)');

  const input = (job.input ?? {}) as { query?: string; segment?: string; location?: string };
  const segment = input.segment ?? '';
  const location = input.location ?? '';
  const query = input.query || [segment, location].filter(Boolean).join(' ') + ' contato telefone site' || 'empresas contato';
  const limit = Math.min(Math.ceil(settings.params.max_companies_per_run / 2), 10);

  const res = await fetch('https://api.firecrawl.dev/v2/search', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      limit,
      scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
    }),
  });
  if (!res.ok) throw new Error(`Firecrawl falhou (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { data?: { web?: FirecrawlSearchDoc[] } };
  const docs = (body.data?.web ?? []).slice(0, settings.params.max_companies_per_run);

  let created = 0;
  let skipped = 0;
  const details: Array<{ name: string; phone: string | null; email: string | null; url: string | null }> = [];

  for (const doc of docs) {
    const name = (doc.title ?? '').split(/[|\-–·]/)[0]?.trim();
    const url = doc.url ?? null;
    if (!name) { skipped++; continue; }
    const content = `${doc.description ?? ''}\n${(doc.markdown ?? '').slice(0, 4000)}`;
    const phones = extractBrazilPhones(content);
    const emails = extractEmails(content);
    if (phones.length === 0 && emails.length === 0) { skipped++; continue; }

    const phone = phones[0] ?? null;
    const email = emails.find(e => !/noreply|no-reply|webmaster|abuse/i.test(e)) ?? null;
    if (!phone && !email) { skipped++; continue; }

    // Dedupe por telefone OU nome exato dentro do ambiente
    const filters: string[] = [];
    if (phone) filters.push(`contact_phone.eq.${phone}`);
    if (email) filters.push(`contact_email.eq.${email}`);
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
        contact_email: email,
        source: 'firecrawl',
        origin: 'prospecting_agent',
        prospecting_status: 'discovered',
        prospecting_campaign_id: job.campaign_id,
        notes: url,
      })
      .select('id')
      .single();
    if (insErr) { console.error('[prospecting-run] criar lead firecrawl:', insErr.message); skipped++; continue; }

    await logActivity(admin, nl.id as string, 'system', `Lead descoberto pelo agente via busca web (Firecrawl).`);
    await admin.from('prospecting_jobs').insert({
      campaign_id: job.campaign_id,
      lead_id: nl.id as string,
      type: 'score_company',
      dedupe_key: nl.id as string,
      input: { lead_id: nl.id },
    });
    details.push({ name, phone, email, url });
    created++;
  }

  await completeJob(admin, job.id, { query, found: docs.length, created, skipped, details, provider: 'firecrawl' });
}

/* ─── DESCOBERTA: Google Places direto do Edge (sem n8n) ─── */
async function processDiscoveryPlaces(admin: ReturnType<typeof serviceClient>, job: JobRow, settings: AgentSettings, environment: string) {
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

    const rawBody = await req.text();
    const auth = await verifyWorker(req, rawBody);
    if (!auth.ok) return json(auth.status, { error: auth.error });

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
          .select('environment, channels, discovery_provider')
          .eq('id', job.campaign_id)
          .maybeSingle();
        const environment = (camp as { environment?: string } | null)?.environment ?? 'sharks_company';
        const channels = ((camp as { channels?: string[] | null } | null)?.channels ?? []) as string[];
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
          await processSend(admin, job, environment, channels, settings.jevConfig);
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
          await processMass(admin, job, settings, environment, channels);
          dispatched++; // coordenador conclui na hora (fila de sends é per-lead)
        } else if (job.type === 'enrich_company') {
          await processEnrich(admin, job, settings, environment);
          analyzed++;
        } else if (job.type === 'discover_companies') {
          const provider = (camp as { discovery_provider?: string } | null)?.discovery_provider ?? 'auto';
          await processDiscovery(admin, job, settings, environment, provider);
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
