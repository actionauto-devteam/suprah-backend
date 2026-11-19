/**
 * Deal Desk rules engine — pure, deterministic math.
 *
 * The AI never calculates. Every number shown to a Finance Manager comes
 * from here, so it is exact, repeatable and auditable (RULES_VERSION is
 * stamped on every analysis).
 */

export interface StructureInput {
  salePrice?: number;
  docFee?: number;
  otherFees?: number;
  taxRate?: number; // percent, e.g. 7.25
  downPayment?: number;
  backendProducts?: number;
  tradeAllowance?: number;
  tradePayoff?: number;
  /** Most states tax the price after the trade-in credit. */
  taxTradeCredit?: boolean;
}

export interface StructureResult {
  taxableAmount: number;
  taxAmount: number;
  netTrade: number; // allowance − payoff (negative = negative equity)
  amountFinanced: number;
}

const n = (v: unknown): number => {
  const x = typeof v === 'string' ? Number(v) : (v as number);
  return Number.isFinite(x) ? (x as number) : 0;
};

export const round2 = (v: number) => Math.round(v * 100) / 100;
export const round1 = (v: number) => Math.round(v * 10) / 10;

export function computeStructure(input: StructureInput): StructureResult {
  const salePrice = n(input.salePrice);
  const docFee = n(input.docFee);
  const otherFees = n(input.otherFees);
  const taxRate = n(input.taxRate);
  const down = n(input.downPayment);
  const backend = n(input.backendProducts);
  const allowance = n(input.tradeAllowance);
  const payoff = n(input.tradePayoff);
  const tradeCredit = input.taxTradeCredit !== false;

  const taxableAmount = Math.max(0, salePrice + docFee - (tradeCredit ? allowance : 0));
  const taxAmount = round2((taxableAmount * taxRate) / 100);
  const netTrade = round2(allowance - payoff);
  const amountFinanced = round2(
    Math.max(0, salePrice + docFee + otherFees + taxAmount + backend - down - netTrade),
  );

  return { taxableAmount: round2(taxableAmount), taxAmount, netTrade, amountFinanced };
}

/** Standard amortized monthly payment. aprPercent e.g. 6.9, termMonths e.g. 72. */
export function monthlyPayment(principal: number, aprPercent: number, termMonths: number): number {
  const p = n(principal);
  const term = Math.max(1, Math.round(n(termMonths)));
  const r = n(aprPercent) / 1200;
  if (p <= 0) return 0;
  if (r === 0) return round2(p / term);
  return round2((p * r) / (1 - Math.pow(1 + r, -term)));
}

/** Loan-to-value, percent of book value. Undefined when book value is unknown. */
export function ltv(amountFinanced: number, bookValue?: number): number | undefined {
  const bv = n(bookValue);
  if (bv <= 0) return undefined;
  return round1((n(amountFinanced) / bv) * 100);
}

export interface IncomeInput {
  grossMonthlyIncome?: number;
  otherMonthlyIncome?: number;
  coBuyerIncome?: number;
  monthlyDebt?: number; // existing obligations from the credit report
  housingPayment?: number;
}

export function totalMonthlyIncome(i: IncomeInput): number {
  return round2(n(i.grossMonthlyIncome) + n(i.otherMonthlyIncome) + n(i.coBuyerIncome));
}

/** Debt-to-income incl. housing and the new payment, percent. */
export function dti(i: IncomeInput, newPayment: number): number | undefined {
  const income = totalMonthlyIncome(i);
  if (income <= 0) return undefined;
  return round1(((n(i.monthlyDebt) + n(i.housingPayment) + n(newPayment)) / income) * 100);
}

/** Payment-to-income, percent. */
export function pti(i: IncomeInput, newPayment: number): number | undefined {
  const income = totalMonthlyIncome(i);
  if (income <= 0) return undefined;
  return round1((n(newPayment) / income) * 100);
}

/**
 * Generic score-based buy-rate estimate used when a lender has no tiers
 * configured, and for the public widget estimate. Illustrative only — the
 * lender matrix in Settings is the source of truth.
 */
export const DEFAULT_RATE_TIERS = [
  { minScore: 780, rate: 5.49 },
  { minScore: 720, rate: 6.49 },
  { minScore: 680, rate: 7.99 },
  { minScore: 640, rate: 10.49 },
  { minScore: 600, rate: 13.99 },
  { minScore: 550, rate: 17.99 },
  { minScore: 0, rate: 21.99 },
];

export function rateForScore(score: number | undefined, tiers = DEFAULT_RATE_TIERS): number | undefined {
  if (!tiers.length) return undefined;
  const sorted = [...tiers].sort((a, b) => b.minScore - a.minScore);
  if (score == null || !Number.isFinite(score)) return sorted[Math.min(3, sorted.length - 1)].rate;
  const tier = sorted.find((t) => score >= t.minScore);
  return tier ? tier.rate : undefined;
}

/** Self-reported credit band → representative score for estimates. */
export const CREDIT_BANDS: Record<string, number> = {
  excellent: 790,
  good: 730,
  fair: 680,
  rebuilding: 610,
  unsure: 660,
};
