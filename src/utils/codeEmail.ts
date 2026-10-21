import { SUPPORT_EMAIL } from "./userMessages";

/**
 * The branded email for a one-time code: sign-up verification, Resend Code and
 * password reset all look the same, so a driver recognises every code email.
 * Same look as the driver approval email (green header, white card, Suprah.AI
 * footer). Styles are inline because many email apps drop <style> blocks.
 */
const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export function codeEmail(options: {
  // The sender's name: the dealership for its customers, otherwise Suprah.AI.
  brandName: string;
  heading: string;
  intro: string;
  code: string;
  minutesLeft: number;
}): { text: string; html: string } {
  const brand = escapeHtml(options.brandName);
  const heading = escapeHtml(options.heading);
  const intro = escapeHtml(options.intro);
  const code = escapeHtml(options.code);
  const expiry = `This code expires in ${options.minutesLeft} minutes.`;
  const ignore = "If you didn't ask for this code, you can ignore this email.";

  const text = [
    `${options.brandName}: ${options.heading}`,
    "",
    options.intro,
    "",
    `Your code: ${options.code}`,
    expiry,
    "",
    ignore,
    `Questions? Email ${SUPPORT_EMAIL}.`,
    "— Suprah.AI",
  ].join("\n");

  const html = `<!DOCTYPE html>
<html>
  <body style="margin:0;padding:0;background-color:#f4f4f4;font-family:Arial,Helvetica,sans-serif;color:#333333;line-height:1.6;">
    <div style="max-width:600px;margin:20px auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 4px rgba(0,0,0,0.1);">
      <div style="background:#10b981;color:#ffffff;padding:28px 20px;text-align:center;">
        <p style="margin:0;font-size:13px;letter-spacing:2px;text-transform:uppercase;opacity:0.9;">${brand}</p>
        <h1 style="margin:6px 0 0 0;font-size:24px;">${heading}</h1>
      </div>
      <div style="padding:30px;">
        <p style="margin:0 0 20px 0;font-size:16px;">${intro}</p>
        <div style="background:#ecfdf5;border-left:4px solid #10b981;border-radius:4px;padding:20px;text-align:center;">
          <p style="margin:0;color:#065f46;font-size:13px;font-weight:bold;text-transform:uppercase;letter-spacing:1px;">Your code</p>
          <p style="margin:8px 0 0 0;color:#065f46;font-size:32px;font-weight:bold;letter-spacing:8px;font-family:'Courier New',Courier,monospace;">${code}</p>
        </div>
        <p style="margin:20px 0 0 0;color:#047857;font-size:14px;">${expiry}</p>
        <p style="margin:12px 0 0 0;color:#6b7280;font-size:13px;">${ignore}</p>
      </div>
      <div style="text-align:center;color:#6b7280;font-size:12px;padding:20px;background:#f9fafb;border-top:1px solid #e5e7eb;">
        <p style="margin:0;"><strong>Suprah.AI</strong></p>
        <p style="margin:4px 0 0 0;">Questions? Email <a href="mailto:${SUPPORT_EMAIL}" style="color:#047857;">${SUPPORT_EMAIL}</a>.</p>
      </div>
    </div>
  </body>
</html>`;

  return { text, html };
}
