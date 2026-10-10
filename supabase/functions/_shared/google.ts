// ==========================================
// SHARED: Google Calendar helpers
// OAuth state signing, token management,
// event mapping and efficient queue processing
// Multi-ambiente (migration 023/025):
//   sync_mode unified | split, env_calendar_ids,
//   fila generalizada por source.
// ==========================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const CAL_API = 'https://www.googleapis.com/calendar/v3';
export const TOKEN_API = 'https://oauth2.googleapis.com/token';

export type EnvType = 'sharks_company' | 'estrategos';
export const ENV_LABEL: Record<EnvType, string> = {
  sharks_company: 'Sharks',
  estrategos: 'Estrategos',
};

export interface IntegrationRow {
  id: string;
  workspace_id: string;
  user_id: string | null;
  google_calendar_id: string | null;
  google_calendar_name: string | null;
  google_account_email: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  is_connected: boolean;
  auto_sync: boolean;
  last_synced_at: string | null;
  sync_error: string | null;
  sync_mode: 'unified' | 'split';
  env_calendar_ids: Record<string, string> | null;
  env_auto_sync: Record<string, boolean> | null;
}

export type QueueSource = 'sharks_action' | 'estrategos_meeting' | 'estrategos_implementation' | 'campaign';

export interface QueueItem {
  id: string;
  workspace_id: string;
  action_id: string | null;
  source: QueueSource;
  source_id: string | null;
  operation: 'create' | 'update' | 'delete';
  attempts: number;
  google_event_id?: string | null;
  integration_id?: string | null;
  action: Record<string, unknown> | null;
  meeting: Record<string, unknown> | null;
  implementation: Record<string, unknown> | null;
}

// ---------- base64url ----------

function bytesToB64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64UrlEncode(str: string): string {
  return bytesToB64Url(new TextEncoder().encode(str));
}

// ---------- HMAC-signed OAuth state ----------

// ---------- CORS: allow APP_URL + localhost dev ----------

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const appUrl = Deno.env.get('APP_URL');
  const allowed =
    origin === appUrl ||
    origin.startsWith('http://localhost:') ||
    origin.startsWith('http://127.0.0.1:');
  return {
    'Access-Control-Allow-Origin': allowed ? origin : (appUrl ?? '*'),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-worker-secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function getStateSecret(): string {
  const secret = Deno.env.get('STATE_SECRET');
  if (!secret || secret.length < 16) {
    throw new Error('STATE_SECRET not configured or too short (min 16 chars)');
  }
  return secret;
}

async function hmacBytes(payload: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(getStateSecret()),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return new Uint8Array(sig);
}

export async function createState(
  workspaceId: string,
  userId: string,
  returnTo: string,
  syncMode: 'unified' | 'split' = 'unified',
): Promise<string> {
  const payload = b64UrlEncode(JSON.stringify({ ws: workspaceId, u: userId, r: returnTo, m: syncMode, t: Date.now() }));
  const sig = bytesToB64Url(await hmacBytes(payload));
  return `${payload}.${sig}`;
}

export async function verifyState(state: string): Promise<{ ws: string; u: string; r: string; m: 'unified' | 'split' } | null> {
  const dot = state.indexOf('.');
  if (dot <= 0) return null;
  const payload = state.slice(0, dot);
  const sig = state.slice(dot + 1);
  const expected = bytesToB64Url(await hmacBytes(payload));
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const json = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(payload.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)),
    ));
    if (!json.ws || !json.u || Date.now() - json.t > 600_000) return null;
    return {
      ws: json.ws,
      u: json.u,
      r: typeof json.r === 'string' ? json.r : '/sharks/integrations',
      m: json.m === 'split' ? 'split' : 'unified',
    };
  } catch {
    return null;
  }
}

// ---------- Supabase clients ----------

export function serviceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
}

export async function verifyWorkspaceAccess(
  admin: ReturnType<typeof serviceClient>,
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  const { data: u } = await admin.from('users').select('role, is_guardian').eq('id', userId).maybeSingle();
  if (u && (u.is_guardian || u.role === 'oracullo_admin' || u.role === 'admin_sharks' || u.role === 'sharks_team')) return true;

  // Staff por ambiente (user_environments): o ambiente do workspace
  // precisa bater com um cargo admin/team do usuario — sem depender
  // de membership (RLS ws_visible usa o mesmo criterio).
  const [wsOrgRes, envsRes] = await Promise.all([
    admin.from('workspaces').select('organization_id').eq('id', workspaceId).maybeSingle(),
    admin.from('user_environments').select('environment, role').eq('user_id', userId),
  ]);
  if (wsOrgRes.data?.organization_id) {
    const { data: org } = await admin
      .from('organizations')
      .select('environment')
      .eq('id', wsOrgRes.data.organization_id)
      .maybeSingle();
    if (org && (envsRes.data ?? []).some(e => e.environment === org.environment && (e.role === 'admin' || e.role === 'team'))) {
      return true;
    }
  }

  const { data: m } = await admin
    .from('memberships')
    .select('id')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  return !!m;
}

// ---------- Token management ----------

export function getGoogleCredentials(): { clientId: string; clientSecret: string } {
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID');
  const clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not configured');
  }
  return { clientId, clientSecret };
}

export async function refreshAccessToken(admin: ReturnType<typeof serviceClient>, integ: IntegrationRow): Promise<string> {
  if (!integ.refresh_token) throw new Error('Sem refresh token - reconecte a conta Google');
  const { clientId, clientSecret } = getGoogleCredentials();
  const res = await fetch(TOKEN_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: integ.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Token refresh falhou (${res.status}): ${await res.text()}`);
  let json: { access_token?: string; expires_in?: number };
  try {
    json = await res.json();
  } catch {
    throw new Error('Resposta invalida do endpoint de token Google');
  }
  if (!json.access_token) throw new Error('Token ausente na resposta do Google');
  const expiresAt = new Date(Date.now() + (json.expires_in ?? 3600) * 1000).toISOString();
  const { error: updError } = await admin
    .from('calendar_integrations')
    .update({ access_token: json.access_token, token_expires_at: expiresAt })
    .eq('id', integ.id);
  if (updError) throw new Error(`Falha ao persistir token: ${updError.message}`);
  return json.access_token;
}

export async function getValidToken(admin: ReturnType<typeof serviceClient>, integ: IntegrationRow): Promise<string> {
  const margin = Date.now() + 120_000;
  const exp = integ.token_expires_at ? new Date(integ.token_expires_at).getTime() : 0;
  if (integ.access_token && exp > margin) return integ.access_token;
  return refreshAccessToken(admin, integ);
}

// ---------- Roteamento por ambiente ----------

/** Agenda destino da integracao para o ambiente do item. */
export function targetCalendarFor(integ: IntegrationRow, env: EnvType): string {
  if (integ.sync_mode === 'split') {
    const ids = integ.env_calendar_ids ?? {};
    return ids[env] || integ.google_calendar_id || 'primary';
  }
  return integ.google_calendar_id || 'primary';
}

/** Toggle por ambiente (ausente = ativo). */
export function envSyncEnabled(integ: IntegrationRow, env: EnvType): boolean {
  const flags = integ.env_auto_sync ?? {};
  return flags[env] !== false;
}

// ---------- Event mapping ----------

const TZ = '-03:00';

function fmtLocal(ms: number): string {
  const d = new Date(ms - 3 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00${TZ}`;
}

function pretty(v: unknown): string {
  return v ? String(v).replace(/_/g, ' ') : '';
}

// O prefixo vem do AMBIENTE do workspace — nao do label do source.
// Acoes de ambos os ambientes sao enfileiradas como 'sharks_action'
// (nome historico da tabela actions), entao decidir pelo source
// rotularia acoes Estrategos como [Sharks].
function envPrefix(env: EnvType, unified: boolean): string {
  if (!unified) return '';
  return env === 'estrategos' ? '[Estrategos] ' : '[Sharks] ';
}

// ---------- Campaign color -> Google palette ----------
// Google so aceita colorId da paleta fixa; escolhemos o tom mais proximo.

const GOOGLE_EVENT_COLORS: Record<string, string> = {
  '1': '#7986cb', '2': '#33b679', '3': '#8e24aa', '4': '#d81b60', '5': '#f6bf26',
  '6': '#f4511e', '7': '#039be5', '8': '#616161', '9': '#3f51b5', '10': '#0b8043', '11': '#d50000',
};

function nearestGoogleColor(hex: string | null | undefined): string | undefined {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return undefined;
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  let best: string | undefined;
  let bestDist = Infinity;
  for (const [id, c] of Object.entries(GOOGLE_EVENT_COLORS)) {
    const cr = parseInt(c.slice(1, 3), 16), cg = parseInt(c.slice(3, 5), 16), cb = parseInt(c.slice(5, 7), 16);
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < bestDist) { bestDist = d; best = id; }
  }
  return best;
}

// Lembrete padrao: popup 30 minutos antes da acao/campanha/reuniao
const REMINDERS_30 = { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] };

export function buildEventBody(
  source: QueueSource,
  row: Record<string, any>,
  integ: IntegrationRow,
  env: EnvType = 'sharks_company',
  wsName?: string,
): Record<string, unknown> {
  const unified = integ.sync_mode !== 'split';
  const prefix = envPrefix(env, unified);

  if (source === 'campaign') {
    const lines: string[] = [];
    if (wsName) lines.push(`Cliente: ${wsName}`);
    if (row.objective) lines.push(`Objetivo: ${row.objective}`);
    if (row.audience) lines.push(`Publico: ${row.audience}`);
    if (row.product) lines.push(`Produto: ${row.product}`);
    if (row.description) lines.push(`${row.description}`);
    lines.push('');
    lines.push('Campanha sinalizada automaticamente pelo Oracullo Calendar');

    const startDay = String(row.start_date).slice(0, 10);
    const endDay = new Date(Date.parse(`${String(row.end_date || row.start_date).slice(0, 10)}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const body: Record<string, unknown> = {
      summary: `${prefix}\u{1F3C1} ${row.name ?? ''}`,
      description: lines.join('\n'),
      start: { date: startDay },
      end: { date: endDay },
      transparency: 'transparent',
      reminders: REMINDERS_30,
    };
    const colorId = nearestGoogleColor(row.color);
    if (colorId) body.colorId = colorId;
    return body;
  }

  if (source === 'estrategos_meeting' || source === 'estrategos_implementation') {
    const lines: string[] = [];
    if (wsName) lines.push(`Cliente: ${wsName}`);
    if (source === 'estrategos_implementation' && row.system_name) {
      lines.push(`Sistema: ${row.system_name}`);
    }
    if (row.description) lines.push(`Descricao:\n${row.description}`);
    if (source === 'estrategos_meeting' && Array.isArray(row.attendees) && row.attendees.length) {
      lines.push(`Participantes: ${row.attendees.join(', ')}`);
    }
    if (row.location) lines.push(`Local: ${row.location}`);
    lines.push('');
    lines.push('Sincronizado automaticamente pelo Oracullo Calendar');

    const date = source === 'estrategos_meeting' ? row.meeting_date : row.target_date;
    const time = source === 'estrategos_meeting' ? row.meeting_time : null;
    let start: Record<string, string>;
    let end: Record<string, string>;
    if (time) {
      const [hh, mm] = String(time).slice(0, 5).split(':');
      const startMs = Date.parse(`${date}T${hh}:${mm}:00${TZ}`);
      const dur = source === 'estrategos_meeting' ? (row.duration_minutes ?? 60) * 60_000 : 60 * 60_000;
      start = { dateTime: fmtLocal(startMs), timeZone: 'America/Sao_Paulo' };
      end = { dateTime: fmtLocal(startMs + dur), timeZone: 'America/Sao_Paulo' };
    } else {
      const nextDay = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      start = { date };
      end = { date: nextDay };
    }
    return { summary: `${prefix}${row.title ?? row.name ?? ''}`, description: lines.join('\n'), start, end, reminders: REMINDERS_30 };
  }

  // sharks_action (formato historico validado)
  const action = row;
  const pillar = action.editorial_pillar as { name?: string } | null;
  const campaign = action.campaign as { name?: string; objective?: string } | null;

  const lines: string[] = [];
  if (wsName) lines.push(`Cliente: ${wsName}`);
  if (action.channel) lines.push(`Canal: ${action.channel}`);
  if (action.channels?.length) lines.push(`Canais: ${action.channels.join(', ')}`);
  const tipo = pretty(action.format) || pretty(action.action_type);
  if (tipo) lines.push(`Tipo/Formato: ${tipo}`);
  if (pillar?.name) lines.push(`Pilar: ${pillar.name}`);
  if (campaign?.name) lines.push(`Campanha: ${campaign.name}${campaign.objective ? ` (${pretty(campaign.objective)})` : ''}`);
  if (action.theme) lines.push(`Tema: ${action.theme}`);
  if (action.hook) lines.push(`Gancho: ${action.hook}`);
  if (action.main_message) lines.push(`Mensagem principal: ${action.main_message}`);
  if (action.copy_text) lines.push(`Copy:\n${action.copy_text}`);
  if (action.cta) lines.push(`CTA: ${action.cta}`);
  if (action.audience) lines.push(`Publico: ${action.audience}`);
  if (action.product) lines.push(`Produto: ${action.product}`);
  if (action.description) lines.push(`Descricao:\n${action.description}`);
  if (action.observations) lines.push(`Observacoes:\n${action.observations}`);
  lines.push('');
  lines.push('Sincronizado automaticamente pelo Oracullo Calendar');

  const LONG_TYPES = new Set(['event', 'meeting', 'recording', 'photo_session', 'live']);
  let start: Record<string, string>;
  let end: Record<string, string>;
  if (action.action_time) {
    const [hh, mm] = String(action.action_time).slice(0, 5).split(':');
    const startMs = Date.parse(`${action.action_date}T${hh}:${mm}:00${TZ}`);
    const dur = LONG_TYPES.has(String(action.action_type)) ? 60 : 30;
    start = { dateTime: fmtLocal(startMs), timeZone: 'America/Sao_Paulo' };
    end = { dateTime: fmtLocal(startMs + dur * 60_000), timeZone: 'America/Sao_Paulo' };
  } else {
    const nextDay = new Date(Date.parse(`${action.action_date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    start = { date: action.action_date };
    end = { date: nextDay };
  }

  return { summary: `${prefix}${action.title}`, description: lines.join('\n'), start, end, reminders: REMINDERS_30 };
}

// ---------- Queue processing ----------

const NULL_UUID = '00000000-0000-0000-0000-000000000000';

async function gFetch(url: string, init: RequestInit, token: string): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body) headers.set('Content-Type', 'application/json');
  return fetch(url, { ...init, headers });
}

// ---------- Idempotencia de criacao ----------
// Se um evento foi criado mas o link nao persistiu (falha transitória),
// o retry antigo fazia POST de novo -> duplicata. Agora todo POST carrega
// extendedProperties.private.srcKey e, antes de criar, buscamos por essa
// chave na agenda destino: achou, reusa; nao achou, cria.

async function findEventBySrcKey(
  token: string,
  calId: string,
  srcKey: string,
): Promise<{ id: string } | null> {
  const url =
    `${CAL_API}/calendars/${encodeURIComponent(calId)}/events` +
    `?privateExtendedProperty=${encodeURIComponent(`srcKey=${srcKey}`)}&maxResults=1`;
  const res = await gFetch(url, { method: 'GET' }, token);
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  const items = (json?.items ?? []) as Array<{ id: string }>;
  return items.length > 0 ? items[0] : null;
}

async function createIdempotentEvent(
  token: string,
  calId: string,
  srcKey: string,
  src: QueueSource,
  row: Record<string, any>,
  integ: IntegrationRow,
  env: EnvType,
  wsName?: string,
): Promise<{ id: string; reused: boolean }> {
  const existing = await findEventBySrcKey(token, calId, srcKey);
  if (existing) return { id: existing.id, reused: true };

  const body = buildEventBody(src, row, integ, env, wsName);
  body.extendedProperties = { private: { srcKey } };
  const res = await gFetch(
    `${CAL_API}/calendars/${encodeURIComponent(calId)}/events`,
    { method: 'POST', body: JSON.stringify(body) },
    token,
  );
  if (!res.ok) throw new Error(`Google ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const ev = await res.json();
  return { id: ev.id as string, reused: false };
}

export async function processWorkspace(
  admin: ReturnType<typeof serviceClient>,
  workspaceId: string,
): Promise<{ workspace_id: string; processed: number; ok: number; failed: number }> {
  const stat = { workspace_id: workspaceId, processed: 0, ok: 0, failed: 0 };

  const { data: locked } = await admin.rpc('fn_try_sync_lock', { ws: workspaceId });
  if (!locked) return { ...stat, skipped_lock: true } as typeof stat & { skipped_lock: boolean };

  try {
    // Integracoes que cobrem este workspace (por-cliente OU
    // pessoais globais), filtradas por ambiente do workspace.
    const { data: wsRow } = await admin
      .from('workspaces')
      .select('name, organization_id, organizations(environment)')
      .eq('id', workspaceId)
      .maybeSingle();
    const env = ((wsRow as { organizations?: { environment?: EnvType } } | null)?.organizations?.environment ?? 'sharks_company') as EnvType;
    const wsName = ((wsRow as { name?: string } | null)?.name) ?? undefined;

    const [{ data: wsRows }, { data: personalRows }] = await Promise.all([
      admin
        .from('calendar_integrations')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('is_connected', true)
        .eq('auto_sync', true),
      admin
        .from('calendar_integrations')
        .select('*')
        .is('workspace_id', null)
        .not('user_id', 'is', null)
        .eq('is_connected', true)
        .eq('auto_sync', true),
    ]);
    // Toggle por ambiente: pausado sai do fan-out
    const integs = ([...(wsRows ?? []), ...(personalRows ?? [])] as unknown as IntegrationRow[])
      .filter(i => envSyncEnabled(i, env));

    // Fan-out CONTIDO (anti-duplicata física): a energia da ação é UMA por
    // ação — sempre que o workspace tem accent própria (agenda da agência
    // do cliente), é ELA que recebe; as globais/pessoais cobrem só as
    // carentes. Antes, o fan-out escrevia o mesmo evento em contas cujos
    // alvos são calendários físicos diferentes -> dupleto visual no Google.
    const fanoutIntegs = (() => {
      const own = integs.filter(i => i.workspace_id === workspaceId);
      return own.length > 0 ? own : integs;
    })();

    const { data: queue } = await admin
      .from('calendar_sync_queue')
      .select(
        'id, workspace_id, action_id, source, source_id, operation, attempts, google_event_id, integration_id, ' +
        'action:actions(*, campaign:campaigns(name,objective), editorial_pillar:editorial_pillars(name))',
      )
      .eq('workspace_id', workspaceId)
      .eq('status', 'pending')
      .order('created_at')
      .limit(50);

    const now = () => new Date().toISOString();

    if (!queue || queue.length === 0) {
      if (integs.length > 0) {
        await admin
          .from('calendar_integrations')
          .update({ last_synced_at: now(), sync_error: null })
          .in('id', integs.map(i => i.id));
      }
      return stat;
    }

    // Fetch meetings/implementacoes/campanhas dos itens correspondentes
    // + acoes por id (fallback: o embed action:actions(*) depende da FK
    // action_id, que itens genericos podem nao ter).
    const meetingIds = (queue as QueueItem[]).filter(q => q.source === 'estrategos_meeting' && q.source_id).map(q => q.source_id!) as string[];
    const implIds = (queue as QueueItem[]).filter(q => q.source === 'estrategos_implementation' && q.source_id).map(q => q.source_id!) as string[];
    const campaignIds = (queue as QueueItem[]).filter(q => q.source === 'campaign' && q.source_id).map(q => q.source_id!) as string[];
    const actionIdsFallback = (queue as QueueItem[]).filter(q => q.source === 'sharks_action' && (q.source_id || q.action_id) && !q.action).map(q => (q.source_id ?? q.action_id)!) as string[];
    const meetingMap = new Map<string, Record<string, any>>();
    const implMap = new Map<string, Record<string, any>>();
    const campaignMap = new Map<string, Record<string, any>>();
    const actionMap = new Map<string, Record<string, any>>();
    if (meetingIds.length) {
      const { data: ms } = await admin.from('estrategos_meetings').select('*').in('id', meetingIds);
      for (const m of (ms ?? []) as Record<string, any>[]) meetingMap.set(m.id, m);
    }
    if (implIds.length) {
      const { data: is } = await admin.from('estrategos_implementations').select('*').in('id', implIds);
      for (const i of (is ?? []) as Record<string, any>[]) implMap.set(i.id, i);
    }
    if (campaignIds.length) {
      const { data: cs } = await admin.from('campaigns').select('*').in('id', campaignIds);
      for (const c of (cs ?? []) as Record<string, any>[]) campaignMap.set(c.id, c);
    }
    if (actionIdsFallback.length) {
      const { data: as } = await admin
        .from('actions')
        .select('*, campaign:campaigns(name,objective,color), editorial_pillar:editorial_pillars(name)')
        .in('id', actionIdsFallback);
      for (const a of (as ?? []) as Record<string, any>[]) actionMap.set(a.id, a);
    }

    // Links existentes por (source:source_id:integracao) + legado por action
    const sourceKeys = (queue as QueueItem[]).filter(q => q.source_id).map(q => `${q.source}:${q.source_id}`) as string[];
    const actionIds = queue.map(q => q.action_id).filter(Boolean) as string[];
    const linkMap = new Map<string, string>();
    {
      const { data: links } = await admin
        .from('calendar_event_links')
        .select('action_id, source, source_id, google_event_id, workspace_id, integration_id')
        .or(
          [
            actionIds.length ? `action_id.in.(${actionIds.join(',')})` : null,
            sourceKeys.length ? `and(source.in.(${queue.filter(q => q.source).map(q => q.source).join(',')}),source_id.in.(${(queue as QueueItem[]).filter(q => q.source_id).map(q => q.source_id).join(',')}))` : null,
          ].filter(Boolean).join(',') || `action_id.eq.${NULL_UUID}`,
        );
      for (const l of links ?? []) {
        if (l.source && l.source_id) {
          linkMap.set(`${l.source}:${l.source_id}:${l.integration_id}`, l.google_event_id);
        } else if (l.action_id && l.integration_id) {
          linkMap.set(`sharks_action:${l.action_id}:${l.integration_id}`, l.google_event_id);
        }
      }
    }

    // Cache de token por integracao (evita refresh repetido no fan-out)
    const tokens = new Map<string, string>();
    const tokenFor = async (integ: IntegrationRow): Promise<string> => {
      const cached = tokens.get(integ.id);
      if (cached) return cached;
      try {
        const t = await getValidToken(admin, integ);
        tokens.set(integ.id, t);
        return t;
      } catch (e) {
        await admin
          .from('calendar_integrations')
          .update({ sync_error: `Falha de autenticacao Google: ${String((e as Error).message).slice(0, 300)}` })
          .eq('id', integ.id);
        throw e;
      }
    };

    const usedIntegIds = new Set<string>();

    const syncStatusTable: Record<QueueSource, string> = {
      sharks_action: 'actions',
      estrategos_meeting: 'estrategos_meetings',
      estrategos_implementation: 'estrategos_implementations',
      campaign: 'campaigns',
    };
    const setSyncStatus = async (item: QueueItem, value: string) => {
      const src = item.source;
      const sid = item.source_id ?? item.action_id;
      if (!sid) return;
      await admin.from(syncStatusTable[src]).update({ sync_status: value }).eq('id', sid);
    };

    for (const item of queue as unknown as QueueItem[]) {
      stat.processed++;
      try {
        // Delete embutido (migration 014/025): o registro origem ja
        // foi removido; integration_id diz EM QUAL agenda apagar.
        if (item.operation === 'delete' && !item.source_id && !item.action_id) {
          let target: IntegrationRow | null = null;
          if (item.integration_id) {
            const { data: t } = await admin
              .from('calendar_integrations')
              .select('*')
              .eq('id', item.integration_id)
              .maybeSingle();
            target = (t as IntegrationRow) ?? null;
          } else if (integs.length > 0) {
            target = integs[0]; // legado: sem integration_id
          }
          if (target) {
            usedIntegIds.add(target.id);
            const token = await tokenFor(target);
            const calId = targetCalendarFor(target, env);
            const eventId = item.google_event_id;
            if (eventId) {
              const res = await gFetch(
                `${CAL_API}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`,
                { method: 'DELETE' },
                token,
              );
              if (!res.ok && res.status !== 404 && res.status !== 410) {
                throw new Error(`Google DELETE ${res.status}: ${(await res.text()).slice(0, 200)}`);
              }
            }
          }
          await admin.from('calendar_sync_queue').update({ status: 'done', processed_at: now() }).eq('id', item.id);
          stat.ok++;
          continue;
        }

        const src = item.source;
        const sid = item.source_id ?? item.action_id;
        if (!sid) {
          await admin.from('calendar_sync_queue').update({ status: 'done', processed_at: now() }).eq('id', item.id);
          continue;
        }

        if (integs.length === 0) {
          await admin
            .from('calendar_sync_queue')
            .update({ status: 'done', processed_at: now(), last_error: 'integracao inativa' })
            .eq('id', item.id);
          stat.ok++;
          continue;
        }

        if (item.operation === 'delete') {
          // Registro cancelado: remove o evento de TODAS as agendas
          const errs: string[] = [];
          let anyOk = false;
          for (const integ of integs) {
            usedIntegIds.add(integ.id);
            try {
              const eventId = linkMap.get(`${src}:${sid}:${integ.id}`);
              if (eventId) {
                const token = await tokenFor(integ);
                const calId = targetCalendarFor(integ, env);
                const res = await gFetch(
                  `${CAL_API}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`,
                  { method: 'DELETE' },
                  token,
                );
                if (!res.ok && res.status !== 404 && res.status !== 410) {
                  throw new Error(`DELETE ${res.status}`);
                }
              }
              anyOk = true;
            } catch (e) {
              errs.push(`${integ.google_account_email ?? integ.id}: ${String((e as Error).message).slice(0, 120)}`);
            }
          }
          if (!anyOk) throw new Error(errs.join(' | ').slice(0, 380));
          await admin.from('calendar_event_links').delete().match({ source: src, source_id: sid });
          await setSyncStatus(item, 'not_synced');
          await admin
            .from('calendar_sync_queue')
            .update({ status: 'done', processed_at: now(), last_error: errs.length ? `parcial: ${errs.join(' | ').slice(0, 200)}` : null })
            .eq('id', item.id);
          stat.ok++;
        } else {
          // create/update: fan-out para TODAS as integracoes ativas.
          // Dedupe: duas linhas da MESMA conta Google apontando para a
          // MESMA agenda fisica (ex.: global + agencia) geram UM unico
          // evento; a segunda linha so cria o link.
          const row =
            src === 'estrategos_meeting' ? meetingMap.get(sid) :
            src === 'estrategos_implementation' ? implMap.get(sid) :
            src === 'campaign' ? campaignMap.get(sid) :
            ((item.action as Record<string, any> | null) ?? actionMap.get(sid));
          if (!row) {
            await admin.from('calendar_sync_queue').update({ status: 'done', processed_at: now(), last_error: 'registro removido antes do sync' }).eq('id', item.id);
            stat.ok++;
            continue;
          }

          // EventId conhecido por agenda fisica (inicializado dos links existentes)
          const calEventIds = new Map<string, string>();
          const writtenCals = new Set<string>();
          for (const integ of fanoutIntegs) {
            const calId0 = targetCalendarFor(integ, env);
            const key0 = `${integ.google_account_email ?? integ.id}|${calId0}`;
            const lid = linkMap.get(`${src}:${sid}:${integ.id}`);
            if (lid && !calEventIds.has(key0)) calEventIds.set(key0, lid);
          }

          const errs: string[] = [];
          let anyOk = false;
          for (const integ of fanoutIntegs) {
            usedIntegIds.add(integ.id);
            try {
              const calId = targetCalendarFor(integ, env);
              const calKey = `${integ.google_account_email ?? integ.id}|${calId}`;

              if (writtenCals.has(calKey)) {
                // Mesma agenda fisica ja escrita neste ciclo: apenas vincula
                await admin.from('calendar_event_links').upsert({
                  action_id: src === 'sharks_action' ? sid : null,
                  source: src,
                  source_id: sid,
                  workspace_id: workspaceId,
                  integration_id: integ.id,
                  google_event_id: calEventIds.get(calKey)!,
                  last_synced_at: now(),
                  sync_status: 'synced',
                }, { onConflict: 'source,source_id,integration_id' });
                anyOk = true;
                continue;
              }

              const token = await tokenFor(integ);
              const srcKey = `${src}:${sid}`;
              const eventId = linkMap.get(`${src}:${sid}:${integ.id}`) ?? calEventIds.get(calKey) ?? undefined;
              let evId: string;
              let createdNow = false;

              if (eventId) {
                const bodyJson = JSON.stringify(buildEventBody(src, row, integ, env, wsName));
                const res = await gFetch(
                  `${CAL_API}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(eventId)}`,
                  { method: 'PATCH', body: bodyJson },
                  token,
                );
                if (res.status === 404 || res.status === 410) {
                  const created = await createIdempotentEvent(token, calId, srcKey, src, row, integ, env, wsName);
                  evId = created.id;
                  createdNow = !created.reused;
                } else if (!res.ok) {
                  throw new Error(`Google ${res.status}: ${(await res.text()).slice(0, 150)}`);
                } else {
                  evId = eventId;
                }
              } else {
                const created = await createIdempotentEvent(token, calId, srcKey, src, row, integ, env, wsName);
                evId = created.id;
                createdNow = !created.reused;
              }

              calEventIds.set(calKey, evId);
              writtenCals.add(calKey);

              try {
                await admin.from('calendar_event_links').upsert({
                  action_id: src === 'sharks_action' ? sid : null,
                  source: src,
                  source_id: sid,
                  workspace_id: workspaceId,
                  integration_id: integ.id,
                  google_event_id: evId,
                  last_synced_at: now(),
                  sync_status: 'synced',
                }, { onConflict: 'source,source_id,integration_id' });
              } catch (linkErr) {
                // Compensacao: evento recem-criado sem link persistido seria
                // re-POSTado no retry -> duplicata. Remove e falha o item.
                if (createdNow) {
                  await gFetch(
                    `${CAL_API}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(evId)}`,
                    { method: 'DELETE' },
                    token,
                  ).catch(() => {});
                  calEventIds.delete(calKey);
                  writtenCals.delete(calKey);
                }
                throw linkErr;
              }
              anyOk = true;
            } catch (e) {
              errs.push(`${integ.google_account_email ?? integ.id}: ${String((e as Error).message).slice(0, 120)}`);
            }
          }
          await setSyncStatus(item, anyOk ? 'synced' : 'sync_error');
          if (!anyOk) throw new Error(errs.join(' | ').slice(0, 380));
          await admin
            .from('calendar_sync_queue')
            .update({ status: 'done', processed_at: now(), last_error: errs.length ? `parcial: ${errs.join(' | ').slice(0, 200)}` : null })
            .eq('id', item.id);
          stat.ok++;
        }
      } catch (e) {
        stat.failed++;
        const msg = String((e as Error).message ?? e).slice(0, 400);
        const attempts = (item.attempts ?? 0) + 1;
        await admin
          .from('calendar_sync_queue')
          .update({ attempts, last_error: msg, status: attempts >= 5 ? 'error' : 'pending' })
          .eq('id', item.id);
      }
    }

    // Heartbeat nas integracoes efetivamente usadas neste ciclo
    if (usedIntegIds.size > 0) {
      await admin
        .from('calendar_integrations')
        .update({
          last_synced_at: new Date().toISOString(),
          sync_error: stat.failed ? `${stat.failed} item(ns) falharam no ultimo ciclo` : null,
        })
        .in('id', [...usedIntegIds]);
    }

    return stat;
  } finally {
    await admin.rpc('fn_release_sync_lock', { ws: workspaceId });
  }
}

// ==========================================
// Re-sync completo de um workspace: remove
// eventos antigos (best-effort nas agendas
// informadas), limpa links, reseta status e
// re-enfileira TUDO para o destino atual.
// Usado por set_target, change_sync_mode e
// reparo manual de links orfaos.
// ==========================================

export async function resyncWorkspace(
  admin: ReturnType<typeof serviceClient>,
  wsId: string,
  deletePlan: Array<{ integId: string; calIds: string[] }> = [],
): Promise<{ removed_events: number; enqueued: number }> {
  // 1. eventos antigos: tenta DELETE com o token de cada integracao
  //    nas agendas antigas listadas (404/410 sao engolidos).
  const { data: links } = await admin
    .from('calendar_event_links')
    .select('google_event_id')
    .eq('workspace_id', wsId);
  const eventIds = [...new Set((links ?? []).map(l => l.google_event_id).filter(Boolean))] as string[];

  let removed = 0;
  if (eventIds.length && deletePlan.length) {
    const integCache = new Map<string, IntegrationRow | null>();
    for (const plan of deletePlan) {
      let integ = integCache.get(plan.integId);
      if (integ === undefined) {
        const { data: row } = await admin.from('calendar_integrations').select('*').eq('id', plan.integId).maybeSingle();
        integ = (row as IntegrationRow) ?? null;
        integCache.set(plan.integId, integ);
      }
      if (!integ?.refresh_token) continue;
      let token: string;
      try {
        token = await getValidToken(admin, integ);
      } catch {
        continue;
      }
      for (const evId of eventIds) {
        for (const calId of plan.calIds) {
          const res = await fetch(
            `${CAL_API}/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(evId)}`,
            { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
          ).catch(() => null);
          if (res && res.ok) removed++;
        }
      }
    }
  }

  // 2. limpa links e pendencias antigas
  await admin.from('calendar_event_links').delete().eq('workspace_id', wsId);
  await admin.from('calendar_sync_queue').delete().eq('workspace_id', wsId).in('status', ['pending', 'error']);

  // 3. reseta status de sync
  await admin.from('actions').update({ sync_status: 'not_synced' }).eq('workspace_id', wsId).neq('sync_status', 'not_synced');
  await admin.from('estrategos_meetings').update({ sync_status: 'not_synced' }).eq('workspace_id', wsId).neq('sync_status', 'not_synced');
  await admin.from('estrategos_implementations').update({ sync_status: 'not_synced' }).eq('workspace_id', wsId).neq('sync_status', 'not_synced');
  await admin.from('campaigns').update({ sync_status: 'not_synced' }).eq('workspace_id', wsId).neq('sync_status', 'not_synced');

  // 4. re-enfileira tudo que deve existir no Google
  //    (rascunhos ficam de fora — mesma semântica do trigger de enqueue)
  let enqueued = 0;
  const { data: acts } = await admin
    .from('actions')
    .select('id')
    .eq('workspace_id', wsId)
    .in('status', ['briefing', 'in_production', 'sharks_review', 'scheduled', 'published', 'completed']);
  if (acts?.length) {
    await admin.from('calendar_sync_queue').insert(
      acts.map(a => ({ workspace_id: wsId, action_id: a.id, source: 'sharks_action' as const, source_id: a.id, operation: 'create' as const })),
    );
    enqueued += acts.length;
  }
  const { data: meets } = await admin.from('estrategos_meetings').select('id').eq('workspace_id', wsId).neq('status', 'cancelled');
  if (meets?.length) {
    await admin.from('calendar_sync_queue').insert(
      meets.map(m => ({ workspace_id: wsId, source: 'estrategos_meeting' as const, source_id: m.id, operation: 'create' as const })),
    );
    enqueued += meets.length;
  }
  const { data: impls } = await admin.from('estrategos_implementations').select('id').eq('workspace_id', wsId).not('status', 'in', '(cancelled,completed)');
  if (impls?.length) {
    await admin.from('calendar_sync_queue').insert(
      impls.map(i => ({ workspace_id: wsId, source: 'estrategos_implementation' as const, source_id: i.id, operation: 'create' as const })),
    );
    enqueued += impls.length;
  }
  const { data: camps } = await admin
    .from('campaigns')
    .select('id')
    .eq('workspace_id', wsId)
    .in('status', ['active', 'draft'])
    .not('start_date', 'is', null);
  if (camps?.length) {
    await admin.from('calendar_sync_queue').insert(
      camps.map(c => ({ workspace_id: wsId, source: 'campaign' as const, source_id: c.id, operation: 'create' as const })),
    );
    enqueued += camps.length;
  }

  return { removed_events: removed, enqueued };
}
