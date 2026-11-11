/*
 * Who may accept a staff (team) invitation (2026-11-11): only the account it
 * was sent to, and never a driver account. Drivers are the platform's shared
 * pool and can't also be dealership staff. Google sign-in already applies the
 * same email rule (config/passport.ts). A customer account with the invited
 * email still becomes staff, as before.
 */

export const INVITATION_MESSAGES = {
  notFound: "We couldn't find this invitation. Check the link in your email, or ask the person who invited you for a new one.",
  expired: "This invitation has expired. Ask the person who invited you to send a new one.",
  used: "This invitation has already been used. Sign in to continue, or ask the person who invited you for a new one.",
  cancelled: "This invitation was cancelled. Ask the person who invited you for a new one.",
} as const

export type AcceptanceProblem = { status: number; message: string }

const normalized = (email: unknown) => String(email ?? "").trim().toLowerCase()

/** Why this signed-in account can't accept the invitation, or null when it can. */
export function invitationAcceptanceProblem(input: {
  inviteEmail: unknown
  userEmail: unknown
  userRole: unknown
}): AcceptanceProblem | null {
  const invited = normalized(input.inviteEmail)
  if (!invited || invited !== normalized(input.userEmail)) {
    return {
      status: 403,
      message: `This invitation was sent to ${String(input.inviteEmail ?? "").trim()}. Sign out, then sign in or create an account with that email to accept it.`,
    }
  }
  if (input.userRole === "driver") {
    return {
      status: 409,
      message:
        "This email is registered as a driver account, so it can't be used for a staff account. Ask the person who invited you to send the invitation to a different email.",
    }
  }
  return null
}

const TEAM_ROLES = new Set(["employee", "admin", "super_admin"])

/**
 * Whether this email can be invited as staff (2026-11-11). Before, any account
 * linked to the dealership counted as "already a member", which wrongly
 * stopped the dealership's own customers (they can become staff) and called a
 * driver account a member. A driver can't be staff; someone already on this
 * dealership's team doesn't need an invitation.
 */
export function staffInviteTargetProblem(input: {
  existing: { role?: unknown; organizationId?: unknown } | null | undefined
  organizationId: unknown
}): (AcceptanceProblem & { kind: "driver" | "team" }) | null {
  const account = input.existing
  if (!account) return null
  if (account.role === "driver") {
    return {
      kind: "driver",
      status: 409,
      message: "This email is registered as a driver account, so it can't be used for a staff account. Ask them for a different email for their staff account.",
    }
  }
  if (TEAM_ROLES.has(String(account.role)) && String(account.organizationId ?? "") === String(input.organizationId ?? "")) {
    return { kind: "team", status: 400, message: "This person is already on your team." }
  }
  return null
}

/**
 * What kind of account the invited email already has, so the invitation can
 * say what accepting will do before anyone presses a button (2026-11-11).
 * Only the kind is shared, never names or details, and only with someone
 * holding the invitation link (sent to that email). The admin who sent it only
 * hears about the dealership's own customers (see adminInviteNote).
 */
export type InvitedAccountStatus = "none" | "customer" | "driver" | "team" | "other-dealership-staff"

export function invitedAccountStatus(
  account: { role?: unknown; organizationId?: unknown } | null | undefined,
  organizationId: unknown,
): InvitedAccountStatus {
  if (!account) return "none"
  if (account.role === "driver") return "driver"
  if (account.role === "customer") return "customer"
  if (TEAM_ROLES.has(String(account.role))) {
    return String(account.organizationId ?? "") === String(organizationId ?? "") ? "team" : "other-dealership-staff"
  }
  return "none"
}

/*
 * What an admin may send (2026-11-11): a real email address and the Member or
 * Admin role. Anything else gets a plain message instead of being saved as
 * typed or failing later.
 */
export const INVITE_INPUT_MESSAGES = {
  email: "Enter a valid email address, like name@example.com.",
  role: "Choose Member or Admin for the invitation.",
} as const

const EMAIL_SHAPE = /^[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\]+\.[^\s@<>()[\]",;:\\]+$/

/** The email in lowercase without spaces, or null when it isn't an email address. */
export function inviteEmailOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null
  const email = value.trim().toLowerCase()
  return email.length <= 254 && EMAIL_SHAPE.test(email) ? email : null
}

/** Member when no role is sent, Member or Admin when chosen, otherwise null. */
export function staffInviteRoleOrNull(value: unknown): "member" | "admin" | null {
  if (value === undefined || value === null || value === "") return "member"
  return value === "member" || value === "admin" ? value : null
}

/**
 * What the admin is told after sending (2026-11-11): only that the email is
 * one of the dealership's own customers, whose account becomes staff when they
 * accept. Nothing about accounts at other dealerships, so sending invitations
 * can't be used to find out who has an account somewhere else.
 */
export function adminInviteNote(
  account: { role?: unknown; organizationId?: unknown } | null | undefined,
  organizationId: unknown,
): "customer" | null {
  if (!account || account.role !== "customer") return null
  return String(account.organizationId ?? "") === String(organizationId ?? "") ? "customer" : null
}
