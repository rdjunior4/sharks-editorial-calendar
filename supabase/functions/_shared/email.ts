// ==========================================
// SHARED: E-mail transacional via Resend
// Best-effort: falhas nunca bloqueiam a
// operacao principal — apenas logam.
// Requer secret RESEND_API_KEY no projeto.
// ==========================================

const RESEND_API = 'https://api.resend.com/emails';
const FROM = 'Oracullo Agenda <noreply@grupooracullo.com>';

export interface SendEmailOpts {
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail(opts: SendEmailOpts): Promise<{ ok: boolean; error?: string }> {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) {
    console.warn('[email] RESEND_API_KEY nao configurado — e-mail nao enviado:', opts.subject);
    return { ok: false, error: 'RESEND_API_KEY nao configurado' };
  }
  try {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [opts.to], subject: opts.subject, html: opts.html }),
    });
    if (!res.ok) {
      const err = (await res.text()).slice(0, 200);
      console.error('[email] Resend erro:', res.status, err);
      return { ok: false, error: `Resend ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    console.error('[email] falha:', (e as Error).message);
    return { ok: false, error: (e as Error).message };
  }
}

// ---------- templates ----------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background-color:#f8fafc;font-family:Arial,Helvetica,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
          <tr>
            <td style="background:#0066FF;padding:20px 28px;">
              <span style="color:#ffffff;font-size:18px;font-weight:bold;">Oracullo Agenda</span>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;">
              <h1 style="color:#0f172a;font-size:18px;margin:0 0 14px;">${esc(title)}</h1>
              ${body}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 28px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:11px;">
              Mensagem automatica do Oracullo Agenda — grupooracullo.com
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

const P_OPEN = '<p style="color:#334155;font-size:14px;line-height:1.6;margin:0 0 12px;">';
const P_CLOSE = '</p>';

function button(label: string, url: string): string {
  return `<a href="${esc(url)}" style="display:inline-block;background:#0066FF;color:#ffffff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:14px;margin:8px 0 4px;">${esc(label)}</a>`;
}

function passwordBox(pwd: string): string {
  return `<div style="background:#f1f5f9;border:1px dashed #94a3b8;border-radius:8px;padding:14px 18px;margin:14px 0;text-align:center;">
    <div style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;">Senha temporaria</div>
    <div style="font-family:Courier,monospace;font-size:18px;font-weight:bold;color:#0f172a;">${esc(pwd)}</div>
  </div>`;
}

export function appLoginUrl(): string {
  return `${Deno.env.get('APP_URL') ?? 'https://agenda.grupooracullo.com'}/login`;
}

/* ---------- e-mail de prospecção (canal email do agente) ---------- */

export function prospectionEmail(params: { leadName: string; subject: string | null; message: string }): { subject: string; html: string } {
  const paragraphs = params.message
    .split(/\n{1,}/)
    .filter(l => l.trim())
    .map(l => `<p style="color:#334155;font-size:14px;line-height:1.7;margin:0 0 12px;">${esc(l.trim())}</p>`)
    .join('');
  const body = `
    <div style="background:#f8fafc;border-radius:8px;padding:18px 20px;border:1px solid #eceff5;">
      ${paragraphs || '<p></p>'}
    </div>`;
  return {
    subject: params.subject?.trim() || 'Uma ideia para o seu negócio',
    html: layout(`Olá, ${esc(params.leadName)}`, body),
  };
}

// ---------- aprovacao de acesso ----------

export function approvedAccessEmail(params: {
  name: string;
  roleLabel: string;
  envLabels: string;
  authProvider: 'google' | 'password';
  tempPassword: string | null;
}): { subject: string; html: string } {
  const { name, roleLabel, envLabels, authProvider, tempPassword } = params;
  const loginUrl = appLoginUrl();

  let body = `
    ${P_OPEN}Ola, <strong>${esc(name)}</strong>,${P_CLOSE}
    ${P_OPEN}Seu acesso ao <strong>Oracullo Agenda</strong> foi aprovado como <strong>${esc(roleLabel)}</strong> no(s) ambiente(s): <strong>${esc(envLabels)}</strong>.${P_CLOSE}`;

  if (authProvider === 'password' && tempPassword) {
    body += `
    ${P_OPEN}Use o seu e-mail e a senha temporaria abaixo para entrar:${P_CLOSE}
    ${passwordBox(tempPassword)}
    ${P_OPEN}Recomendamos alterar a senha apos o primeiro acesso.${P_CLOSE}`;
  } else {
    body += `
    ${P_OPEN}Como sua conta ja existe, basta usar o botao <strong>Entrar com Google</strong> na tela de login.${P_CLOSE}`;
  }

  body += `<div style="text-align:center;">${button('Acessar o Oracullo Agenda', loginUrl)}</div>`;

  return { subject: 'Seu acesso ao Oracullo Agenda foi aprovado', html: layout('Acesso aprovado', body) };
}

// ---------- rejeicao de acesso ----------

export function rejectedAccessEmail(params: { name: string; reason?: string | null }): { subject: string; html: string } {
  const { name, reason } = params;

  let body = `
    ${P_OPEN}Ola, <strong>${esc(name)}</strong>,${P_CLOSE}
    ${P_OPEN}Agradecemos o interesse no <strong>Oracullo Agenda</strong>.${P_CLOSE}
    ${P_OPEN}Após analise, sua solicitacao de acesso <strong>nao foi aprovada</strong> neste momento.${P_CLOSE}`;

  if (reason) {
    body += `
    <div style="background:#f8fafc;border-left:3px solid #0066FF;border-radius:6px;padding:12px 16px;margin:14px 0;color:#334155;font-size:13px;">
      ${esc(reason)}
    </div>`;
  }

  body += `${P_OPEN}Se acredita que isso foi um engano, responda este e-mail ou fale com o seu gestor.${P_CLOSE}`;

  return { subject: 'Solicitacao de acesso ao Oracullo Agenda', html: layout('Solicitacao de acesso', body) };
}

// ---------- usuario criado pelo admin ----------

export function welcomeEmail(params: { name: string; roleLabel: string; password: string }): { subject: string; html: string } {
  const { name, roleLabel, password } = params;
  const loginUrl = appLoginUrl();

  const body = `
    ${P_OPEN}Ola, <strong>${esc(name)}</strong>,${P_CLOSE}
    ${P_OPEN}Sua conta foi criada no <strong>Oracullo Agenda</strong> como <strong>${esc(roleLabel)}</strong>.${P_CLOSE}
    ${P_OPEN}Use o seu e-mail e a senha abaixo para entrar:${P_CLOSE}
    ${passwordBox(password)}
    ${P_OPEN}Recomendamos alterar a senha apos o primeiro acesso.${P_CLOSE}
    <div style="text-align:center;">${button('Acessar o Oracullo Agenda', loginUrl)}</div>`;

  return { subject: 'Sua conta no Oracullo Agenda', html: layout('Bem-vindo(a) ao Oracullo Agenda', body) };
}