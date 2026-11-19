/**
 * Public Website Purchase Widget API — /api/public/deal-desk/:orgKey
 * No auth. The org is found by its slug (the same key webchat uses).
 * Web deals land in the SAME queue as Supra deals (source: "web").
 */
import { Request, Response, NextFunction } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import Organization from '../models/Organization.model';
import DealDeskDeal from '../models/DealDeskDeal.model';
import { nextDealNumber } from '../models/DealDeskSupport.model';
import { getSettings } from '../services/dealDesk/access';
import { CONSENT_TEXT } from '../services/dealDesk/constants';
import { computeStructure, monthlyPayment, rateForScore, CREDIT_BANDS } from '../services/dealDesk/calc';
import { encryptPii, normalizeSsn } from '../services/dealDesk/pii';
import { logEvent, postSystemMessage } from '../services/dealDesk/queue';
import { emitDealChanged, emitToStaff } from '../services/dealDesk/realtime';
import { toDealSummary } from '../services/dealDesk/serialize';

/* small per-IP limiter so the public form can't be flooded */
const hits = new Map<string, { n: number; reset: number }>();
export function widgetLimiter(max: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${req.ip}:${req.baseUrl}${req.route?.path || req.path}`;
    const now = Date.now();
    const row = hits.get(key);
    if (!row || row.reset < now) hits.set(key, { n: 1, reset: now + windowMs });
    else if (++row.n > max) return res.status(429).json(new ApiResponse(429, null, 'Too many requests. Please wait a minute and try again.'));
    if (hits.size > 20000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    next();
  };
}

async function resolveOrg(orgKey: string) {
  const org: any = await Organization.findOne({ slug: String(orgKey || '').toLowerCase() }).select('_id name slug status').lean();
  if (!org || org.status === 'suspended') throw new ApiError(404, 'Dealer not found');
  const settings = await getSettings(String(org._id));
  if (!settings.widget?.enabled) throw new ApiError(404, 'Online buying is not available for this dealer yet.');
  return { org, settings };
}

/** CORS for the widget: allow the dealer's configured site origins (no cookies). */
export const widgetCors = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin) {
    let allowed = false;
    try {
      const org: any = await Organization.findOne({ slug: String(req.params.orgKey || '').toLowerCase() }).select('_id').lean();
      if (org) {
        const settings = await getSettings(String(org._id));
        const list = settings.widget?.allowedOrigins || [];
        allowed = !list.length || list.some((o) => o.replace(/\/+$/, '') === origin);
      }
    } catch {
      allowed = false;
    }
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

export const getWidgetConfig = asyncHandler(async (req: Request, res: Response) => {
  const { org, settings } = await resolveOrg(String(req.params.orgKey));
  res.json(
    new ApiResponse(200, {
      dealerName: org.name,
      headline: settings.widget?.headline || `Buy your next car online with ${org.name}`,
      accentColor: settings.widget?.accentColor || '#16a34a',
      depositAmount: settings.widget?.depositAmount ?? 500,
      taxRate: settings.defaultTaxRate,
      docFee: settings.defaultDocFee,
      consentText: CONSENT_TEXT,
      terms: [36, 48, 60, 72, 84],
      creditBands: Object.keys(CREDIT_BANDS),
    }),
  );
});

const n0 = z.preprocess((v) => (v === '' || v == null ? undefined : Number(String(v).replace(/[$,\s]/g, ''))), z.number().finite().min(0).max(5_000_000).optional());

const estimateSchema = z.object({
  price: n0,
  downPayment: n0,
  tradeValue: n0,
  tradePayoff: n0,
  creditBand: z.enum(['excellent', 'good', 'fair', 'rebuilding', 'unsure']).default('unsure'),
});

export const estimatePayments = asyncHandler(async (req: Request, res: Response) => {
  const { settings } = await resolveOrg(String(req.params.orgKey));
  const b = estimateSchema.parse(req.body || {});
  if (!b.price) throw new ApiError(400, 'Vehicle price is required.');
  const s = computeStructure({
    salePrice: b.price,
    docFee: settings.defaultDocFee,
    taxRate: settings.defaultTaxRate,
    downPayment: b.downPayment,
    tradeAllowance: b.tradeValue,
    tradePayoff: b.tradePayoff,
  });
  const rate = rateForScore(CREDIT_BANDS[b.creditBand]) ?? 9.99;
  const options = [36, 48, 60, 72, 84].map((term) => ({ term, apr: rate, payment: monthlyPayment(s.amountFinanced, rate, term) }));
  res.json(
    new ApiResponse(200, {
      amountFinanced: s.amountFinanced,
      taxAmount: s.taxAmount,
      docFee: settings.defaultDocFee,
      apr: rate,
      options,
      disclaimer: 'Estimate only. Your actual rate and payment depend on credit approval and lender terms.',
    }),
  );
});

const str = (max = 160) => z.preprocess((v) => (v == null ? undefined : String(v).trim()), z.string().max(max).optional());

const webDealSchema = z.object({
  vehicle: z.object({ vin: str(20), stockNumber: str(40), year: n0, make: str(60), model: str(60), trim: str(80), mileage: n0, price: n0, condition: z.enum(['new', 'used', 'cpo']).optional() }).partial(),
  customer: z.object({
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    email: z.string().trim().email().max(160),
    phone: z.string().trim().min(7).max(40),
    address: z.object({ street: str(160), city: str(80), state: str(40), zip: str(20) }).partial().optional(),
  }),
  financing: z.object({
    downPayment: n0,
    desiredTerm: n0,
    creditBand: z.enum(['excellent', 'good', 'fair', 'rebuilding', 'unsure']).default('unsure'),
    tradeIn: z.object({ present: z.boolean().optional(), year: n0, make: str(60), model: str(60), mileage: n0, value: n0, payoff: n0 }).partial().optional(),
  }),
  creditApp: z.object({
    employer: str(120),
    jobTitle: str(120),
    employmentMonths: n0,
    grossMonthlyIncome: z.preprocess((v) => Number(String(v ?? '').replace(/[$,\s]/g, '')), z.number().positive().max(1_000_000)),
    housingStatus: z.enum(['own', 'rent', 'family', 'other']).optional(),
    housingPayment: n0,
    residenceMonths: n0,
    ssn: str(20),
    dob: str(30),
  }),
  consent: z.literal(true),
  wantsDeposit: z.boolean().optional(),
  website: z.string().max(0).optional(), // honeypot — must stay empty
});

export const submitWebDeal = asyncHandler(async (req: Request, res: Response) => {
  const { org, settings } = await resolveOrg(String(req.params.orgKey));
  const body = webDealSchema.parse(req.body || {});
  const ssn = normalizeSsn(body.creditApp.ssn);
  if (body.creditApp.ssn && !ssn) throw new ApiError(400, 'SSN must be 9 digits.');
  const dob = body.creditApp.dob ? new Date(body.creditApp.dob) : undefined;

  const now = new Date();
  const orgId = new Types.ObjectId(String(org._id));
  const dealNumber = await nextDealNumber(orgId);
  const trade = body.financing.tradeIn;
  const deal = await DealDeskDeal.create({
    organizationId: orgId,
    dealNumber,
    source: 'web',
    stage: 'submitted',
    stageEnteredAt: now,
    stageHistory: [
      { stage: 'draft', enteredAt: now, exitedAt: now, durationMs: 0, actorName: 'Website' },
      { stage: 'submitted', enteredAt: now, actorName: 'Website' },
    ],
    createdBy: { name: `${body.customer.firstName} ${body.customer.lastName} (website)` },
    customer: {
      firstName: body.customer.firstName,
      lastName: body.customer.lastName,
      email: body.customer.email.toLowerCase(),
      phone: body.customer.phone,
      dob: dob && !Number.isNaN(dob.getTime()) ? dob : undefined,
      address: body.customer.address,
    },
    vehicle: { ...body.vehicle, vin: body.vehicle.vin?.toUpperCase() },
    tradeIn: trade?.present ? { present: true, year: trade.year, make: trade.make, model: trade.model, mileage: trade.mileage, allowance: trade.value, payoff: trade.payoff } : { present: false },
    fourSquare: {
      salePrice: body.vehicle.price,
      downPayment: body.financing.downPayment,
      desiredTerm: body.financing.desiredTerm,
      taxRate: settings.defaultTaxRate,
      docFee: settings.defaultDocFee,
    },
    creditApp: {
      employer: body.creditApp.employer,
      jobTitle: body.creditApp.jobTitle,
      employmentMonths: body.creditApp.employmentMonths,
      grossMonthlyIncome: body.creditApp.grossMonthlyIncome,
      housingStatus: body.creditApp.housingStatus,
      housingPayment: body.creditApp.housingPayment,
      residenceMonths: body.creditApp.residenceMonths,
      creditScore: CREDIT_BANDS[body.financing.creditBand],
      creditScoreSource: 'self_reported',
      ssnLast4: ssn ? ssn.slice(-4) : undefined,
      ssnEncrypted: ssn ? encryptPii(ssn) || undefined : undefined,
      consent: { granted: true, at: now, ip: String(req.ip || ''), text: CONSENT_TEXT },
    },
    depositRequested: !!body.wantsDeposit,
    timestamps: { submittedAt: now },
    lastActivityAt: now,
  });

  await logEvent(deal, null, 'web_submitted', { origin: req.headers.origin, creditBand: body.financing.creditBand });
  await postSystemMessage(deal, `🌐 New online purchase from the website: ${body.customer.firstName} ${body.customer.lastName}${body.wantsDeposit ? ' — wants to place a deposit' : ''}.`);
  emitDealChanged(deal, 'created');
  emitToStaff(String(orgId), 'deal:web', toDealSummary(deal));

  res.status(201).json(
    new ApiResponse(201, {
      reference: `#${deal.dealNumber}`,
      message: `Thanks, ${body.customer.firstName}! Our online sales team has your request and will contact you shortly.`,
      depositAmount: body.wantsDeposit ? settings.widget?.depositAmount ?? 500 : 0,
    }, 'Submitted'),
  );
});
