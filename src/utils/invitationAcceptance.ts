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
        "This email already has a driver account, and driver accounts can't also be dealership staff. Ask the person who invited you to send the invitation to a different email.",
    }
  }
  return null
}
