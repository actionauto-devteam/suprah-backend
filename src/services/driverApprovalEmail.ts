import emailService from "./email.service";
import logger from "../utils/logger";

/*
 * The email a driver gets when the final Driver Verification approval is what
 * lets them sign in (decided 2026-11-02). Before, that approval only left an
 * in-app notice, which a driver who can't sign in yet never sees. The older
 * account approval already sends its own email, so drivers approved there
 * aren't emailed twice.
 */

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);

/** The approval email's subject, plain text and HTML. */
export function driverApprovedEmail(driverName: unknown, signInUrl: string): { subject: string; text: string; html: string } {
  const name = String(driverName ?? "").trim() || "there";
  const subject = "You're approved to drive with Suprah AI";
  const text = [
    `Hi ${name},`,
    "",
    "Your driver verification is approved. You can now sign in to the Suprah AI Driver Portal and accept loads.",
    "",
    `Sign in: ${signInUrl}`,
    "",
    "Suprah AI Driver Portal",
  ].join("\n");
  const html = `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;color:#1f2937;">
  <div style="max-width:560px;margin:24px auto;background:#ffffff;border-radius:12px;overflow:hidden;">
    <div style="background:#10b981;color:#ffffff;padding:28px 24px;text-align:center;">
      <h1 style="margin:0;font-size:22px;">You're approved</h1>
      <p style="margin:8px 0 0;opacity:0.9;">Suprah AI Driver Portal</p>
    </div>
    <div style="padding:28px 24px;font-size:15px;line-height:1.6;">
      <p>Hi <strong>${escapeHtml(name)}</strong>,</p>
      <p>Your driver verification is approved. You can now sign in to the Suprah AI Driver Portal and accept loads.</p>
      <p style="text-align:center;margin:28px 0;">
        <a href="${escapeHtml(signInUrl)}" style="display:inline-block;background:#10b981;color:#ffffff;padding:12px 32px;border-radius:6px;text-decoration:none;font-weight:bold;">Sign in</a>
      </p>
    </div>
    <div style="text-align:center;color:#6b7280;font-size:12px;padding:16px 24px;background:#f9fafb;border-top:1px solid #e5e7eb;">
      Suprah AI Driver Portal · This is an automated message.
    </div>
  </div>
</body>
</html>`;
  return { subject, text, html };
}

/** Sends the approval email. Never throws: approval stands even if email fails. */
export async function sendDriverApprovedEmail(driver: { _id?: unknown; email?: unknown; name?: unknown }): Promise<void> {
  const to = String(driver.email ?? "").trim();
  if (!to) return;
  const signInUrl = `${(process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/+$/, "")}/sign-in`;
  try {
    await emailService.sendEmail({ to, ...driverApprovedEmail(driver.name, signInUrl) });
  } catch (err) {
    logger.error({ err, driverId: String(driver._id ?? "") }, "Could not send the driver approval email");
  }
}
