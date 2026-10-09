// ==========================================
// prospecting-status — status dos canais de integração do agente
// Auth: JWT de staff (Authorization: Bearer). Sem segredos na resposta.
// ==========================================

import { serviceClient, corsHeaders } from '../_shared/google.ts';
import { hasRealSpeech } from '../_shared/prospecting/speech.ts';

const CORS: Record<string, string> = {};
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

Deno.serve(async req => {
  Object.assign(CORS, corsHeaders(req));
  try {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'GET') return json(405, { error: 'Use GET' });

    // Valida o JWT de verdade (só staff autenticado consulta;
    // a resposta nunca expõe valores, só presença dos secrets)
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json(401, { error: 'Token ausente' });
    const admin = serviceClient();
    const { data: userData } = await admin.auth.getUser(authHeader.replace(/^Bearer /i, ''));
    if (!userData?.user) return json(401, { error: 'Token invalido' });

    const channels = {
      decision_ai: !!Deno.env.get('TYPESAFE_API_KEY'),
      generative_ai: !!Deno.env.get('GLM_API_KEY'),
      google_places: !!Deno.env.get('GOOGLE_PLACES_API_KEY'),
      firecrawl: !!Deno.env.get('FIRECRAWL_API_KEY'),
      resend: !!Deno.env.get('RESEND_API_KEY'),
      meta: !!Deno.env.get('META_APP_SECRET') && !!Deno.env.get('META_PAGE_TOKEN'),
      n8n: !!Deno.env.get('N8N_WEBHOOK_URL'),
      speech: hasRealSpeech(),
    };

    return json(200, { channels });
  } catch (e) {
    return json(500, { error: `Erro interno: ${(e as Error)?.message || String(e)}` });
  }
});
