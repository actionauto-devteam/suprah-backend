/**
 * Deal Desk unit tests — pure logic (no database).
 * Run: npx tsx --test src/services/dealDesk/__tests__/dealDesk.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStructure, monthlyPayment, ltv, dti, pti, rateForScore } from '../calc';
import { analyzeDeal, hasBlockingFlags } from '../analysis';
import { mergeExtraction, templateSummary } from '../ai';
import { encryptPii, decryptPii, normalizeSsn, maskSsn } from '../pii';
import { slaStatus } from '../queue';
import { STAGE_TRANSITIONS, DEAL_STAGES } from '../constants';

test('structure: tax after trade credit, negative equity rolls in', () => {
  const s = computeStructure({ salePrice: 30000, docFee: 400, taxRate: 7.25, downPayment: 2000, tradeAllowance: 8000, tradePayoff: 10000, backendProducts: 1500 });
  // taxable = 30000 + 400 − 8000 = 22400 → tax 1624
  assert.equal(s.taxableAmount, 22400);
  assert.equal(s.taxAmount, 1624);
  assert.equal(s.netTrade, -2000);
  // 30000 + 400 + 1624 + 1500 − 2000 − (−2000) = 33524
  assert.equal(s.amountFinanced, 33524);
});

test('structure: never negative', () => {
  assert.equal(computeStructure({ salePrice: 5000, downPayment: 9000 }).amountFinanced, 0);
});

test('payment: standard amortization and 0% APR', () => {
  assert.equal(monthlyPayment(25000, 6.9, 60), 493.85);
  assert.equal(monthlyPayment(24000, 0, 48), 500);
  assert.equal(monthlyPayment(0, 7, 60), 0);
});

test('ratios: LTV / DTI / PTI', () => {
  assert.equal(ltv(24000, 20000), 120);
  assert.equal(ltv(24000, 0), undefined);
  const inc = { grossMonthlyIncome: 5000, monthlyDebt: 400, housingPayment: 1200 };
  assert.equal(dti(inc, 500), 42);
  assert.equal(pti(inc, 500), 10);
  assert.equal(dti({}, 500), undefined);
});

test('rate tiers pick the right band', () => {
  assert.equal(rateForScore(800), 5.49);
  assert.equal(rateForScore(700), 7.99);
  assert.equal(rateForScore(520), 21.99);
  assert.equal(rateForScore(undefined), 10.49);
});

const baseDeal = () => ({
  vehicle: { year: 2022, make: 'Toyota', model: 'Tacoma', mileage: 30000, price: 32000, bookValue: 30000 },
  tradeIn: { present: false },
  fourSquare: { salePrice: 32000, downPayment: 3000, desiredTerm: 72, taxRate: 7.25, docFee: 399 },
  creditApp: { grossMonthlyIncome: 6500, monthlyDebt: 350, housingPayment: 1400, creditScore: 712, creditScoreSource: 'bureau', employmentMonths: 30, residenceMonths: 40, consent: { granted: true } },
  documents: [{ kind: 'four_square' }, { kind: 'credit_app' }, { kind: 'drivers_license' }, { kind: 'proof_income' }],
});

const lenders = [
  { _id: 'a', name: 'Credit Union A', type: 'credit_union', minScore: 660, maxLtv: 125, maxDti: 45, maxTerm: 84, rateTiers: [{ minScore: 700, rate: 5.99 }, { minScore: 660, rate: 7.49 }] },
  { _id: 'b', name: 'Bank B', type: 'bank', minScore: 700, maxLtv: 110, maxDti: 40, maxTerm: 72 },
  { _id: 'c', name: 'Captive C', type: 'captive', minScore: 740, maxLtv: 120, maxDti: 45 },
  { _id: 'd', name: 'Inactive', active: false, minScore: 0 },
];

test('analysis: clean deal ranks lenders and has no blocking flags', () => {
  const a = analyzeDeal(baseDeal(), lenders as any, { now: new Date('2026-11-20') });
  assert.ok(a.amountFinanced > 30000 && a.amountFinanced < 33000);
  assert.ok(a.ltv! > 100 && a.ltv! < 112);
  assert.equal(hasBlockingFlags(a.flags), false);
  assert.equal(a.lenderMatches.length, 3, 'inactive lender excluded');
  assert.equal(a.lenderMatches[0].name, 'Credit Union A');
  assert.equal(a.lenderMatches.find((m) => m.name === 'Captive C')!.fit, 'fail');
  assert.match(a.lenderMatches.find((m) => m.name === 'Captive C')!.reasons[0], /Score 712 below 740/);
  assert.equal(a.estRate, 5.99);
  assert.ok(a.readiness >= 90, `readiness ${a.readiness}`);
});

test('analysis: missing consent / price / income are blocking', () => {
  const d: any = baseDeal();
  d.creditApp.consent = { granted: false };
  d.creditApp.grossMonthlyIncome = 0;
  d.fourSquare.salePrice = undefined;
  d.vehicle.price = undefined;
  const a = analyzeDeal(d, lenders as any);
  const codes = a.flags.map((f) => f.code);
  assert.ok(codes.includes('no_consent') && codes.includes('no_income') && codes.includes('no_price'));
  assert.equal(hasBlockingFlags(a.flags), true);
  assert.ok(a.readiness <= 0);
});

test('analysis: high LTV and missing docs are flagged, no lender fits', () => {
  const d: any = baseDeal();
  d.vehicle.bookValue = 20000;
  d.documents = [];
  const a = analyzeDeal(d, lenders as any);
  const codes = a.flags.map((f) => f.code);
  assert.ok(codes.includes('ltv_high'));
  assert.ok(codes.includes('missing_four_square'));
  assert.ok(codes.includes('no_lender'));
  assert.ok(a.lenderMatches.every((m) => m.fit === 'fail'));
});

test('extraction merge: fills empties, never overwrites, flags conflicts', () => {
  const deal = { customer: { firstName: 'Ana' }, creditApp: { grossMonthlyIncome: 6000 }, vehicle: { vin: '1HGCM82633A004352' } };
  const r = mergeExtraction(deal, {
    customer: { firstName: 'Anna', lastName: 'Reyes' },
    creditApp: { grossMonthlyIncome: 4800, employer: 'Acme' },
    vehicle: { vin: '5YJ3E1EA7KF317000' },
    tradeIn: { allowance: 9000 },
  });
  assert.equal(r.set['customer.lastName'], 'Reyes');
  assert.equal(r.set['creditApp.employer'], 'Acme');
  assert.equal(r.set['customer.firstName'], undefined, 'entered value wins');
  assert.equal(r.set['tradeIn.present'], true);
  assert.equal(r.conflicts.length, 2);
  assert.match(r.conflicts.join(' '), /Monthly income/);
  assert.match(r.conflicts.join(' '), /VIN/);
});

test('template summary mentions structure and best lender', () => {
  const a = analyzeDeal(baseDeal(), lenders as any);
  const text = templateSummary({ firstName: 'Ana', vehicle: '2022 Toyota Tacoma', analysis: a, lenders: a.lenderMatches });
  assert.match(text, /Ana/);
  assert.match(text, /Credit Union A/);
  assert.match(text, /LTV/);
});

test('PII: encrypts with key, refuses without', () => {
  const prev = process.env.DEAL_PII_KEY;
  delete process.env.DEAL_PII_KEY;
  // key is cached per process: test the normalize/mask helpers first
  assert.equal(normalizeSsn('123-45-6789'), '123456789');
  assert.equal(normalizeSsn('1234'), null);
  assert.equal(maskSsn('6789'), '•••-••-6789');
  process.env.DEAL_PII_KEY = prev;
});

test('PII round trip (AES-256-GCM)', () => {
  process.env.DEAL_PII_KEY = 'a'.repeat(64);
  const enc = encryptPii('123456789');
  assert.ok(enc && enc.startsWith('v1:'));
  assert.notEqual(enc, '123456789');
  assert.equal(decryptPii(enc), '123456789');
  assert.notEqual(encryptPii('123456789'), enc, 'random IV each time');
});

test('SLA colors: ok → warn → late', () => {
  const now = Date.now();
  const sla = { submitted: 10 };
  assert.equal(slaStatus('submitted', new Date(now - 5 * 60000), sla, now), 'ok');
  assert.equal(slaStatus('submitted', new Date(now - 15 * 60000), sla, now), 'warn');
  assert.equal(slaStatus('submitted', new Date(now - 25 * 60000), sla, now), 'late');
  assert.equal(slaStatus('funded', new Date(now), sla, now), 'none');
});

test('stage machine: every stage has rules, terminal stages are final, F&I path exists', () => {
  for (const s of DEAL_STAGES) assert.ok(Array.isArray(STAGE_TRANSITIONS[s]), s);
  assert.deepEqual(STAGE_TRANSITIONS.funded, []);
  assert.deepEqual(STAGE_TRANSITIONS.cancelled, []);
  const path = ['draft', 'submitted', 'picked_up', 'processing', 'structured', 'ready_for_fi', 'offered', 'in_fi', 'signed', 'funded'] as const;
  for (let i = 0; i < path.length - 1; i++) assert.ok(STAGE_TRANSITIONS[path[i]].includes(path[i + 1]), `${path[i]} → ${path[i + 1]}`);
  assert.ok(STAGE_TRANSITIONS.offered.includes('ready_for_fi'), 'rotation: offered → ready_for_fi');
  assert.ok(STAGE_TRANSITIONS.processing.includes('needs_info'));
});
