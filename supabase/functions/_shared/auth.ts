/* ─── Auth das Edges worker (H1 hardening) ───
   Valida x-worker-secret E, quando WORKER_SIGNING_KEY está configurado,
   exige HMAC-SHA256 do payload:
     signature = base64( HMAC(SIGNING_KEY, "<ts>.<rawBody>") )
     header  = "t=<ts>,v=<signature>"
   Janela de 5 min contra replay. Sem SIGNING_KEY → modo legacy
   (só secret; n8n sem o nó de assinatura continua funcionando).

   Uso na Edge:
     const auth = await verifyWorker(req, rawBodyText);
     if (!auth.ok) return json(auth.status, { error: auth.error });
     const body = JSON.parse(rawBodyText);
   */

function edgeEnv(k: string): string | undefined {
  const d = (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno;
  return d?.env.get(k);
}

/** base64-decode helper — btoa é limitado; decoder robusto para textos binários */
export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacRaw(key: string, msg: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(msg));
  return new Uint8Array(sig);
}

function b64encode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface WorkerAuthResult {
  ok: boolean;
  status: number;
  error?: string;
}

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

export async function verifyWorker(req: Request, rawBody: string): Promise<WorkerAuthResult> {
  const workerSecret = edgeEnv('WORKER_SECRET');
  const signingKey = edgeEnv('WORKER_SIGNING_KEY');

  // Caminho interno: Edge→Edge dentro do próprio projeto (ex.: ingest →
  // cérebro da conversa). O token de serviço é uma Edge env — nunca exposto.
  const internalToken = req.headers.get('x-internal-token');
  if (signingKey && internalToken && timingSafeEq(internalToken, signingKey)) {
    return { ok: true, status: 200 };
  }

  if (!workerSecret) return { ok: false, status: 401, error: 'Worker secret não configurado no Edge' };

  const providedSecret = req.headers.get('x-worker-secret');
  if (!providedSecret || !timingSafeEq(providedSecret, workerSecret)) {
    return { ok: false, status: 401, error: 'Worker secret invalido' };
  }

  if (!signingKey) return { ok: true, status: 200 }; // legacy: secret basta

  // Modo assinado: header "t=<unix-sec>,v=<base64 sig>"
  const auth = req.headers.get('x-signature') ?? '';
  const m = auth.match(/^t=(\d+),v=([A-Za-z0-9+/=]+)$/);
  if (!m) return { ok: false, status: 401, error: 'Assinatura obrigatória (x-signature: t=<ts>,v=<sig>)' };

  const ts = Number(m[1]);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) * 1000 > REPLAY_WINDOW_MS) {
    return { ok: false, status: 401, error: 'Timestamp fora da janela de 5 min' };
  }

  const expected = b64encode(await hmacRaw(signingKey, `${ts}.${rawBody}`));
  if (!timingSafeEq(expected, m[2] ?? '')) {
    return { ok: false, status: 401, error: 'Assinatura inválida' };
  }
  return { ok: true, status: 200 };
}
