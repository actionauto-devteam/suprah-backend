/**
 * Builds the structured deal: amount financed, LTV / DTI / PTI, lender
 * matches, readiness flags. Pure — takes plain objects, returns plain
 * objects — so it is unit-testable and safe to re-run.
 */
import {
  computeStructure,
  monthlyPayment,
  ltv as calcLtv,
  dti as calcDti,
  pti as calcPti,
  rateForScore,
  round1,
  round2,
  totalMonthlyIncome,
} from './calc';
import { REQUIRED_DOCUMENTS, RULES_VERSION } from './constants';

export interface LenderInput {
  _id?: unknown;
  name: string;
  type?: string;
  active?: boolean;
  minScore?: number;
  maxLtv?: number;
  maxDti?: number;
  maxPti?: number;
  maxTerm?: number;
  minAmount?: number;
  maxAmount?: number;
  maxMileage?: number;
  maxVehicleAge?: number;
  rateTiers?: { minScore: number; rate: number }[];
}

export interface DealInput {
  vehicle?: any;
  tradeIn?: any;
  fourSquare?: any;
  creditApp?: any;
  coBuyer?: any;
  documents?: { kind: string }[];
}

export interface Flag {
  level: 'block' | 'warn' | 'info';
  code: string;
  message: string;
}

export interface LenderMatch {
  lenderId?: unknown;
  name: string;
  type?: string;
  fit: 'strong' | 'good' | 'stretch' | 'fail';
  score: number;
  rate?: number;
  rateMax?: number;
  term?: number;
  payment?: number;
  dti?: number;
  pti?: number;
  reasons: string[];
}

export interface AnalysisResult {
  computedAt: Date;
  rulesVersion: string;
  taxAmount: number;
  netTrade: number;
  amountFinanced: number;
  bookValueUsed?: number;
  ltv?: number;
  dti?: number;
  pti?: number;
  estRate?: number;
  estTerm?: number;
  estPayment?: number;
  readiness: number;
  flags: Flag[];
  lenderMatches: LenderMatch[];
}

export interface AnalysisOptions {
  defaultTaxRate?: number;
  defaultDocFee?: number;
  maxRateMarkup?: number;
  now?: Date;
}

const has = (v: unknown) => v !== undefined && v !== null && v !== '' && !(typeof v === 'number' && Number.isNaN(v));

export function analyzeDeal(deal: DealInput, lenders: LenderInput[], opts: AnalysisOptions = {}): AnalysisResult {
  const v = deal.vehicle || {};
  const t = deal.tradeIn || {};
  const fs = deal.fourSquare || {};
  const ca = deal.creditApp || {};
  const co = deal.coBuyer || {};
  const now = opts.now || new Date();
  const markup = opts.maxRateMarkup ?? 2;

  const salePrice = has(fs.salePrice) ? fs.salePrice : v.price;
  const structure = computeStructure({
    salePrice,
    docFee: has(fs.docFee) ? fs.docFee : opts.defaultDocFee,
    otherFees: fs.otherFees,
    taxRate: has(fs.taxRate) ? fs.taxRate : opts.defaultTaxRate,
    downPayment: fs.downPayment,
    backendProducts: fs.backendProducts,
    tradeAllowance: t.present ? t.allowance : 0,
    tradePayoff: t.present ? t.payoff : 0,
  });

  const bookValue = has(v.bookValue) && v.bookValue > 0 ? v.bookValue : undefined;
  const ltvVal = calcLtv(structure.amountFinanced, bookValue);
  const desiredTerm = has(fs.desiredTerm) ? Number(fs.desiredTerm) : 72;
  const score: number | undefined = has(ca.creditScore) ? Number(ca.creditScore) : undefined;
  const income = {
    grossMonthlyIncome: ca.grossMonthlyIncome,
    otherMonthlyIncome: ca.otherMonthlyIncome,
    coBuyerIncome: co.present ? co.grossMonthlyIncome : 0,
    monthlyDebt: ca.monthlyDebt,
    housingPayment: ca.housingPayment,
  };
  const vehicleAge = has(v.year) ? now.getFullYear() - Number(v.year) : undefined;

  /* ── lender matching ── */
  const matches: LenderMatch[] = lenders
    .filter((l) => l.active !== false)
    .map((l) => {
      const reasons: string[] = [];
      const fails: string[] = [];
      const term = Math.min(desiredTerm, l.maxTerm || desiredTerm);
      const rate = rateForScore(score, l.rateTiers && l.rateTiers.length ? l.rateTiers : undefined);
      const payment = rate != null ? monthlyPayment(structure.amountFinanced, rate, term) : undefined;
      const lDti = payment != null ? calcDti(income, payment) : undefined;
      const lPti = payment != null ? calcPti(income, payment) : undefined;
      const headroom: number[] = [];

      if (has(l.minScore)) {
        if (score == null) reasons.push('Credit score unknown');
        else if (score < (l.minScore as number)) fails.push(`Score ${score} below ${l.minScore} minimum`);
        else headroom.push(Math.min(1, (score - (l.minScore as number)) / 100));
      }
      if (has(l.maxLtv)) {
        if (ltvVal == null) reasons.push('LTV unknown (no book value)');
        else if (ltvVal > (l.maxLtv as number)) fails.push(`LTV ${ltvVal}% over ${l.maxLtv}% max`);
        else headroom.push(((l.maxLtv as number) - ltvVal) / (l.maxLtv as number));
      }
      if (has(l.maxDti)) {
        if (lDti == null) reasons.push('DTI unknown (no income)');
        else if (lDti > (l.maxDti as number)) fails.push(`DTI ${lDti}% over ${l.maxDti}% max`);
        else headroom.push(((l.maxDti as number) - lDti) / (l.maxDti as number));
      }
      if (has(l.maxPti) && lPti != null) {
        if (lPti > (l.maxPti as number)) fails.push(`PTI ${lPti}% over ${l.maxPti}% max`);
        else headroom.push(((l.maxPti as number) - lPti) / (l.maxPti as number));
      }
      if (has(l.maxAmount) && structure.amountFinanced > (l.maxAmount as number))
        fails.push(`Amount $${Math.round(structure.amountFinanced).toLocaleString()} over $${(l.maxAmount as number).toLocaleString()} max`);
      if (has(l.minAmount) && structure.amountFinanced < (l.minAmount as number))
        fails.push(`Amount under $${(l.minAmount as number).toLocaleString()} minimum`);
      if (has(l.maxMileage) && has(v.mileage) && v.mileage > (l.maxMileage as number))
        fails.push(`Mileage ${Number(v.mileage).toLocaleString()} over ${(l.maxMileage as number).toLocaleString()} max`);
      if (has(l.maxVehicleAge) && vehicleAge != null && vehicleAge > (l.maxVehicleAge as number))
        fails.push(`Vehicle ${vehicleAge} yrs old, max ${l.maxVehicleAge}`);
      if (l.maxTerm && desiredTerm > l.maxTerm) reasons.push(`Term capped at ${l.maxTerm} mo`);

      const score100 = headroom.length
        ? Math.round((headroom.reduce((a, b) => a + b, 0) / headroom.length) * 100)
        : 40;
      const fit: LenderMatch['fit'] = fails.length
        ? 'fail'
        : score100 >= 30
          ? 'strong'
          : score100 >= 12
            ? 'good'
            : 'stretch';

      return {
        lenderId: l._id,
        name: l.name,
        type: l.type,
        fit,
        score: fails.length ? 0 : score100,
        rate,
        rateMax: rate != null ? round2(rate + markup) : undefined,
        term,
        payment,
        dti: lDti,
        pti: lPti,
        reasons: [...fails, ...reasons],
      };
    })
    .sort((a, b) => {
      if ((a.fit === 'fail') !== (b.fit === 'fail')) return a.fit === 'fail' ? 1 : -1;
      if (b.score !== a.score) return b.score - a.score;
      return (a.rate ?? 99) - (b.rate ?? 99);
    });

  const best = matches.find((m) => m.fit !== 'fail');
  const estRate = best?.rate ?? rateForScore(score);
  const estTerm = best?.term ?? desiredTerm;
  const estPayment = estRate != null ? monthlyPayment(structure.amountFinanced, estRate, estTerm) : undefined;
  const dtiVal = estPayment != null ? calcDti(income, estPayment) : undefined;
  const ptiVal = estPayment != null ? calcPti(income, estPayment) : undefined;

  /* ── flags ── */
  const flags: Flag[] = [];
  const docKinds = new Set((deal.documents || []).map((d) => d.kind));

  if (!ca.consent?.granted) flags.push({ level: 'block', code: 'no_consent', message: 'Credit authorization not captured' });
  if (!has(salePrice) || !(salePrice > 0)) flags.push({ level: 'block', code: 'no_price', message: 'Sale price missing' });
  if (totalMonthlyIncome(income) <= 0) flags.push({ level: 'block', code: 'no_income', message: 'Gross monthly income missing' });
  if (!bookValue) flags.push({ level: 'warn', code: 'no_book', message: 'Book value missing — LTV cannot be calculated' });
  if (score == null) flags.push({ level: 'warn', code: 'no_score', message: 'Credit score missing' });
  else if (ca.creditScoreSource !== 'bureau') flags.push({ level: 'info', code: 'score_unverified', message: 'Credit score is self-reported, not from a bureau pull' });
  if (ltvVal != null && ltvVal > 130) flags.push({ level: 'warn', code: 'ltv_high', message: `LTV ${ltvVal}% is high for most lenders` });
  if (dtiVal != null && dtiVal > 50) flags.push({ level: 'warn', code: 'dti_high', message: `DTI ${dtiVal}% is above 50%` });
  if (ptiVal != null && ptiVal > 20) flags.push({ level: 'warn', code: 'pti_high', message: `PTI ${ptiVal}% is above 20%` });
  if (structure.netTrade < 0) flags.push({ level: 'info', code: 'negative_equity', message: `Negative equity of $${Math.abs(Math.round(structure.netTrade)).toLocaleString()} rolled in` });
  if (has(ca.employmentMonths) && ca.employmentMonths < 6) flags.push({ level: 'info', code: 'short_job', message: 'Less than 6 months at current job' });
  if (has(ca.residenceMonths) && ca.residenceMonths < 6) flags.push({ level: 'info', code: 'short_residence', message: 'Less than 6 months at current address' });
  if (!docKinds.has('proof_income')) flags.push({ level: 'info', code: 'income_unverified', message: 'No proof of income uploaded' });
  for (const kind of REQUIRED_DOCUMENTS) {
    if (!docKinds.has(kind)) flags.push({ level: 'warn', code: `missing_${kind}`, message: `Missing document: ${kind.replace(/_/g, ' ')}` });
  }
  if (lenders.length && !best) flags.push({ level: 'warn', code: 'no_lender', message: 'No lender in the matrix fits this deal as structured' });
  if (has(fs.desiredPayment) && estPayment != null && estPayment > Number(fs.desiredPayment) * 1.1)
    flags.push({ level: 'info', code: 'over_target', message: `Estimated payment $${Math.round(estPayment)} is over the customer's $${fs.desiredPayment} target` });

  const penalty = flags.reduce((s, f) => s + (f.level === 'block' ? 35 : f.level === 'warn' ? 10 : 3), 0);
  const readiness = Math.max(0, Math.min(100, 100 - penalty));

  return {
    computedAt: now,
    rulesVersion: RULES_VERSION,
    taxAmount: structure.taxAmount,
    netTrade: structure.netTrade,
    amountFinanced: structure.amountFinanced,
    bookValueUsed: bookValue,
    ltv: ltvVal,
    dti: dtiVal,
    pti: ptiVal,
    estRate: estRate != null ? round2(estRate) : undefined,
    estTerm,
    estPayment,
    readiness,
    flags,
    lenderMatches: matches,
  };
}

export function hasBlockingFlags(flags?: Flag[]): boolean {
  return !!flags?.some((f) => f.level === 'block');
}

export { round1 };
