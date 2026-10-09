/** Data atual no fuso da agenda (America/Sao_Paulo) — independe do TZ do browser.
 *  Igual ao TZ dos calendários no Google (google-sync), evita "hoje" deslocado. */
const AGENDA_TZ = 'America/Sao_Paulo';

export function localDate(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: AGENDA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
