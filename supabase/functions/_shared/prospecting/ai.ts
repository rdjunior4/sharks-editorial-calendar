/* ─── AIProvider do Prospecting Engine ───
   Duas camadas, com custo otimizado (§12/§31):
   - DECISÃO (Jev/Mock): score, classificação, próximo passo — ~$0,0001, todo lead
   - GERAÇÃO (GLM/Mock): rascunhos personalizados — só para leads qualificados
   Contrato estável: consumidores não conhecem o fornecedor. */

export interface CompanyProfile {
  name: string;
  segment?: string | null;
  location?: string | null;
  company_size?: string | null;
  signals?: string[];
  website_summary?: string | null;
  notes?: string | null;
}

export type AIPriority = 'alta' | 'media' | 'baixa';
export type AINextAction = 'pesquisar_mais' | 'qualificar' | 'descartar' | 'abordar';

export interface CompanyAnalysis {
  icpFit: number;
  confidence: number;
  priority: AIPriority;
  nextAction: AINextAction;
  productScores: Array<{ productName: string; score: number }>;
  rationale?: string;
}

/** ICP da campanha — o score mede contra o público-alvo, não contra a agência genérica */
export interface CampaignICP {
  campaign_name?: string | null;
  segment?: string | null;
  location?: string | null;
  company_size?: string | null;
  icp_description?: string | null;
}

export interface AIProvider {
  readonly name: string;
  analyzeCompany(company: CompanyProfile, campaignProducts: string[], icp?: CampaignICP): Promise<CompanyAnalysis>;
}

/* ─── Camada generativa ─── */
export interface AgentVoice {
  /** 'text' (default) · 'audio' · 'both' */
  mode?: 'text' | 'audio' | 'both';
  voice_id?: string;
}

export interface AgentPersonality {
  agent_name?: string;
  tone?: string;
  language?: string;
  persona?: string;
  brand_voice_rules?: string;
  signature?: string;
  greeting_style?: string;
  voice?: AgentVoice;
}

export interface ApproachInput {
  lead: { name: string; segment?: string | null; location?: string | null; company_size?: string | null; notes?: string | null };
  campaignName?: string;
  products: string[];
  personality: AgentPersonality;
  research?: string | null;
  icpDescription?: string | null;
  /** Assets vinculados aos produtos da campanha (provas sociais, cases, FAQ, portfólio) */
  assets?: string[];
}

export interface ApproachDraft {
  subject: string | null;
  message: string;
}

export interface GenerativeAI {
  readonly name: string;
  generateApproach(input: ApproachInput): Promise<ApproachDraft>;
}

/** Consolida os assets em blocos compactos para o prompt (cap de tamanho). */
export function buildAssetsContext(assets: string[] | null | undefined, maxChars = 1400): string {
  const blocks: string[] = [];
  let used = 0;
  for (const a of (assets ?? [])) {
    const clean = (a ?? '').trim();
    if (!clean) continue;
    const block = `- ${clean.slice(0, 300)}`;
    if (used + block.length > maxChars) break;
    blocks.push(block);
    used += block.length;
  }
  return blocks.join('\n');
}

/* ─── Mock de decisão (determinístico) ─── */
const round2 = (n: number) => Math.round(n * 100) / 100;

function stableHash(input: string): number {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  return h;
}

export class MockAIProvider implements AIProvider {
  readonly name = 'mock';

  async analyzeCompany(company: CompanyProfile, campaignProducts: string[], icp?: CampaignICP): Promise<CompanyAnalysis> {
    const key = [company.name, company.segment ?? '', company.location ?? '', company.company_size ?? '', icp?.icp_description ?? ''].join('|');
    const seed = stableHash(key);
    const signalBoost = Math.min(company.signals?.length ?? 0, 3) * 0.03;

    const icpFit = round2(Math.min(0.99, 0.35 + (seed % 60) / 100 + signalBoost));
    const confidence = round2(0.55 + ((seed >>> 3) % 45) / 100);
    const productScores = campaignProducts.map((productName, i) => ({
      productName,
      score: round2(Math.max(0.05, Math.min(0.95, 0.3 + ((seed >>> (i + 2)) % 65) / 100 + signalBoost))),
    }));

    return {
      icpFit,
      confidence,
      priority: icpFit >= 0.75 ? 'alta' : icpFit >= 0.55 ? 'media' : 'baixa',
      nextAction: icpFit >= 0.75 ? 'qualificar' : icpFit >= 0.5 ? 'pesquisar_mais' : 'descartar',
      productScores,
      rationale: `Mock determinístico (seed ${seed % 10000}).`,
    };
  }
}

/* ─── JEV — decisões tipadas (TypeSafe AI) ─── */
const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_MODEL = 'jev-latest';

export function buildJevQuestions(products: string[], icp?: CampaignICP): Record<string, unknown> {
  const icpTarget = icp
    ? 'do público-alvo desta campanha (segmento, porte, localização e descrição de ICP informados no contexto)'
    : 'da agência';
  const questions: Record<string, unknown> = {
    icp_fit: {
      type: 'score',
      instructions: `Aderência desta empresa ao perfil de cliente ideal ${icpTarget}`,
      criteria: ['Nenhum encaixe', 'Encaixe fraco', 'Encaixe razoável', 'Bom encaixe', 'Encaixe ideal'],
    },
    priority: {
      type: 'choice',
      instructions: 'Prioridade de follow-up comercial',
      criteria: { alta: 'Recomenda contato imediato', media: 'Acompanhar de perto', baixa: 'Nutrir no longo prazo' },
    },
    next_action: {
      type: 'choice',
      instructions: 'Próxima ação comercial recomendada',
      criteria: {
        pesquisar_mais: 'Faltam dados para decidir',
        qualificar: 'Perfil promissor, avançar no CRM',
        descartar: 'Sem encaixe real hoje',
        abordar: 'Pronto para primeiro contato',
      },
    },
  };
  products.slice(0, 12).forEach((p, i) => {
    questions[`prod_${i}`] = {
      type: 'noul',
      instructions: `Esta empresa demonstra necessidade/interesse real por: ${p}?`,
    };
  });
  return questions;
}

export function buildJevState(company: CompanyProfile, icp?: CampaignICP): string {
  return [
    `Empresa: ${company.name}`,
    company.segment ? `Segmento: ${company.segment}` : '',
    company.location ? `Localização: ${company.location}` : '',
    company.company_size ? `Porte: ${company.company_size}` : '',
    company.signals?.length ? `Sinais: ${company.signals.join('; ')}` : '',
    company.website_summary ? `Resumo do site: ${company.website_summary}` : '',
    company.notes ? `Notas: ${company.notes}` : '',
    icp ? `--- Público-alvo da campanha${icp.campaign_name ? ` "${icp.campaign_name}"` : ''} ---` : '',
    icp?.segment ? `Segmento alvo: ${icp.segment}` : '',
    icp?.location ? `Localização alvo: ${icp.location}` : '',
    icp?.company_size ? `Porte alvo: ${icp.company_size}` : '',
    icp?.icp_description ? `Descrição do ICP: ${icp.icp_description}` : '',
  ].filter(Boolean).join('\n');
}

export function mapJevAnswers(
  answers: Record<string, Record<string, unknown>>,
  products: string[],
): CompanyAnalysis {
  const fit = Number((answers.icp_fit as { score?: number })?.score ?? 0);
  const icpFit = round2(fit / 4);
  const priorityRaw = String((answers.priority as { choice?: string })?.choice ?? 'baixa');
  const nextRaw = String((answers.next_action as { choice?: string })?.choice ?? 'pesquisar_mais');

  const productScores = products.slice(0, 12).map((productName, i) => ({
    productName,
    score: round2(Number((answers[`prod_${i}`] as { noul?: number })?.noul ?? 0)),
  }));

  return {
    icpFit,
    confidence: round2(Number((answers.icp_fit as { confidence?: number })?.confidence ?? 0)),
    priority: (['alta', 'media', 'baixa'] as const).includes(priorityRaw as AIPriority)
      ? (priorityRaw as AIPriority) : 'baixa',
    nextAction: (['pesquisar_mais', 'qualificar', 'descartar', 'abordar'] as const).includes(nextRaw as AINextAction)
      ? (nextRaw as AINextAction) : 'pesquisar_mais',
    productScores,
    rationale: 'JEV (decisão calibrada).',
  };
}

export class JevProvider implements AIProvider {
  readonly name = 'jev';
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async analyzeCompany(company: CompanyProfile, campaignProducts: string[], icp?: CampaignICP): Promise<CompanyAnalysis> {
    const res = await fetch(JEV_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        state: buildJevState(company, icp),
        model: JEV_MODEL,
        questions: buildJevQuestions(campaignProducts, icp),
      }),
    });
    if (!res.ok) {
      throw new Error(`JEV falhou (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as { answers: Record<string, Record<string, unknown>> };
    return mapJevAnswers(body.answers, campaignProducts);
  }
}

/* ─── GLM — camada generativa (Zhipu, API OpenAI-compatible) ─── */
const GLM_DEFAULT_BASE = 'https://open.bigmodel.cn/api/paas/v4';
const GLM_DEFAULT_MODEL = 'glm-4.5-flash';

export function buildGlmSystemPrompt(personality: AgentPersonality, campaignName?: string): string {
  const tone = personality.tone === 'formal'
    ? 'Tom formal e profissional'
    : personality.tone === 'direto'
    ? 'Tom direto e objetivo'
    : 'Tom amigável e próximo';
  return [
    `Você é ${personality.agent_name ?? 'um agente comercial'}, ${tone}, escrevendo em ${personality.language ?? 'pt-BR'}.`,
    personality.persona ? `Persona: ${personality.persona}` : '',
    `Contexto: primeira abordagem B2B para a campanha "${campaignName ?? 'prospecção'}".`,
    personality.greeting_style ? `Abertura: ${personality.greeting_style}.` : '',
    personality.brand_voice_rules ? `Regras de voz: ${personality.brand_voice_rules}` : '',
    'Formato obrigatório da resposta: primeira linha "Assunto: <assunto curto>", depois uma linha em branco e a mensagem (máximo 120 palavras). Não use placeholders entre colchetes.',
    personality.signature ? `Finalize com a assinatura: ${personality.signature}` : '',
  ].filter(Boolean).join('\n');
}

export function parseGlmDraft(text: string): ApproachDraft {
  const clean = text.trim();
  const m = clean.match(/^Assunto:\s*(.+)\r?\n\s*\r?\n?([\s\S]*)$/i);
  if (m) return { subject: m[1].trim(), message: m[2].trim() };
  return { subject: null, message: clean };
}

export class GlmProvider implements GenerativeAI {
  readonly name = 'glm';
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(apiKey: string, model?: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.model = model || GLM_DEFAULT_MODEL;
    this.baseUrl = (baseUrl || GLM_DEFAULT_BASE).replace(/\/$/, '');
  }

  async generateApproach(input: ApproachInput): Promise<ApproachDraft> {
    const products = input.products.length > 0 ? input.products.join(', ') : 'nossos serviços';
    const userPrompt = [
      `Lead: ${input.lead.name}`,
      input.lead.segment ? `Segmento: ${input.lead.segment}` : '',
      input.lead.location ? `Localização: ${input.lead.location}` : '',
      input.lead.company_size ? `Porte: ${input.lead.company_size}` : '',
      input.research ? `Pesquisa: ${input.research.slice(0, 600)}` : '',
      `Produtos relevantes: ${products}`,
      input.icpDescription ? `Público-alvo da campanha: ${input.icpDescription.slice(0, 400)}` : '',
      buildAssetsContext(input.assets) ? `Provas, cases e materiais disponíveis (cite os que fizerem sentido, sem inventar dados):\n${buildAssetsContext(input.assets)}` : '',
      '',
      'Escreva a primeira mensagem de abordagem.',
    ].filter(Boolean).join('\n');

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.7,
        max_tokens: 1024,
        // rascunhos são curtos e objetivos — sem raciocínio longo
        // (modelos glm-4.5+ gastam o budget de tokens em reasoning_content)
        thinking: { type: 'disabled' },
        messages: [
          { role: 'system', content: buildGlmSystemPrompt(input.personality, input.campaignName) },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`GLM falhou (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = body.choices?.[0]?.message?.content?.trim() ?? '';
    if (!text) throw new Error('GLM respondeu vazio');
    return parseGlmDraft(text);
  }
}

export class MockGenerativeAI implements GenerativeAI {
  readonly name = 'mock';

  async generateApproach(input: ApproachInput): Promise<ApproachDraft> {
    const p = input.products[0] ?? 'nossos serviços';
    return {
      subject: `${input.lead.name}: uma ideia para ${p}`,
      message: `Olá${input.lead.name ? `, equipe ${input.lead.name}` : ''}!\n\nAcompanho o trabalho de vocês no segmento de ${input.lead.segment ?? 'mercado'} e acredito que ${p} pode gerar resultado rápido.\n\nTopa uma conversa de 15 minutos?${input.personality.signature ? `\n\n${input.personality.signature}` : ''}\n\n[rascunho mock — configure GLM_API_KEY para personalização real]`,
    };
  }
}

/* ─── Factories (Deno env; guard para testes em node) ─── */
function env(k: string): string | undefined {
  const d = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno;
  return d?.env.get(k);
}

export function getDecisionAI(): AIProvider {
  const key = env('TYPESAFE_API_KEY');
  if (env('AI_PROVIDER') === 'jev' && key) return new JevProvider(key);
  return new MockAIProvider();
}

export function hasRealAI(): boolean {
  return !!env('TYPESAFE_API_KEY');
}

export function getGenerativeAI(): GenerativeAI {
  const key = env('GLM_API_KEY');
  if (key) return new GlmProvider(key, env('GLM_MODEL'), env('GLM_BASE_URL'));
  return new MockGenerativeAI();
}

export function hasRealGenerative(): boolean {
  return !!env('GLM_API_KEY');
}

/** Compat: decisão (renomeado) */
export const getAIProvider = getDecisionAI;
