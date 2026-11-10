/*
 * The emails sent when someone signs up with a driver or customer invite link
 * (2026-11-11). The driver email says what to do next (sign in and finish the
 * application), and the customer email never repeats the password they chose.
 */

export const EMAIL_ALREADY_HAS_ACCOUNT =
  "This email already has a Suprah AI account. Sign in instead, or use a different email for this invite link.";

type Email = { subject: string; text: string; html: string };

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);

export function driverApplicationEmail(input: { name: string; email: string; signInUrl: string; supportEmail: string }): Email {
  const name = input.name.trim();
  return {
    subject: "Driver account created: finish your application",
    text:
      `Hello ${name},\n\nYour Suprah AI driver account is ready. Next, sign in and finish your application: ` +
      `upload your documents and sign the driver agreement. The Suprah AI team reviews it and emails you once you're approved.\n\n` +
      `Sign in: ${input.signInUrl}\nEmail: ${input.email}\n\nIf you have questions, contact Suprah AI support at ${input.supportEmail}.`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#111">Finish your driver application</h2>
        <p>Hello <strong>${escapeHtml(name)}</strong>,</p>
        <p>Your Suprah AI driver account is ready. Next, sign in and finish your application: upload your documents and sign the driver agreement. The Suprah AI team reviews it and emails you once you're approved.</p>
        <a href="${input.signInUrl}" style="display:inline-block;margin-top:8px;padding:10px 20px;background:#10b981;color:#fff;text-decoration:none;border-radius:6px">Sign in and continue</a>
        <p style="color:#555;font-size:13px">If you have questions, contact Suprah AI support at ${input.supportEmail}.</p>
      </div>
    `,
  };
}

export function customerWelcomeEmail(input: { name: string; email: string; orgName: string; signInUrl: string }): Email {
  const name = input.name.trim();
  const org = input.orgName.trim();
  return {
    subject: `Welcome to ${org}: your account is ready`,
    text:
      `Hello ${name},\n\nYour customer account with ${org} is ready. Sign in with ${input.email} and the password you chose.\n\n` +
      `Sign in: ${input.signInUrl}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#111">Welcome to ${escapeHtml(org)}!</h2>
        <p>Hello <strong>${escapeHtml(name)}</strong>,</p>
        <p>Your customer account is ready. Sign in with <strong>${escapeHtml(input.email)}</strong> and the password you chose.</p>
        <a href="${input.signInUrl}" style="display:inline-block;margin-top:8px;padding:10px 20px;background:#10b981;color:#fff;text-decoration:none;border-radius:6px">Sign in</a>
      </div>
    `,
  };
}
