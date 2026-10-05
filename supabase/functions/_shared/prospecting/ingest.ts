/* ─── Ingest de leads inbound (Meta/Google/Website) ───
   Funções puras testáveis + helpers que recebem o client de serviço. */

export interface NormalizedContact {
  name: string;
  email: string | null;
  phone: string | null;
}

export function normalizeEmail(email: string | null | undefined): string | null {
  const v = (email ?? '').trim().toLowerCase();
  return v.includes('@') ? v : null;
}

export function normalizePhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= 8 ? digits : null;
}

/** Meta leadgen: field_data chega como [{name, values[]}] */
export function mapMetaLeadFields(fieldData: Array<{ name?: string; values?: string[] }>): NormalizedContact {
  const get = (key: string) => {
    const item = (fieldData ?? []).find(f => (f.name ?? '').toLowerCase() === key);
    return item?.values?.[0] ?? '';
  };
  const email = normalizeEmail(get('email'));
  const phone = normalizePhone(get('phone_number') || get('phone'));
  const name = (get('full_name') || [get('first_name'), get('last_name')].filter(Boolean).join(' ')).trim();
  return { name, email, phone };
}

/* ─── IG-2: gatilhos por palavra-chave (comentários/DMs) ─── */

/** lower + sem acentos + só letras/números/espaço — para matching tolerante */
export function normalizeTriggerText(v: string | null | undefined): string {
  return (v ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Alguma keyword da campanha aparece no texto? (substring, palavra ≥ 3 chars) */
export function matchesTriggers(text: string | null | undefined, keywords: string[] | null | undefined): boolean {
  const hay = normalizeTriggerText(text);
  if (!hay) return false;
  return (keywords ?? []).some(k => {
    const needle = normalizeTriggerText(k);
    return needle.length >= 3 && hay.includes(needle);
  });
}

/**
 * Dedupe idempotente de eventos Meta (webhook reenvia em retry):
 * compara o id do evento com o último registrado no ai_data do lead.
 */
export function shouldProcessEvent(
  aiData: unknown,
  field: 'event' | string,
  eventId: string,
  idKey: string,
): boolean {
  if (!eventId) return true;
  const meta = (aiData ?? null) as { [k: string]: unknown } | null;
  const last = meta?.[idKey];
  return typeof last !== 'string' || last !== eventId;
}

/** Extrai os leadgen de um webhook Meta (pode vir múltiplos entries/changes). */export function extractMetaLeadIds(payload: Record<string, unknown>): Array<{ pageId: string; leadId: string }> {
  const out: Array<{ pageId: string; leadId: string }> = [];
  const entries = (payload?.entry ?? []) as Array<Record<string, unknown>>;
  for (const entry of entries) {
    const pageId = String(entry?.id ?? '');
    const changes = (entry?.changes ?? []) as Array<Record<string, unknown>>;
    for (const change of changes) {
      if (change?.field !== 'leadgen') continue;
      const value = (change?.value ?? {}) as Record<string, unknown>;
      if (value?.lead_id) out.push({ pageId, leadId: String(value.lead_id) });
    }
  }
  return out;
}

export interface IngestInput {
  environment: string;
  source: string;
  campaign_id?: string | null;
  contact: NormalizedContact;
  company?: string | null;
  message?: string | null;
}

/** Busca lead existente do ambiente por e-mail OU telefone. */
export async function findExistingLead(
  admin: { from: (t: string) => any },
  environment: string,
  contact: NormalizedContact,
): Promise<{ id: string; full_name: string } | null> {
  const filters: string[] = [];
  if (contact.email) filters.push(`contact_email.eq.${contact.email}`);
  if (contact.phone) filters.push(`contact_phone.eq.${contact.phone}`);
  if (filters.length === 0) return null;

  const { data } = await admin
    .from('crm_leads')
    .select('id, full_name: name')
    .eq('environment', environment)
    .or(filters.join(','))
    .limit(1)
    .maybeSingle();
  return (data as unknown as { id: string; full_name: string }) ?? null;
}

/** Cria o lead inbound (origin='inbound') + atividade de captação. */
export async function createInboundLead(
  admin: { from: (t: string) => any },
  input: IngestInput,
): Promise<{ leadId: string }> {
  const { data: lead, error: leadErr } = await admin
    .from('crm_leads')
    .insert({
      environment: input.environment,
      name: input.contact.name || input.company || input.contact.email || input.contact.phone || 'Lead inbound',
      contact_name: input.contact.name || null,
      contact_email: input.contact.email,
      contact_phone: input.contact.phone,
      segment: input.company || null,
      source: input.source,
      origin: 'inbound',
      notes: input.message || null,
      ...(input.campaign_id ? { prospecting_campaign_id: input.campaign_id } : {}),
    })
    .select('id')
    .single();
  if (leadErr) throw new Error(`Criar lead: ${leadErr.message}`);

  const { error: actErr } = await admin
    .from('crm_lead_activities')
    .insert({
      lead_id: lead.id,
      type: 'system',
      content: `Lead captado via ${input.source}.`,
    });
  if (actErr) console.error('[ingest] atividade falhou:', actErr.message);

  return { leadId: lead.id as string };
}

/** Registra reengajamento em lead existente (sem duplicar). */
export async function registerReengagement(
  admin: { from: (t: string) => any },
  leadId: string,
  source: string,
  message: string | null,
): Promise<void> {
  const { error } = await admin
    .from('crm_lead_activities')
    .insert({
      lead_id: leadId,
      type: 'system',
      content: `Reengajou via ${source}.${message ? ` Mensagem: ${message}` : ''}`,
    });
  if (error) console.error('[ingest] reengajamento falhou:', error.message);
}
