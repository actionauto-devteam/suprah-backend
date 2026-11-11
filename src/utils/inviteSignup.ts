/*
 * Signing up with a driver or customer invite link (2026-11-11). The new
 * account confirms its email with a 6-digit code first, the same as every
 * other sign-up, so nobody can create an account with an email they don't
 * own. The code email says what the code is for and what comes next.
 */

export const EMAIL_ALREADY_HAS_ACCOUNT =
  "This email already has a Suprah AI account. Sign in instead, or use a different email for this invite link.";

export const INVITE_SIGNUP_MESSAGES = {
  name: "Enter your name (2 to 100 characters).",
  email: "Enter a valid email address, like name@example.com.",
} as const

const EMAIL_SHAPE = /^[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\]+\.[^\s@<>()[\]",;:\\]+$/

/** What's wrong with the name or email typed into the form, or null when both are fine. */
export function inviteSignupDetailsProblem(input: { name: string; email: string }): string | null {
  const name = input.name.trim()
  if (name.length < 2 || name.length > 100) return INVITE_SIGNUP_MESSAGES.name
  const email = input.email.trim()
  if (email.length > 254 || !EMAIL_SHAPE.test(email)) return INVITE_SIGNUP_MESSAGES.email
  return null
}

/** The first lines of the code email. */
export function inviteSignupCodeIntro(accountType: "driver" | "customer", orgName?: string | null): string {
  if (accountType === "driver") {
    return "Enter this code to confirm your email. Next, you'll finish your driver application (documents and agreement) for the Suprah AI team to review."
  }
  const dealership = String(orgName ?? "").trim() || "the dealership"
  return `Enter this code to confirm your email and open your customer account with ${dealership}.`
}
