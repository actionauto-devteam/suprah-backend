/*
 * The finance application's other answers (2026-11-10): application type,
 * marital status, driver's license number, housing, work phone, pay
 * frequency, a reference and a trade-in. They're cleaned here before they're
 * stored: text is trimmed and kept short, choices must be one of the form's
 * options, and numbers must be zero or more. Anything else is left out rather
 * than refusing the whole application.
 */

const APPLICATION_TYPES = ["individual", "joint"] as const;
const MARITAL_STATUSES = ["single", "married", "divorced", "widowed"] as const;
const HOUSING_STATUSES = ["own", "rent", "other"] as const;
const PAY_FREQUENCIES = ["annually", "monthly", "bi-weekly", "weekly"] as const;

export type FinanceApplicationExtras = {
  applicationType?: (typeof APPLICATION_TYPES)[number];
  maritalStatus?: (typeof MARITAL_STATUSES)[number];
  driversLicenseNumber?: string;
  workPhone?: string;
  payFrequency?: (typeof PAY_FREQUENCIES)[number];
  residence?: {
    housingStatus?: (typeof HOUSING_STATUSES)[number];
    monthlyPayment?: number;
    yearsAtAddress?: number;
    monthsAtAddress?: number;
  };
  reference?: { name?: string; relationship?: string; phone?: string };
  tradeIn?: { hasTradeIn: boolean; year?: string; make?: string; model?: string; mileage?: string };
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const text = (value: unknown, max = 100): string | undefined => {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const cleaned = String(value).trim().slice(0, max);
  return cleaned || undefined;
};

const choice = <T extends string>(value: unknown, options: readonly T[]): T | undefined =>
  typeof value === "string" && (options as readonly string[]).includes(value) ? (value as T) : undefined;

const amount = (value: unknown, max = 10_000_000): number | undefined => {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(number) && number >= 0 && number <= max ? number : undefined;
};

/** Drops empty values so nothing blank is stored. */
const compact = <T extends Record<string, unknown>>(value: T): T | undefined => {
  const kept = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
  return Object.keys(kept).length ? kept : undefined;
};

/** The cleaned extra answers from a finance application request body. */
export function financeApplicationExtras(body: unknown): FinanceApplicationExtras {
  const source = record(body);
  const personal = record(source.personalInfo);
  const employment = record(source.employmentInfo);
  const residence = record(source.residence);
  const reference = record(source.reference);
  const tradeIn = record(source.tradeIn);
  const hasTradeIn = tradeIn.hasTradeIn === true;

  return {
    applicationType: choice(personal.applicationType, APPLICATION_TYPES),
    maritalStatus: choice(personal.maritalStatus, MARITAL_STATUSES),
    driversLicenseNumber: text(personal.driversLicenseNumber, 40),
    workPhone: text(employment.workPhone, 30),
    payFrequency: choice(employment.payFrequency, PAY_FREQUENCIES),
    residence: compact({
      housingStatus: choice(residence.housingStatus, HOUSING_STATUSES),
      monthlyPayment: amount(residence.monthlyPayment),
      yearsAtAddress: amount(residence.yearsAtAddress, 100),
      monthsAtAddress: amount(residence.monthsAtAddress, 11),
    }),
    reference: compact({
      name: text(reference.name),
      relationship: text(reference.relationship, 60),
      phone: text(reference.phone, 30),
    }),
    tradeIn: tradeIn.hasTradeIn === undefined
      ? undefined
      : {
          hasTradeIn,
          ...(hasTradeIn
            ? compact({
                year: text(tradeIn.year, 4),
                make: text(tradeIn.make, 40),
                model: text(tradeIn.model, 60),
                mileage: text(tradeIn.mileage, 12),
              })
            : {}),
        },
  };
}

const STAFF_ROLES = ["admin", "dealer", "employee", "super_admin"];

/**
 * Whose application this is (2026-11-10). A customer's own application is
 * theirs. When staff fill it in for a customer, it's recorded under that
 * customer's account (found by the email on the application) and notes who
 * filled it in; with no customer account for that email it's kept without one.
 */
export async function financeApplicationOwner(
  user: { _id: { toString(): string }; role?: string },
  applicantEmail: unknown,
  findCustomerIdByEmail: (email: string) => Promise<string | null>,
): Promise<{ customerId?: string; submittedBy?: string }> {
  if (!STAFF_ROLES.includes(String(user.role))) return { customerId: user._id.toString() };
  const email = typeof applicantEmail === "string" ? applicantEmail.trim().toLowerCase() : "";
  const customerId = email ? await findCustomerIdByEmail(email) : null;
  return { customerId: customerId ?? undefined, submittedBy: user._id.toString() };
}
