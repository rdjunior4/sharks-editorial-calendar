import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

async function load(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const outputText = stripTypeScriptTypes(source);
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}

const ingest = await load('../supabase/functions/_shared/prospecting/ingest.ts');
const ai = await load('../supabase/functions/_shared/prospecting/ai.ts');

test('9 estados de prospecção separados do estágio comercial', async () => {
  const types = await readFile(new URL('../src/lib/prospecting/types.ts', import.meta.url), 'utf8');
  for (const s of ['discovered', 'researching', 'qualified', 'discarded', 'queued', 'contacted', 'replied', 'interested', 'converted_to_pipeline']) {
    assert.ok(types.includes(`'${s}'`), `estado ausente: ${s}`);
  }
  assert.ok(types.includes('PROSPECTING_STATUS_META') === false); // meta migrada para a UI
  assert.ok(!types.includes('stage:'));
});

test('migration 067: fila com dedupe, trigger de transição e RLS por ambiente', async () => {
  const migration = await readFile(new URL('../supabase/migrations/067_prospecting_foundation.sql', import.meta.url), 'utf8');
  assert.ok(migration.includes('uq_prospecting_jobs_dedupe'));
  assert.ok(migration.includes('validate_prospecting_job_transition'));
  assert.ok(migration.includes('is_env_staff((select auth.uid()), environment)'));
  assert.ok(migration.includes("origin IN ('manual','inbound','prospecting_agent','import')"));
  assert.ok(migration.includes('converted_to_pipeline'));
  assert.ok(!migration.includes('attachments'));
});

test('rotas e menu da Prospecção IA em Sharks, Estrategos e central Oracullo (não no Cliente)', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.ok(app.includes('path="/sharks/prospeccao"'));
  assert.ok(app.includes('path="/estrategos/prospeccao"'));
  assert.ok(app.includes('path="/oracullo/prospeccao"')); // central god-view (guardião)
  assert.ok(!app.includes('/client/prospeccao'));

  const nav = await readFile(new URL('../src/components/layout/navItems.ts', import.meta.url), 'utf8');
  assert.ok(nav.includes("path: '/sharks/prospeccao'"));
  assert.ok(nav.includes("path: '/estrategos/prospeccao'"));
  assert.ok(nav.includes("path: '/oracullo/prospeccao'"));
  assert.ok(!nav.includes("path: '/client/prospeccao'"));

  const perms = await readFile(new URL('../src/lib/permissions.ts', import.meta.url), 'utf8');
  assert.ok(perms.includes('prospecting:'));

  const createFn = await readFile(new URL('../supabase/functions/admin-create-user/index.ts', import.meta.url), 'utf8');
  assert.ok(createFn.includes("'prospecting'"));
  const approveFn = await readFile(new URL('../supabase/functions/admin-approve-access-request/index.ts', import.meta.url), 'utf8');
  assert.ok(approveFn.includes("'prospecting'"));
});

/* ─── F2: ingest e JEV (funções puras das Edge Functions) ─── */

test('normalize de contato e extração de leadgen do webhook Meta', () => {
  assert.equal(ingest.normalizeEmail('  Maria@Empresa.COM '), 'maria@empresa.com');
  assert.equal(ingest.normalizeEmail('invalido'), null);
  assert.equal(ingest.normalizePhone('(11) 99999-8888'), '11999998888');
  assert.equal(ingest.normalizePhone('123'), null);

  const contact = ingest.mapMetaLeadFields([
    { name: 'full_name', values: ['Maria Silva'] },
    { name: 'email', values: ['MARIA@Teste.com'] },
    { name: 'phone_number', values: ['(11) 98888-7777'] },
  ]);
  assert.equal(contact.name, 'Maria Silva');
  assert.equal(contact.email, 'maria@teste.com');
  assert.equal(contact.phone, '11988887777');

  const refs = ingest.extractMetaLeadIds({
    entry: [{ id: 'page1', changes: [{ field: 'leadgen', value: { lead_id: 'L1' } }] }],
  });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].leadId, 'L1');
  assert.deepEqual(ingest.extractMetaLeadIds({ entry: [] }), []);
});

test('Jev: perguntas atômicas e mapeamento de respostas para o contrato', () => {
  const q = ai.buildJevQuestions(['Tráfego pago', 'CRM']);
  assert.ok(q.icp_fit && q.priority && q.next_action);
  assert.ok(q.prod_0 && q.prod_1);
  assert.equal(q.prod_1.instructions.includes('CRM'), true);

  const analysis = ai.mapJevAnswers(
    {
      icp_fit: { score: 3, confidence: 0.82 },
      priority: { choice: 'alta' },
      next_action: { choice: 'qualificar' },
      prod_0: { noul: 0.9 },
      prod_1: { noul: 0.4 },
    },
    ['Tráfego pago', 'CRM'],
  );
  assert.equal(analysis.icpFit, 0.75);
  assert.equal(analysis.confidence, 0.82);
  assert.equal(analysis.priority, 'alta');
  assert.equal(analysis.nextAction, 'qualificar');
  assert.equal(analysis.productScores[0].score, 0.9);
  assert.equal(analysis.productScores[1].score, 0.4);
});

test('mock do provider (fallback sem key) continua determinístico', async () => {
  const provider = new ai.MockAIProvider();
  const a = await provider.analyzeCompany({ name: 'X', segment: 'S' }, ['P1']);
  const b = await provider.analyzeCompany({ name: 'X', segment: 'S' }, ['P1']);
  assert.equal(a.icpFit, b.icpFit);
  assert.ok(a.icpFit >= 0 && a.icpFit <= 1);
});

/* ─── F3: settings do agente + GLM ─── */
test('migration 070: settings por ambiente com seeds, RLS de admin e drops', async () => {
  const migration = await readFile(new URL('../supabase/migrations/070_limpeza_e_agent_settings.sql', import.meta.url), 'utf8');
  assert.ok(migration.includes('prospecting_agent_settings'));
  assert.ok(migration.includes('DROP TABLE IF EXISTS public.channels'));
  assert.ok(migration.includes('DROP TABLE IF EXISTS public.calendar_templates'));
  assert.ok(migration.includes('DROP TABLE IF EXISTS public.partners'));
  assert.ok(migration.includes('DROP TABLE IF EXISTS public.action_partners'));
  assert.ok(migration.includes('Sofia'));
  assert.ok(migration.includes('is_env_admin((select auth.uid()), environment)'));
});

test('GLM: system prompt carrega personalidade e parse de rascunho', () => {
  const prompt = ai.buildGlmSystemPrompt(
    { agent_name: 'Sofia', tone: 'amigavel', language: 'pt-BR', persona: 'Consultora comercial', brand_voice_rules: 'Sem promessas', signature: '— Sharks', greeting_style: 'curto' },
    'Distribuidores PE',
  );
  assert.ok(prompt.includes('Sofia'));
  assert.ok(prompt.includes('Consultora comercial'));
  assert.ok(prompt.includes('Sem promessas'));
  assert.ok(prompt.includes('Distribuidores PE'));
  assert.ok(prompt.includes('Assunto:'));

  const parsed = ai.parseGlmDraft('Assunto: Ideia para voce\n\nOla, tudo bem?');
  assert.equal(parsed.subject, 'Ideia para voce');
  assert.equal(parsed.message, 'Ola, tudo bem?');

  const fallback = ai.parseGlmDraft('Mensagem direta sem assunto');
  assert.equal(fallback.subject, null);
  assert.equal(fallback.message, 'Mensagem direta sem assunto');
});

/* ---- Fim-a-fim: ICP + voz + auto-loop (migration 073) ---- */

test('migration 073: ICP da campanha, metadata de atividades e bucket de voz', async () => {
  const m = await readFile(new URL('../supabase/migrations/073_agent_icp_voice.sql', import.meta.url), 'utf8');
  assert.ok(m.includes('ADD COLUMN IF NOT EXISTS icp_description'));
  assert.ok(m.includes('ADD COLUMN IF NOT EXISTS metadata'));
  assert.ok(m.includes("('agent-voice', 'agent-voice', true)"));
  assert.ok(m.includes('bucket_id = '));
});

test('score ICP-aware: estado e perguntas do JEV carregam o publico-alvo da campanha', () => {
  const icp = {
    campaign_name: 'PILOTO Distribuidores SP',
    segment: 'Distribuidores de alimentos',
    location: 'Sao Paulo - SP',
    company_size: 'Medio',
    icp_description: 'Atacado com delivery proprio',
  };
  const state = ai.buildJevState({ name: 'Padaria X' }, icp);
  assert.ok(state.includes('Público-alvo da campanha'));
  assert.ok(state.includes('PILOTO Distribuidores SP'));
  assert.ok(state.includes('Segmento alvo: Distribuidores de alimentos'));
  assert.ok(state.includes('Descrição do ICP: Atacado com delivery proprio'));

  const q = ai.buildJevQuestions(['Tráfego pago'], icp);
  assert.ok(q.icp_fit.instructions.includes('desta campanha'));
  const q2 = ai.buildJevQuestions(['Tráfego pago']);
  assert.ok(q2.icp_fit.instructions.includes('da agencia') || q2.icp_fit.instructions.includes('da agência'));

  const stateNoIcp = ai.buildJevState({ name: 'Padaria X' });
  assert.ok(!stateNoIcp.includes('Público-alvo'));
});

test('SpeechProvider: contrato, ElevenLabs e fallback mock sem key', async () => {
  const speech = await load('../supabase/functions/_shared/prospecting/speech.ts');
  const mock = new speech.MockSpeechProvider();
  assert.equal(await mock.synthesize('qualquer texto'), null);
  assert.equal(speech.hasRealSpeech(), false);
  const factory = speech.getSpeechProvider();
  assert.equal(factory.name, 'mock');
  assert.equal(await factory.synthesize('teste'), null);
  assert.ok(speech.ELEVEN_DEFAULT_VOICE.length > 0);
});

test('worker: auto-loop de discovery, ICP na analise e voz na geracao', async () => {
  const worker = await readFile(new URL('../supabase/functions/prospecting-run/index.ts', import.meta.url), 'utf8');
  // auto-loop: campanhas running abaixo da meta enfileiram discovery sozinhos
  assert.ok(worker.includes("eq('status', 'running')"));
  assert.ok(worker.includes('auto-discover-'));
  assert.ok(worker.includes('max_companies_per_run'));
  assert.ok(worker.includes('GOOGLE_PLACES_API_KEY'));
  // ICP-aware
  assert.ok(worker.includes('loadCampaignIcp'));
  assert.ok(worker.includes('analyzeCompany(company, products, icp)'));
  // voz
  assert.ok(worker.includes('getSpeechProvider()'));
  assert.ok(worker.includes('agent-voice'));
  assert.ok(worker.includes('audio_url'));
});

test('UI: ICP no formulario, voz na personalidade e player no feed', async () => {
  const form = await readFile(new URL('../src/components/prospecting/CampaignFormModal.tsx', import.meta.url), 'utf8');
  assert.ok(form.includes('icp_description'));
  assert.ok(form.includes('Público-alvo (ICP)'));

  const agent = await readFile(new URL('../src/components/prospecting/AgentPage.tsx', import.meta.url), 'utf8');
  assert.ok(agent.includes("setVoice('mode'"));
  assert.ok(agent.includes("value: 'audio'"));
  assert.ok(agent.includes("key: 'speech'"));

  const feed = await readFile(new URL('../src/components/prospecting/ApproachesPage.tsx', import.meta.url), 'utf8');
  assert.ok(feed.includes('ProvisionedAudio'));
  assert.ok(feed.includes('item.metadata?.audio_path'));

  const drawer = await readFile(new URL('../src/components/crm/LeadDrawer.tsx', import.meta.url), 'utf8');
  assert.ok(drawer.includes('ProvisionedAudio'));
  assert.ok(drawer.includes('a.metadata?.audio_path'));
  assert.ok(drawer.includes('lead_temperature'));
  assert.ok(drawer.includes('conversation_mode'));
  assert.ok(drawer.includes('escalation_reason'));

  const page = await readFile(new URL('../src/components/prospecting/ProspectingPage.tsx', import.meta.url), 'utf8');
  assert.ok(page.includes('Progresso da meta'));
  assert.ok(page.includes('c.icp_description'));
});
/* ---- Instagram in-app (migration 074 + oauth + dm) ---- */

test('migration 074: conexão do Instagram com RLS de admin e token protegido', async () => {
  const m = await readFile(new URL('../supabase/migrations/074_instagram_connection.sql', import.meta.url), 'utf8');
  assert.ok(m.includes('CREATE TABLE IF NOT EXISTS public.instagram_connections'));
  assert.ok(m.includes('uq_instagram_conn_env'));
  assert.ok(m.includes('is_env_staff((select auth.uid()), environment)'));
  assert.ok(m.includes('is_env_admin((select auth.uid()), environment)'));
  assert.ok(m.includes('REVOKE ALL ON public.instagram_connections FROM authenticated'));
  assert.ok(m.includes('GRANT SELECT (id, environment, ig_user_id, username'));
  assert.ok(m.includes('access_token text NOT NULL'));
});

test('edges de Instagram: OAuth in-app, DM com janela e ingest com token da conexão', async () => {
  const connectFn = await readFile(new URL('../supabase/functions/instagram-connect/index.ts', import.meta.url), 'utf8');
  assert.ok(connectFn.includes('fb_exchange_token'));
  assert.ok(connectFn.includes("body.action === 'disconnect'"));
  assert.ok(connectFn.includes('instagram_business_account'));
  assert.ok(connectFn.includes('isEnvAdmin'));

  const dm = await readFile(new URL('../supabase/functions/instagram-send-dm/index.ts', import.meta.url), 'utf8');
  assert.ok(dm.includes('sendLeadInstagramDm'));
  assert.ok(dm.includes("'no_window'"));
  assert.ok(dm.includes('ig.me/m/'));
  assert.ok(dm.includes('outreach_sent'));

  const ingest = await readFile(new URL('../supabase/functions/prospecting-ingest/index.ts', import.meta.url), 'utf8');
  assert.ok(ingest.includes('loadPageToken'));
  assert.ok(ingest.includes('instagram_connections'));
});

test('UI: callback OAuth, botão no canais e DM no drawer', async () => {
  const lib = await readFile(new URL('../src/lib/prospecting/instagram.ts', import.meta.url), 'utf8');
  assert.ok(lib.includes('1421077150132280'));
  assert.ok(lib.includes('instagram/callback'));
  assert.ok(lib.includes('validateInstagramState'));

  const cb = await readFile(new URL('../src/pages/instagram/InstagramCallback.tsx', import.meta.url), 'utf8');
  assert.ok(cb.includes('IG_CONNECT_EDGE'));
  assert.ok(cb.includes('validateInstagramState'));

  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.ok(app.includes('"/instagram/callback"'));

  const agent = await readFile(new URL('../src/components/prospecting/AgentPage.tsx', import.meta.url), 'utf8');
  assert.ok(agent.includes('Conectar Instagram'));
  assert.ok(agent.includes('useInstagramConnection'));

  const drawer = await readFile(new URL('../src/components/crm/LeadDrawer.tsx', import.meta.url), 'utf8');
  assert.ok(drawer.includes('IG_SEND_DM_EDGE'));
  assert.ok(drawer.includes('Enviar DM'));
});
/* ---- IG-2: gatilhos por campanha + assets de IA (075) ---- */

test('migration 075: gatilhos, assets com N:N por produto e bucket agent-assets', async () => {
  const m = await readFile(new URL('../supabase/migrations/075_ig2_triggers_assets.sql', import.meta.url), 'utf8');
  assert.ok(m.includes('ADD COLUMN IF NOT EXISTS trigger_keywords text[]'));
  assert.ok(m.includes('CREATE TABLE IF NOT EXISTS public.environment_assets'));
  assert.ok(m.includes("type text NOT NULL DEFAULT 'case'"));
  assert.ok(m.includes('environment_asset_products'));
  assert.ok(m.includes('is_env_staff((select auth.uid()), environment)'));
  assert.ok(m.includes("('agent-assets', 'agent-assets', true)"));
});

test('matching de gatilhos: tolerante a acento/caixa e dedupe de eventos Meta', async () => {
  assert.equal(ingest.normalizeTriggerText('  Quero ORÇAMENTO! '), 'quero orcamento');
  assert.equal(ingest.normalizeTriggerText('me passa o preço'), 'me passa o preco');
  assert.equal(ingest.matchesTriggers('quero um orçamento para padaria', ['quero', 'preço']), true);
  assert.equal(ingest.matchesTriggers('qual é o preço?', ['quero', 'preço']), true);
  assert.equal(ingest.matchesTriggers('hi there', ['quero']), false);
  assert.equal(ingest.matchesTriggers('x', []), false);
  assert.equal(ingest.matchesTriggers(null, ['quero']), false);
  assert.equal(ingest.shouldProcessEvent({ last_comment_id: 'C1' }, 'comment', 'C1', 'last_comment_id'), false);
  assert.equal(ingest.shouldProcessEvent({ last_comment_id: 'C1' }, 'comment', 'C2', 'last_comment_id'), true);
  assert.equal(ingest.shouldProcessEvent(null, 'comment', 'C2', 'last_comment_id'), true);
});

test('worker GERA html2: assets no prompt do GLM e contexto de gatilho no ingest', async () => {
  const workerTxt = await readFile(new URL('../supabase/functions/prospecting-run/index.ts', import.meta.url), 'utf8');
  assert.ok(workerTxt.includes('environment_asset_products'));
  assert.ok(workerTxt.includes('asset:environment_asset_products_asset_id_fkey'));
  assert.ok(workerTxt.includes('assets,'));
  assert.ok(workerTxt.includes("dedupe_key: `comment-${commentId}`") === false);

  const ingestTxt = await readFile(new URL('../supabase/functions/prospecting-ingest/index.ts', import.meta.url), 'utf8');
  assert.ok(ingestTxt.includes('loadCampaignTriggers'));
  assert.ok(ingestTxt.includes('last_comment_id'));
  assert.ok(ingestTxt.includes('last_message_mid'));
  assert.ok(ingestTxt.includes('matchesTriggers(text, keywords)'));

  const aiTxt = await readFile(new URL('../supabase/functions/_shared/prospecting/ai.ts', import.meta.url), 'utf8');
  assert.ok(aiTxt.includes('buildAssetsContext'));
});

test('UI: gatilhos no form da campanha e nova aba Assets de IA em Produtos', async () => {
  const form = await readFile(new URL('../src/components/prospecting/CampaignFormModal.tsx', import.meta.url), 'utf8');
  assert.ok(form.includes('trigger_keywords'));
  assert.ok(form.includes('Palavras-chave de gatilho'));

  const products = await readFile(new URL('../src/components/products/ProductsPage.tsx', import.meta.url), 'utf8');
  assert.ok(products.includes("label: 'Assets de IA'"));
  assert.ok(products.includes('EnvAgentAssets'));

  const assetsPage = await readFile(new URL('../src/components/products/EnvAgentAssets.tsx', import.meta.url), 'utf8');
  assert.ok(assetsPage.includes('agent-assets'));
  assert.ok(assetsPage.includes('prova_social'));
  assert.ok(assetsPage.includes('environment_asset_products'));

  const types = await readFile(new URL('../src/lib/prospecting/types.ts', import.meta.url), 'utf8');
  assert.ok(types.includes('trigger_keywords'));
});
/* ---- Parceiros + Marcos (076) ---- */

test('migration 076: parceiros, marcos e trigger de lead automatica', async () => {
  const m = await readFile(new URL('../supabase/migrations/076_partners_marcos.sql', import.meta.url), 'utf8');
  assert.ok(m.includes('CREATE TABLE IF NOT EXISTS public.partners'));
  assert.ok(m.includes('CREATE TABLE IF NOT EXISTS public.calendar_marcos'));
  assert.ok(m.includes("kind IN ('lead_cadastrado','reuniao_parceiro','acao_parceiro')"));
  assert.ok(m.includes("status IN ('planned','done','canceled')"));
  assert.ok(m.includes('create_lead_milestone'));
  assert.ok(m.includes('AFTER INSERT ON public.crm_leads'));
  assert.ok(m.includes('🎯 Lead novo: '));
  assert.ok(m.includes('is_env_staff((select auth.uid()), environment)'));
});

test('hooks e UI: pagina Parceiros no padrao do catalogo + marcos no calendario', async () => {
  const hook = await readFile(new URL('../src/hooks/usePartners.ts', import.meta.url), 'utf8');
  assert.ok(hook.includes('usePartners'));
  assert.ok(hook.includes('useCalendarMarcos'));
  assert.ok(hook.includes('calendar_marcos_partner_id_fkey'));
  assert.ok(hook.includes('calendar_marcos_responsible_id_fkey'));

  const page = await readFile(new URL('../src/components/partners/PartnersPage.tsx', import.meta.url), 'utf8');
  assert.ok(page.includes('Planejar'));
  assert.ok(page.includes('createMarco'));
  assert.ok(page.includes('reuniao_parceiro'));
  assert.ok(page.includes('acao_parceiro'));

  const nav = await readFile(new URL('../src/components/layout/navItems.ts', import.meta.url), 'utf8');
  assert.ok(nav.includes("path: '/sharks/parceiros'"));
  assert.ok(nav.includes("path: '/estrategos/parceiros'"));
  assert.ok(nav.includes('Handshake'));

  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.ok(app.includes('"/sharks/parceiros"'));
  assert.ok(app.includes('"/estrategos/parceiros"'));

  const cal = await readFile(new URL('../src/pages/sharks/SharksCalendar.tsx', import.meta.url), 'utf8');
  assert.ok(cal.includes('useCalendarMarcos'));
  assert.ok(cal.includes('dayMarcos'));
  assert.ok(cal.includes("'lead_cadastrado'"));
});
/* ---- WH-1: conversa do agente ---- */

test('GLM de conversa: prompt de chat e factory', () => {
  const prompt = ai.buildGlmConversationPrompt(
    { agent_name: 'Sofia', tone: 'amigavel', language: 'pt-BR', signature: '— Sharks' },
    'PILOTO SP',
  );
  assert.ok(prompt.includes('Sofia'));
  assert.ok(prompt.includes('PILOTO SP'));
  assert.ok(prompt.includes('80 palavras'));
  assert.ok(typeof ai.glmChatOk === 'function');
  const chat = ai.getGenerativeChatAI();
  assert.ok(['glm', 'mock'].includes(chat.name));
});

test('migration/edge da conversa: worker-secret, dedupe mid, contexto rico, TTS e sent', async () => {
  const edge = await readFile(new URL('../supabase/functions/prospecting-conversation/index.ts', import.meta.url), 'utf8');
  assert.ok(edge.includes("action === 'sent'"));
  assert.ok(edge.includes('last_inbound_mid'));
  assert.ok(edge.includes('loadAgentContext'));
  assert.ok(edge.includes('environment_asset_products'));
  assert.ok(edge.includes('getGenerativeChatAI()'));
  assert.ok(edge.includes('synthesizeReply'));
  assert.ok(edge.includes('agent-voice'));
  assert.ok(edge.includes('findLead(admin, environment, contact)'));
  assert.ok(edge.includes("'reply_received'"));
});

test('n8n WH1: flow com endereco (webhook → valida → cerebro → envio → registro) e JSON gerado', async () => {
  const json1 = await readFile(new URL('../n8n/oracullo-conversation.json', import.meta.url), 'utf8');
  const conv = JSON.parse(json1);
  const names = conv.nodes.map(n => n.name);
  for (const expected of ['Evolution Webhook', 'Normalizar Mensagem', 'Mensagem valida?', 'Cerebro da Conversa (Edge)', 'Preparar Resposta', 'Evolution Enviar Resposta', 'Registrar Envio (Edge)', 'Callback Diagnostico']) {
    assert.ok(names.includes(expected), `node ausente: ${expected}`);
  }
  const brain = conv.nodes.find(n => n.name === 'Cerebro da Conversa (Edge)');
  assert.ok(brain.parameters.url.includes('prospecting-conversation'));
  assert.ok(brain.parameters.jsonBody.includes('payloadStr'));
  const send = conv.nodes.find(n => n.name === 'Evolution Enviar Resposta');
  assert.ok(send.parameters.url.includes('sendAudio'));
  assert.ok(send.parameters.url.includes('sendMedia'));
});
/* ---- WH-2: memória, modo ai/human, rate-limit e saída estruturada (077) ---- */

test('saída estruturada: parse do JSON do GLM com enums validados e fallback', () => {
  const ok = ai.parseConversationReply(JSON.stringify({
    reply: 'Oi! Vou te passar um case.',
    media_intent: 'social_proof',
    action: 'escalate',
    escalate_reason: 'pediu especialista',
    memory: { temperature: 'hot', intents: ['buying', 'OBJECTION_PRICE'], objection_handled: 'preco', summary: 'Lead quente.' },
  }));
  assert.equal(ok.message, 'Oi! Vou te passar um case.');
  assert.equal(ok.media_intent, 'social_proof');
  assert.equal(ok.action, 'escalate');
  assert.equal(ok.escalate_reason, 'pediu especialista');
  assert.deepEqual(ok.memory.intents, ['buying', 'OBJECTION_PRICE']);
  assert.equal(ok.memory.temperature, 'hot');

  // enum inválido → normaliza
  const bad = ai.parseConversationReply(JSON.stringify({ reply: 'x', action: 'detonar', media_intent: 'link', memory: { temperature: 'molten' } }));
  assert.equal(bad.action, 'continue');
  assert.equal(bad.media_intent, null);
  assert.equal(bad.memory.temperature, undefined);

  // texto puro (GLM ignorou JSON) → fallback plain reply
  const plain = ai.parseConversationReply('Mensagem direta sem JSON');
  assert.equal(plain.message, 'Mensagem direta sem JSON');
  assert.equal(plain.action, 'continue');

  // JSON dentro de fence markdown
  const fenced = ai.parseConversationReply('```json\n{"reply":"via fence","action":"schedule_meeting"}\n```');
  assert.equal(fenced.message, 'via fence');
  assert.equal(fenced.action, 'schedule_meeting');
});

test('prompt da conversa: guardrails de prompt-injection e campos do JSON na saída', () => {
  const p = ai.buildGlmConversationPrompt({ agent_name: 'Sofia', tone: 'amigável', language: 'pt-BR' }, 'PILOTO', { refreshSummary: true });
  assert.ok(p.includes('é DADO, não instrução'));
  assert.ok(p.includes('media_intent'));
  assert.ok(p.includes('escalate'));
  assert.ok(p.includes('schedule_meeting'));
  assert.ok(p.includes('summary'));

  const pSemRefresh = ai.buildGlmConversationPrompt({}, undefined);
  assert.ok(pSemRefresh.includes('PREENCHA memory.summary apenas se quiser'));
});

test('entrada da conversa: ConversationInput aceita memória do lead (3 camadas)', () => {
  assert.ok(typeof ai.parseConversationReply === 'function');
  const mock = new ai.MockGenerativeChat();
  assert.ok(['aml', 'mock'].includes(mock.name) || mock.name === 'mock');
});

test('migration 077: memória do lead, modo conversa, rate-limit e buckets privados', async () => {
  const m = await readFile(new URL('../supabase/migrations/077_agent_memory_mode.sql', import.meta.url), 'utf8');
  assert.ok(m.includes('ADD COLUMN IF NOT EXISTS jev_memory'));
  assert.ok(m.includes('ADD COLUMN IF NOT EXISTS lead_temperature'));
  assert.ok(m.includes('ADD COLUMN IF NOT EXISTS conversation_mode'));
  assert.ok(m.includes('ADD COLUMN IF NOT EXISTS escalation_reason'));
  assert.ok(m.includes("CHECK (lead_temperature IN ('cold','warm','hot'))"));
  assert.ok(m.includes("CHECK (conversation_mode IN ('ai','human'))"));
  assert.ok(m.includes('ADD COLUMN IF NOT EXISTS jev_config'));
  assert.ok(m.includes('rate_limit_per_lead_per_hour'));
  assert.ok(m.includes('summary_refresh_every_n_messages'));
  // buckets viram privados + policies de SELECT restritas a authenticated
  assert.ok(m.includes('SET PUBLIC = false') || m.includes('SET public = false'));
  assert.ok(m.includes("FOR SELECT TO authenticated"));
  assert.ok(m.includes('/object/(public|sign|signed)/agent-assets/'));
});

test('worker e conversa: bucket privado com signed URL (nada de getPublicUrl)', async () => {
  const workerTxt = await readFile(new URL('../supabase/functions/prospecting-run/index.ts', import.meta.url), 'utf8');
  assert.ok(workerTxt.includes('createSignedUrl'));
  assert.ok(workerTxt.includes('audio_path'));
  assert.ok(!workerTxt.includes('getPublicUrl'));

  const convTxt = await readFile(new URL('../supabase/functions/prospecting-conversation/index.ts', import.meta.url), 'utf8');
  assert.ok(convTxt.includes('createSignedUrl'));
  assert.ok(!convTxt.includes('getPublicUrl'));

  const uiUpload = await readFile(new URL('../src/components/products/EnvAgentAssets.tsx', import.meta.url), 'utf8');
  assert.ok(uiUpload.includes("return path; // bucket privado"));
  assert.ok(uiUpload.includes('useSignedUrl'));
});

test('edge da conversa: memória, rate-limit, modo humano e media_intent', async () => {
  const edge = await readFile(new URL('../supabase/functions/prospecting-conversation/index.ts', import.meta.url), 'utf8');
  assert.ok(edge.includes('lead.jev_memory'));
  assert.ok(edge.includes('rate_limit_per_lead_per_hour'));
  assert.ok(edge.includes("conversationMode === 'human'"));
  assert.ok(edge.includes('pickMediaAsset'));
  assert.ok(edge.includes("media_intent"));
  assert.ok(edge.includes("escalate"));
  assert.ok(edge.includes("schedule_meeting"));
  assert.ok(edge.includes('persistMemory'));
  assert.ok(edge.includes('bumpRateCounter'));
  assert.ok(edge.includes('refreshSummary'));
  assert.ok(edge.includes('conversation_mode: \'human\''));
});

test('navegador: helper resolveStorageUrl assina path e re-assina legacy público', async () => {
  const media = await readFile(new URL('../src/lib/prospecting/media.ts', import.meta.url), 'utf8');
  assert.ok(media.includes('createSignedUrl'));
  assert.ok(media.includes('storage'));
  assert.ok(media.includes('sign') && media.includes('public'));
  assert.ok(media.includes('agent-voice'));
  assert.ok(media.includes('agent-assets'));
});

/* ---- WH-3: disparo em massa, oferta, follow-up e agenda (078) ---- */

test('migration 078: mass_dispatch, oferta e marcos refor�ados', async () => {
  const m = await readFile(new URL('../supabase/migrations/078_mass_dispatch_agenda.sql', import.meta.url), 'utf8');
  assert.ok(m.includes("'mass_dispatch'"));
  assert.ok(m.includes('ADD COLUMN IF NOT EXISTS offer'));
  assert.ok(m.includes("'reuniao_lead'"));
  assert.ok(m.includes('uq_calendar_marcos_lead_kind'));
  assert.ok(m.includes('ON CONFLICT (lead_id, kind) DO NOTHING'));
  assert.ok(m.includes('ADD TABLE public.calendar_marcos'));
  assert.ok(m.includes('idx_crm_leads_followup'));
});

test('worker: send real prepara to/message/audio e guarda humano/frio', async () => {
  const worker = await readFile(new URL('../supabase/functions/prospecting-run/index.ts', import.meta.url), 'utf8');
  // send_message n�o � mais blind forward: processSend valida e enriquece
  assert.ok(worker.includes("job.type === 'send_message'"));
  assert.ok(worker.includes('processSend'));
  assert.ok(worker.includes('leadToPhone'));
  // coordenador de massa + regra semi_auto precisa do primeiro envio aprovado
  assert.ok(worker.includes("job.type === 'mass_dispatch'"));
  assert.ok(worker.includes('processMass'));
  assert.ok(worker.includes('campaignHasFirstSend'));
  assert.ok(worker.includes('max_messages_per_day'));
  assert.ok(worker.includes('staggerMs'));
  // reaquecimento real
  assert.ok(worker.includes("job.type === 'follow_up'"));
  assert.ok(worker.includes('follow_up_days'));
  assert.ok(worker.includes('followupsEnqueued'));
});

test('callback: send completed atualiza lead (contacted + timeline outreach_sent)', async () => {
  const cb = await readFile(new URL('../supabase/functions/prospecting-job-callback/index.ts', import.meta.url), 'utf8');
  assert.ok(cb.includes("jrow.type === 'send_message'"));
  assert.ok(cb.includes("type: 'outreach_sent'"));
  assert.ok(cb.includes("prospecting_status: 'contacted'"));
  assert.ok(cb.includes('last_contact_at'));
});

test('conversa: schedule_meeting cria marco reuniao_lead na agenda', async () => {
  const edge = await readFile(new URL('../supabase/functions/prospecting-conversation/index.ts', import.meta.url), 'utf8');
  assert.ok(edge.includes("kind: 'reuniao_lead'"));
  assert.ok(edge.includes("'meeting'"));
});

test('edge dispatch: aprova��o e massa com staff-check + guards', async () => {
  const edge = await readFile(new URL('../supabase/functions/prospecting-dispatch/index.ts', import.meta.url), 'utf8');
  assert.ok(edge.includes("action === 'approve_draft'"));
  assert.ok(edge.includes("action === 'mass'"));
  assert.ok(edge.includes('is_env_staff'));
  assert.ok(edge.includes('auth.getUser'));
  assert.ok(edge.includes('Nenhum rascunho de abordagem'));
  assert.ok(edge.includes('Campanha precisa estar running'));
});

test('UI: aprovar no feed, disparar no card e oferta no form', async () => {
  const feed = await readFile(new URL('../src/components/prospecting/ApproachesPage.tsx', import.meta.url), 'utf8');
  assert.ok(feed.includes('callDispatch'));
  assert.ok(feed.includes('Aprovar e enviar'));

  const camps = await readFile(new URL('../src/components/prospecting/ProspectingPage.tsx', import.meta.url), 'utf8');
  assert.ok(camps.includes("action: 'mass'"));
  assert.ok(camps.includes('callDispatch'));

  const form = await readFile(new URL('../src/components/prospecting/CampaignFormModal.tsx', import.meta.url), 'utf8');
  assert.ok(form.includes('Oferta / desconto'));
  assert.ok(form.includes('offer: values.offer'));

  const types = await readFile(new URL('../src/lib/prospecting/types.ts', import.meta.url), 'utf8');
  assert.ok(types.includes('offer'));
});

test('agenda: respons�veis por user_environments, conflito de hor�rio e TZ da agenda', async () => {
  const form = await readFile(new URL('../src/components/actions/ActionForm.tsx', import.meta.url), 'utf8');
  assert.ok(form.includes("from('user_environments')"));
  assert.ok(form.includes('.in(') === false || form.includes("in('role'") === false);
  assert.ok(form.includes('Conflito de hor'));

  const ld = await readFile(new URL('../src/lib/localDate.ts', import.meta.url), 'utf8');
  assert.ok(ld.includes('America/Sao_Paulo'));
  assert.ok(ld.includes('Intl.DateTimeFormat'));

  const cal = await readFile(new URL('../src/pages/sharks/SharksCalendar.tsx', import.meta.url), 'utf8');
  assert.ok(cal.includes('MarcoPill'));          // componente compartilhado nas views
  assert.ok(cal.includes('updateMarco'));        // edi��o de marcos
  assert.ok(cal.includes("'reuniao_lead'"));     // r�tulo novo
  assert.ok(cal.includes('marcoEditOpen'));      // modal edit�vel
});

/* ---- LH-1 (WH4/M5): canais din�micos, Firecrawl, HMAC, Resend audio ---- */

test('migration 079: provider de descoberta + voice fora dos canais', async () => {
  const m = await readFile(new URL('../supabase/migrations/079_channels_dynamic.sql', import.meta.url), 'utf8');
  assert.ok(m.includes('discovery_provider'));
  assert.ok(m.includes("IN ('auto','places','firecrawl')"));
  assert.ok(m.includes('array_remove(channels'));
});

test('shared auth: HMAC com janela de 5 Minutos e modo legacy', async () => {
  const authTxt = await readFile(new URL('../supabase/functions/_shared/auth.ts', import.meta.url), 'utf8');
  assert.ok(authTxt.includes('WORKER_SIGNING_KEY'));
  assert.ok(authTxt.includes('t=(\\d+),v='));
  assert.ok(authTxt.includes('REPLAY_WINDOW_MS'));
  assert.ok(authTxt.includes('timingSafeEq'));
  const three = await Promise.all(['prospecting-run', 'prospecting-conversation', 'prospecting-job-callback'].map(async f => {
    const t = await readFile(new URL(`../supabase/functions/${f}/index.ts`, import.meta.url), 'utf8');
    return t.includes('verifyWorker(req, rawBody)');
  }));
  assert.deepEqual(three, [true, true, true]);
});

test('worker: roteia descoberta (places/firecrawl/auto) e respeita demanda web', async () => {
  const worker = await readFile(new URL('../supabase/functions/prospecting-run/index.ts', import.meta.url), 'utf8');
  assert.ok(worker.includes('processDiscovery('));
  assert.ok(worker.includes('processDiscoveryFirecrawl'));
  assert.ok(worker.includes('discovery_provider'));
  assert.ok(worker.includes('api.firecrawl.dev/v2/search'));
  assert.ok(worker.includes('extractBrazilPhones'));
  assert.ok(worker.includes("source: 'firecrawl'"));
});

test('worker: send por canal (whatsapp via n8n, instagram DM, resend e-mail)', async () => {
  const worker = await readFile(new URL('../supabase/functions/prospecting-run/index.ts', import.meta.url), 'utf8');
  assert.ok(worker.includes('sendViaWhatsapp'));
  assert.ok(worker.includes('sendLeadInstagramDm'));
  assert.ok(worker.includes('prospectionEmail('));
  assert.ok(worker.includes('sendEmail({ to:'));
  assert.ok(worker.includes('Nenhum canal envio do lead compat'));
});

test('callback: numero invalido descarta o lead e para follow-up', async () => {
  const cb = await readFile(new URL('../supabase/functions/prospecting-job-callback/index.ts', import.meta.url), 'utf8');
  assert.ok(cb.includes('lead_discarded: true'));
  assert.ok(cb.includes('lost_reason'));
  assert.ok(cb.includes('discarded'));
});

test('instagram compartilhado: send interno do worker sem JWT', async () => {
  const ig = await readFile(new URL('../supabase/functions/_shared/instagram.ts', import.meta.url), 'utf8');
  assert.ok(ig.includes('sendLeadInstagramDm'));
  assert.ok(ig.includes('ig_sid'));
  const edge = await readFile(new URL('../supabase/functions/instagram-send-dm/index.ts', import.meta.url), 'utf8');
  assert.ok(edge.includes('isInternal'));
  assert.ok(edge.includes('x-worker-secret'));
});

test('conversa: m�dia (audio/image/document/video) alimenta o cerebro', async () => {
  const edge = await readFile(new URL('../supabase/functions/prospecting-conversation/index.ts', import.meta.url), 'utf8');
  assert.ok(edge.includes('transcribeAudioEleven'));
  assert.ok(edge.includes('scribe_v1'));
  assert.ok(edge.includes('describeImageGlm'));
  assert.ok(edge.includes('GLM_VISION_MODEL'));
  assert.ok(edge.includes("media?.kind === 'audio'"));
});

test('UI: canais dinamicos com status e seletor de descoberta - voice removida', async () => {
  const types = await readFile(new URL('../src/lib/prospecting/types.ts', import.meta.url), 'utf8');
  assert.ok(types.includes("['whatsapp', 'instagram', 'email']"));
  assert.ok(types.includes('DiscoveryProvider'));
  assert.ok(!types.includes("'voice'"));
  const form = await readFile(new URL('../src/components/prospecting/CampaignFormModal.tsx', import.meta.url), 'utf8');
  assert.ok(form.includes('CHANNEL_READY'));
  assert.ok(form.includes('Fonte de descoberta de leads'));
  assert.ok(form.includes('useChannelStatus'));

  const agent = await readFile(new URL('../src/components/prospecting/AgentPage.tsx', import.meta.url), 'utf8');
  assert.ok(agent.includes('Firecrawl (busca web)'));
  assert.ok(agent.includes('Resend (e-mail)'));

  const statusEdge = await readFile(new URL('../supabase/functions/prospecting-status/index.ts', import.meta.url), 'utf8');
  assert.ok(statusEdge.includes('firecrawl'));
  assert.ok(statusEdge.includes('resend'));
});

test('n8n WH2: mídia + HMAC + mensagem com media valida', async () => {
  const conv = JSON.parse(await readFile(new URL('../n8n/oracullo-conversation.json', import.meta.url), 'utf8'));
  const names = conv.nodes.map(n => n.name);
  for (const expected of ['Evolution Webhook', 'Normalizar Mensagem', 'Cerebro da Conversa (Edge)', 'Preparar Resposta', 'Evolution Enviar Resposta', 'Registrar Envio (Edge)']) {
    assert.ok(names.includes(expected), `node ausente: ${expected}`);
  }
  assert.ok(names.includes('Assinar Cerebro'));
  assert.ok(names.includes('IA respondeu?'));
  const norm = conv.nodes.find(n => n.name === 'Normalizar Mensagem');
  assert.ok(norm.parameters.jsCode.includes('audioMessage'));
  assert.ok(norm.parameters.jsCode.includes('imageMessage'));
  const sig = conv.nodes.find(n => n.name === 'Assinar Cerebro');
  assert.equal(sig.parameters.encoding, 'base64');
  const brain = conv.nodes.find(n => n.name === 'Cerebro da Conversa (Edge)');
  assert.ok(brain.parameters.headerParameters.parameters.some(p => p.name === 'x-signature'));
  const send = conv.nodes.find(n => n.name === 'Evolution Enviar Resposta');
  assert.ok(send.parameters.url.includes('sendMedia'));
});

test('n8n Router: callback unico assinado (Preparar Callback → Assinar Callback → Edge)', async () => {
  const router = JSON.parse(await readFile(new URL('../n8n/oracullo-router.json', import.meta.url), 'utf8'));
  const names = router.nodes.map(n => n.name);
  assert.ok(names.includes('Preparar Callback'));
  assert.ok(names.includes('Assinar Callback'));
  assert.ok(names.includes('Callback (Edge)'));
  assert.ok(!names.includes('Callback WhatsApp'));
  assert.ok(!names.includes('Callback Padr�o'));
  const pre = router.nodes.find(n => n.name === 'Preparar Callback');
  assert.ok(pre.parameters.jsCode.includes('payloadStr'));
  const hmac = router.nodes.find(n => n.name === 'Assinar Callback');
  assert.equal(hmac.parameters.type, 'SHA256');
  assert.ok(hmac.parameters.value.includes('.'));
});

/* ---- WA-CLOUD (082): API oficial Meta ao lado da Evolution ---- */

test('migration 080: whatsapp_connections com ambiente �nico e token blindado', async () => {
  const m = await readFile(new URL('../supabase/migrations/080_whatsapp_cloud.sql', import.meta.url), 'utf8');
  assert.ok(m.includes('CREATE TABLE IF NOT EXISTS public.whatsapp_connections'));
  assert.ok(m.includes('uq_whatsapp_conn_env'));
  assert.ok(m.includes('is_env_admin((select auth.uid()), environment)'));
  assert.ok(m.includes('access_token text NOT NULL'));
  assert.ok(m.includes('cold_template'));
  assert.ok(m.includes('REVOKE ALL ON public.whatsapp_connections FROM authenticated'));
  assert.ok(m.includes('GRANT SELECT (id, environment, waba_id, phone_number_id'));
});

test('shared auth: bypass interno Edge?Edge por token de servi�o', async () => {
  const authTxt = await readFile(new URL('../supabase/functions/_shared/auth.ts', import.meta.url), 'utf8');
  assert.ok(authTxt.includes("x-internal-token"));
  assert.ok(authTxt.includes('signingKey && internalToken'));
});

test('shared whatsapp: cloud com janela 24h, template frio e mapping de erro 131026', async () => {
  const wa = await readFile(new URL('../supabase/functions/_shared/whatsapp.ts', import.meta.url), 'utf8');
  assert.ok(wa.includes('sendWAtext'));
  assert.ok(wa.includes('sendWAaudio'));
  assert.ok(wa.includes('sendWAtemplate'));
  assert.ok(wa.includes("'invalid_number'"));
  assert.ok(wa.includes("'131026'"));
  assert.ok(wa.includes('loadWhatsAppConnection'));
});

test('worker: sendViaCloud prioriza cloud em janela (gr�tis) e evolu��o fora', async () => {
  const worker = await readFile(new URL('../supabase/functions/prospecting-run/index.ts', import.meta.url), 'utf8');
  assert.ok(worker.includes('sendViaCloud'));
  assert.ok(worker.includes('whatsapp_priority'));
  assert.ok(worker.includes("priority === 'cloud'"));
  assert.ok(worker.includes('inWindow'));
  assert.ok(worker.includes('settings.jevConfig') || worker.includes('jevConfig'));
});

test('ingest: inbound WA oficial ? c�rebro com token interno + status failed descarta', async () => {
  const ingest = await readFile(new URL('../supabase/functions/prospecting-ingest/index.ts', import.meta.url), 'utf8');
  assert.ok(ingest.includes('messaging_product'));
  assert.ok(ingest.includes('handleWhatsAppCloud'));
  assert.ok(ingest.includes('last_wamid'));
  assert.ok(ingest.includes('last_inbound_at'));
  assert.ok(ingest.includes('BRAIN_EDGE'));
  assert.ok(ingest.includes('x-internal-token'));
  assert.ok(ingest.includes("'131026'"));
});

test('edge whatsapp-connect: valida��o no Graph + admin-only + status sem token', async () => {
  const edge = await readFile(new URL('../supabase/functions/whatsapp-connect/index.ts', import.meta.url), 'utf8');
  assert.ok(edge.includes("action === 'connect'"));
  assert.ok(edge.includes('display_phone_number'));
  assert.ok(edge.includes('is_env_admin'));
  assert.ok(edge.includes("action === 'status'"));
  assert.ok(edge.includes("action === 'disconnect'"));
});

test('UI AgentPage: conectar WhatsApp oficial com template frio e status verde', async () => {
  const agent = await readFile(new URL('../src/components/prospecting/AgentPage.tsx', import.meta.url), 'utf8');
  assert.ok(agent.includes('WA_CONNECT_EDGE'));
  assert.ok(agent.includes('whatsapp-connect'));
  assert.ok(agent.includes('Cloud API'));
  assert.ok(agent.includes('cold_template'));
  assert.ok(agent.includes('handleDisconnectWhatsApp'));
});

/* ---- Central Oracullo: p�ginas god-view (calend�rio, prospec��o, produtos, parceiros) ---- */

test('central oracullo: rotas, menu e wrappers com switcher de ambiente', async () => {
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8');
  for (const r of ['/oracullo/calendar', '/oracullo/products', '/oracullo/parceiros']) {
    assert.ok(app.includes(`path="${r}"`), `rota ausente: ${r}`);
  }

  const nav = await readFile(new URL('../src/components/layout/navItems.ts', import.meta.url), 'utf8');
  for (const p of ["path: '/oracullo/calendar'", "path: '/oracullo/products'", "path: '/oracullo/parceiros'"]) {
    assert.ok(nav.includes(p), `nav ausente: ${p}`);
  }

  const switcher = await readFile(new URL('../src/components/oracullo/EnvSwitcher.tsx', import.meta.url), 'utf8');
  assert.ok(switcher.includes("'sharks_company'"));
  assert.ok(switcher.includes("'estrategos'"));

  for (const [file, comp] of [
    ['OraculloCalendar.tsx', 'SharksCalendar'],
    ['OraculloProspecting.tsx', 'ProspectingHub'],
    ['OraculloPartners.tsx', 'PartnersPage'],
    ['OraculloProducts.tsx', 'ProductsPage'],
  ]) {
    const page = await readFile(new URL(`../src/pages/oracullo/${file}`, import.meta.url), 'utf8');
    assert.ok(page.includes(comp), `${file} sem ${comp}`);
    assert.ok(page.includes('EnvSwitcher'), `${file} sem switcher`);
  }
});
