// ==========================================
// prospecting-job-callback — encerra jobs externos
//
// Recebe o resultado de executores externos (n8n) para jobs
// marcados como 'processing' pelo prospecting-run.
// Auth: x-worker-secret. Idempotente: callback tardio é ignorado.
// ==========================================

import { serviceClient, corsHeaders } from '../_shared/google.ts';
import { verifyWorker } from '../_shared/auth.ts';

const CORS: Record<string, string> = {};
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async req => {
  Object.assign(CORS, corsHeaders(req));
  try {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    if (req.method !== 'POST') return json(405, { error: 'Use POST' });

    const rawBody = await req.text();
    const auth = await verifyWorker(req, rawBody);
    if (!auth.ok) return json(auth.status, { error: auth.error });

    const body = (() => { try { return JSON.parse(rawBody); } catch { return null; } })();
    const jobId: string = body?.job_id ?? '';
    const status: string = body?.status ?? '';
    if (!UUID_RE.test(jobId)) return json(400, { error: 'job_id (UUID) obrigatorio' });
    if (!['completed', 'failed', 'retry'].includes(status)) {
      return json(400, { error: "status deve ser 'completed', 'failed' ou 'retry'" });
    }

    const admin = serviceClient();
    const { data: job } = await admin
      .from('prospecting_jobs')
      .select('id, status, type, lead_id, campaign_id, input')
      .eq('id', jobId)
      .maybeSingle();
    if (!job) return json(404, { error: 'Job nao encontrado' });
    if ((job as { status: string }).status !== 'processing') {
      // Callback duplicado/tardio — idempotente
      return json(200, { ok: true, ignored: true, current_status: (job as { status: string }).status });
    }

    const patch: Record<string, unknown> =
      status === 'completed'
        ? { status: 'completed', output: body?.output ?? {}, error: null, completed_at: new Date().toISOString() }
        : status === 'failed'
        ? { status: 'failed', error: String(body?.error ?? 'Falha reportada pelo executor'), completed_at: new Date().toISOString() }
        : { status: 'retry', error: String(body?.error ?? 'Reagendado pelo executor'), scheduled_at: new Date(Date.now() + 5 * 60 * 1000).toISOString() };

    const { error: upErr } = await admin
      .from('prospecting_jobs')
      .update(patch)
      .eq('id', jobId);
    if (upErr) return json(500, { error: `Atualizar job: ${upErr.message}` });

    // ─── Envio concluído → registra na timeline e move o lead na esteira ───
    const jrow = job as { type?: string; lead_id?: string | null; input?: { message?: string } | null };
    if (status === 'completed' && jrow.type === 'send_message' && jrow.lead_id) {
      const message = String(jrow.input?.message ?? '');
      const { error: actErr } = await admin.from('crm_lead_activities').insert({
        lead_id: jrow.lead_id,
        type: 'outreach_sent',
        content: `🤖 Mensagem enviada pela esteira do agente: ${message.slice(0, 300) || '(conteúdo no job)'}`,
      });
      if (actErr) console.error('[prospecting-job-callback] atividade falhou:', actErr.message);
      await admin
        .from('crm_leads')
        .update({ prospecting_status: 'contacted', last_contact_at: new Date().toISOString() })
        .eq('id', jrow.lead_id)
        .or('prospecting_status.eq.queued,prospecting_status.eq.qualified');
    }

    // ─── M4: número sem WhatsApp → descarta o lead (para follow-ups também) ───
    if (status === 'failed' && jrow.type === 'send_message' && jrow.lead_id) {
      const errText = String(body?.error ?? '').toLowerCase();
      const invalidNumber = /número|numero/.test(errText) && /inexistente|não existe|nao existe|inválido|invalido|sem whatsapp/.test(errText)
        || /not.?exist|invalid.?number|whatsapp.?404|no.?whatsapp/.test(errText)
        || /\b404\b/.test(errText) && /whatsapp|evolution|mensagem/.test(errText);
      if (invalidNumber) {
        await admin
          .from('crm_leads')
          .update({ prospecting_status: 'discarded', lost_reason: 'Número sem WhatsApp — descartado pela esteira do agente' })
          .eq('id', jrow.lead_id);
        await admin.from('crm_lead_activities').insert({
          lead_id: jrow.lead_id,
          type: 'system',
          content: '📵 Número não existe no WhatsApp — lead descartado e follow-ups interrompidos.',
        });
        return json(200, { ok: true, job_id: jobId, status, lead_discarded: true });
      }
    }

    return json(200, { ok: true, job_id: jobId, status });
  } catch (e) {
    console.error('[prospecting-job-callback] uncaught:', (e as Error)?.stack || e);
    return json(500, { error: `Erro interno: ${(e as Error)?.message || String(e)}` });
  }
});
