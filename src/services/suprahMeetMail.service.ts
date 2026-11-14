import nodemailer from 'nodemailer';
import type { IMeeting } from '../models/Meeting.model';

/**
 * Suprah Meet — recording-distribution mailer.
 *
 * Self-contained SMTP sender (nodemailer). If the platform already has a
 * central mail service (e.g. the one behind Suprah Mail / SES), swap the
 * transport below for it — only sendRecordingEmail's body builder matters.
 *
 * Env:
 *   MEET_SMTP_HOST, MEET_SMTP_PORT (587), MEET_SMTP_SECURE ("true" for 465),
 *   MEET_SMTP_USER, MEET_SMTP_PASS, MEET_SMTP_FROM ("Suprah Meet <meet@...>")
 */

function mailSettings() {
  const dedicated = Boolean(process.env.MEET_SMTP_HOST);
  const prefix = dedicated ? 'MEET_SMTP_' : 'SMTP_';
  const port = Number(process.env[`${prefix}PORT`] || 587);
  return { host: process.env[`${prefix}HOST`], port,
    secure: process.env[`${prefix}SECURE`] === 'true' || port === 465,
    user: process.env[`${prefix}USER`], pass: process.env[`${prefix}PASS`],
    from: process.env.MEET_SMTP_FROM || process.env.SMTP_FROM || (!dedicated ? process.env.SMTP_USER : undefined) };
}

export function mailConfigured(): boolean {
  const settings = mailSettings();
  return Boolean(settings.host && settings.from);
}

let transporter: nodemailer.Transporter | null = null;
function getTransporter(): nodemailer.Transporter {
  if (!transporter) {
    const settings = mailSettings();
    transporter = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
      auth: settings.user
        ? { user: settings.user, pass: settings.pass }
        : undefined,
    });
  }
  return transporter;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function summaryHtml(summary: IMeeting['ai']['summary'] | null | undefined): string {
  if (!summary?.overview) {
    return `<p style="margin:0;color:#6b7b74;font-size:13px">The AI summary wasn't available for this meeting.</p>`;
  }
  const list = (label: string, items?: string[]) =>
    items && items.length
      ? `<p style="margin:14px 0 4px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#059669"><strong>${label}</strong></p>
         <ul style="margin:0;padding-left:18px;color:#1f2937;font-size:14px;line-height:1.55">
           ${items.map((i) => `<li>${esc(i)}</li>`).join('')}
         </ul>`
      : '';
  return `
    <p style="margin:0;color:#1f2937;font-size:14px;line-height:1.6">${esc(summary.overview)}</p>
    ${list('Key points', summary.keyPoints)}
    ${list('Decisions', summary.decisions)}
    ${list('Action items', summary.actionItems)}
  `;
}

export async function sendRecordingEmail(opts: {
  to: string;
  recipientName: string;
  meetingTitle: string;
  code: string;
  whenStr: string;          // e.g. "Oct 5, 2026 · 2:00 PM MT"
  durationMin: number | null;
  link: string;             // tokenized secure recording page
  summary: IMeeting['ai']['summary'] | null | undefined;
  recordingAvailable?: boolean;
}): Promise<void> {
  const { to, recipientName, meetingTitle, code, whenStr, durationMin, link, summary } = opts;
  const recordingAvailable = opts.recordingAvailable !== false;
  const first = esc((recipientName || '').split(' ')[0] || 'there');
  const html = `
  <div style="background:#f3f6f5;padding:28px 12px;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #d7e5df;border-radius:16px;overflow:hidden">
      <div style="background:#071410;padding:18px 24px">
        <span style="color:#34d399;font-size:16px;font-weight:700;letter-spacing:.02em">Suprah&nbsp;Meet</span>
      </div>
      <div style="padding:24px">
        <p style="margin:0 0 6px;color:#1f2937;font-size:15px">Hi ${first},</p>
        <p style="margin:0 0 18px;color:#4b5563;font-size:14px;line-height:1.6">
          Here's the ${recordingAvailable ? 'recording and AI summary' : 'AI summary'} from
          <strong>${esc(meetingTitle)}</strong> (${esc(code)}) — ${esc(whenStr)}${durationMin ? ` · ${durationMin} min` : ''}.
        </p>
        <p style="margin:0 0 22px">
          <a href="${esc(link)}"
             style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 22px;border-radius:10px">
            ${recordingAvailable ? '▶ Watch the recording' : 'Read the meeting summary'}
          </a>
        </p>
        <div style="border:1px solid #d7e5df;border-radius:12px;padding:16px 18px;background:#f8fbfa">
          <p style="margin:0 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#059669"><strong>AI meeting summary</strong></p>
          ${summaryHtml(summary)}
        </div>
        <p style="margin:18px 0 0;color:#9aa6a1;font-size:11px;line-height:1.5">
          This link is personal to you and expires in 7 days. If it has expired, ask the
          meeting host to resend the recording. Please don't forward it outside the intended audience.
        </p>
      </div>
    </div>
  </div>`;
  const result = await getTransporter().sendMail({
    from: mailSettings().from,
    to,
    subject: `${recordingAvailable ? 'Recording & AI summary' : 'AI summary'} — ${meetingTitle} (${code})`,
    text: [`Hi ${recipientName || 'there'},`, meetingTitle, whenStr,
      link, summary?.overview, ...(summary?.keyPoints ?? []), ...(summary?.decisions ?? []),
      ...(summary?.actionItems ?? []), 'This personal link expires in 7 days.'].filter(Boolean).join('\n\n'),
    html,
  });
  if (!result.accepted?.length || result.rejected?.length) {
    throw new Error('The mail server did not accept this recipient.');
  }
}
