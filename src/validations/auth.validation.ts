import { z } from "zod";

// Password rules for every new account (sign-up and invite links) and every
// password reset. The website shows the same list (lib/password-rules.ts).
// Existing passwords still sign in; sign-in only checks a password is given.
const STRONG_PASSWORD_RULES: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /^.{8,}$/s, message: "Password must be at least 8 characters" },
  { pattern: /[A-Z]/, message: "Password must include at least one uppercase letter" },
  { pattern: /[0-9]/, message: "Password must include at least one number" },
  { pattern: /[^A-Za-z0-9]/, message: "Password must include at least one special character" },
];

/** The strong-password rules this password doesn't meet (empty when it meets them all). */
export function strongPasswordProblems(password: string): string[] {
  return STRONG_PASSWORD_RULES.filter((rule) => !rule.pattern.test(password)).map((rule) => rule.message);
}

const strongPasswordSchema = z.string().superRefine((password, ctx) => {
  for (const message of strongPasswordProblems(password)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  }
});

export const registerSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Invalid email address"),
  password: strongPasswordSchema,
  role: z.enum(["customer", "driver", "dealership"]).optional(),
  inviteToken: z.string().optional(),
  organizationId: z
    .string()
    .regex(/^[a-f\d]{24}$/i, "Invalid organization id")
    .optional(),
  dealershipSlug: z.string().min(2).optional(),
});

export const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export const registerDealershipSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Invalid email address"),
  password: strongPasswordSchema,
  dealershipName: z
    .string()
    .min(2, "Dealership name must be at least 2 characters"),
  dealershipSlug: z
    .string()
    .min(2, "Slug must be at least 2 characters")
    .regex(
      /^[a-z0-9-]+$/,
      "Slug can only contain lowercase letters, numbers, and hyphens",
    ),
});

export const verifyEmailSchema = z.object({
  email: z.string().email("Invalid email address"),
  otp: z.string().length(6, "Verification code must be 6 digits"),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email("Invalid email address"),
});

export const resetPasswordSchema = z.object({
  email: z.string().email("Invalid email address"),
  otp: z.string().length(6, "Reset code must be 6 digits"),
  newPassword: strongPasswordSchema,
});

export const completeOnboardingSchema = z.object({
  role: z.enum(["customer", "driver", "dealership"]),
});