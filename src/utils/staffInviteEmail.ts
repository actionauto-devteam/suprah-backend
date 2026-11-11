/*
 * The staff invitation email, used for single and bulk invitations
 * (2026-11-11). The inviter's name and the dealership's name are typed by
 * people, so they are escaped: a name can't add links, buttons or formatting
 * to an email sent from Suprah AI. Line breaks are removed from the subject so
 * a name can't add email headers either.
 */

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!)

const oneLine = (value: string) => value.replace(/[\r\n\t]+/g, " ").trim()

export function staffInviteEmail(input: {
  inviterName?: string | null
  organizationName?: string | null
  inviteLink: string
}): { subject: string; text: string; html: string } {
  const inviter = oneLine(String(input.inviterName ?? "")) || "Someone"
  const organization = oneLine(String(input.organizationName ?? "")) || "a dealership"
  const link = input.inviteLink

  return {
    subject: `You've been invited to join ${organization} on Suprah.AI`,
    text: [
      `${inviter} has invited you to join the organization ${organization} on Suprah.AI.`,
      `Accept here: ${link}`,
      "",
      "If you did not expect this invitation, you can ignore this email.",
    ].join("\n"),
    html: `
                <div style="font-family: Arial, sans-serif; padding: 20px;">
                    <h2>You've been invited!</h2>
                    <p><strong>${escapeHtml(inviter)}</strong> has invited you to join the organization <strong>${escapeHtml(organization)}</strong>.</p>
                    <p>Click the button below to accept the invitation:</p>
                    <a href="${escapeHtml(link)}" style="display: inline-block; padding: 10px 20px; background-color: #007bff; color: white; text-decoration: none; border-radius: 5px;">Accept Invitation</a>
                    <p style="margin-top: 20px; font-size: 12px; color: #666;">If you did not expect this invitation, you can ignore this email.</p>
                </div>
            `,
  }
}
