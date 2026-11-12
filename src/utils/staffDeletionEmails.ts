import { SUPPORT_EMAIL } from "./userMessages";

/*
 * Emails about a staff member's account deletion request (2026-11-12). The
 * dealership's name and the admin's reason are typed by people, so they're
 * escaped and kept on one line in the subject.
 */

type Email = { subject: string; text: string; html: string };

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const oneLine = (value: string) => value.replace(/[\r\n\t]+/g, " ").trim();

function wrap(heading: string, paragraphs: string[]): string {
  return `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:20px;color:#222;line-height:1.5">
  <h2 style="margin:0 0 12px 0">${escapeHtml(heading)}</h2>
  ${paragraphs.map((paragraph) => `<p style="margin:0 0 12px 0">${paragraph}</p>`).join("\n  ")}
  <p style="margin:16px 0 0 0;color:#666;font-size:13px">Questions? Email Suprah AI support at <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
</div>`;
}

/** Sent to the staff member when an admin declines the request, with the admin's reason. */
export function staffDeletionRejectedEmail(input: { organizationName?: string | null; reason: string }): Email {
  const dealership = oneLine(String(input.organizationName ?? "")) || "your dealership";
  const reason = String(input.reason).trim();
  return {
    subject: `Your account deletion request at ${dealership} was declined`,
    text: [
      `An admin at ${dealership} declined your request to delete your Suprah AI account.`,
      "",
      `Their reason: ${reason}`,
      "",
      "Your account is unchanged. You can send a new request from your Profile once this is sorted out.",
      `Questions? Email Suprah AI support at ${SUPPORT_EMAIL}.`,
    ].join("\n"),
    html: wrap("Account deletion request declined", [
      `An admin at <strong>${escapeHtml(dealership)}</strong> declined your request to delete your Suprah AI account.`,
      `<strong>Their reason:</strong> ${escapeHtml(reason).replace(/\r?\n/g, "<br>")}`,
      "Your account is unchanged. You can send a new request from your Profile once this is sorted out.",
    ]),
  };
}

/** Sent to the staff member's email just before the approved account is erased. */
export function staffDeletionApprovedEmail(input: { organizationName?: string | null }): Email {
  const dealership = oneLine(String(input.organizationName ?? "")) || "your dealership";
  return {
    subject: "Your Suprah AI account was deleted",
    text: [
      `An admin at ${dealership} approved your request, and your Suprah AI account has been deleted. You can no longer sign in with it.`,
      "",
      "Suprah AI keeps some transaction records and personal information for compliance, accounting, tax laws and fraud prevention, and your dealership keeps its own business and employee records.",
      `Questions? Email Suprah AI support at ${SUPPORT_EMAIL}.`,
    ].join("\n"),
    html: wrap("Your account was deleted", [
      `An admin at <strong>${escapeHtml(dealership)}</strong> approved your request, and your Suprah AI account has been deleted. You can no longer sign in with it.`,
      "Suprah AI keeps some transaction records and personal information for compliance, accounting, tax laws and fraud prevention, and your dealership keeps its own business and employee records.",
    ]),
  };
}
