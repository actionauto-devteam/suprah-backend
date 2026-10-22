import mongoose from 'mongoose';
import { matchKnowledgeDependencies, parseVerifiedDetailInput } from '../../src/services/aiKnowledgeVerifiedDetails.service';
import { knowledgeContactValues, knowledgeContentCheck, normalizeKnowledgeKey } from '../../src/services/aiKnowledgeSafety';

const ALL = { scope: 'all' };
const fields = (fn: () => unknown) => {
  try {
    fn();
    return [];
  } catch (err: any) {
    expect(err.statusCode).toBe(400);
    return (err.errors || []).map((issue: any) => `${issue.field}:${issue.code}`);
  }
};
const parse = (body: Record<string, unknown>) => parseVerifiedDetailInput({ locations: ALL, ...body });

describe('parseVerifiedDetailInput', () => {
  it('normalizes phone numbers, emails and websites', () => {
    expect(parse({ kind: 'phone', value: '(801) 867-5309' })).toMatchObject({ kind: 'phone', value: '(801) 867-5309', normalizedValue: '8018675309' });
    expect(parse({ kind: 'phone', value: '+1 801.867.5309' }).normalizedValue).toBe('8018675309');
    expect(parse({ kind: 'email', value: 'Sales@RealDealer.com' }).normalizedValue).toBe('sales@realdealer.com');
    for (const value of ['realdealer.com', 'https://www.RealDealer.com/inventory?x=1', 'http://shop.realdealer.com']) {
      expect(parse({ kind: 'website', value }).normalizedValue).toMatch(/^(shop\.)?realdealer\.com$/);
    }
  });

  it('rejects malformed values, private labels and unknown kinds', () => {
    expect(fields(() => parse({ kind: 'phone', value: '867-5309' }))).toEqual(['value:invalid_phone']);
    expect(fields(() => parse({ kind: 'phone', value: 'call 8018675309' }))).toEqual(['value:invalid_phone']);
    expect(fields(() => parse({ kind: 'email', value: 'sales at realdealer' }))).toEqual(['value:invalid_email']);
    for (const value of ['javascript:alert(1)', '10.0.0.1', 'https://user:pw@realdealer.com', 'localhost']) {
      expect(fields(() => parse({ kind: 'website', value }))).toEqual(['value:invalid_website']);
    }
    expect(fields(() => parse({ kind: 'phone', value: '8018675309', label: 'Jordan cell 801-555-0199 jordan@gmail.com' }))).toEqual(['label:label_private']);
    expect(fields(() => parse({ kind: 'fax', value: '8018675309' }))).toEqual(['kind:invalid_value']);
    expect(fields(() => parseVerifiedDetailInput({ kind: 'phone', value: '8018675309' }))).toEqual(['locations:location_required']);
    expect(fields(() => parse({ kind: 'phone', value: '8018675309', programType: 'military' }))).toEqual(['programType:not_allowed']);
    expect(fields(() => parseVerifiedDetailInput({ kind: 'email', value: 'a@b.com', locations: ALL }, 'phone'))).toEqual(['kind:kind_immutable', 'value:invalid_phone']);
  });

  it('requires specific program names without amounts, and a program type', () => {
    expect(parse({ kind: 'program', value: 'Military Appreciation Program', programType: 'military' })).toMatchObject({
      kind: 'program', normalizedValue: 'military appreciation program', programType: 'military',
    });
    expect(fields(() => parse({ kind: 'program', value: 'Military', programType: 'military' }))).toEqual(['value:program_name']);
    expect(fields(() => parse({ kind: 'program', value: '$500 Military Program', programType: 'military' }))).toEqual(['value:program_amount']);
    expect(fields(() => parse({ kind: 'program', value: 'Military Appreciation Program' }))).toEqual(['programType:required']);
  });
});

describe('dependencies and context', () => {
  const ids = Array.from({ length: 5 }, () => new mongoose.Types.ObjectId());
  const details = [
    { _id: ids[0], kind: 'phone', normalizedValue: '8018675309', revision: 2 },
    { _id: ids[1], kind: 'email', normalizedValue: 'sales@realdealer.com', revision: 1 },
    { _id: ids[2], kind: 'website', normalizedValue: 'realdealer.com', revision: 3 },
    { _id: ids[3], kind: 'program', normalizedValue: 'military appreciation program', revision: 1 },
    { _id: ids[4], kind: 'phone', normalizedValue: '8015550000', revision: 1 },
  ];

  it('extracts contact values the same way the privacy check reads them', () => {
    const values = knowledgeContactValues('Call (801) 867-5309, email Sales@RealDealer.com or visit https://www.realdealer.com/hours and shop.realdealer.com.');
    expect(Array.from(values.phones)).toEqual(['8018675309']);
    expect(Array.from(values.emails)).toEqual(['sales@realdealer.com']);
    expect(Array.from(values.domains).sort()).toEqual(['realdealer.com', 'shop.realdealer.com']);
  });

  it('records exactly the verified details an answer depends on, and an email never depends on the website', () => {
    const deps = matchKnowledgeDependencies({ title: 'Contact us', answer: 'Call 801-867-5309 or email sales@realdealer.com. Ask about our Military Appreciation Program.' }, details);
    expect(deps.map((dep) => [String(dep.detailId), dep.revision])).toEqual([
      [String(ids[0]), 2], [String(ids[1]), 1], [String(ids[3]), 1],
    ]);
    expect(matchKnowledgeDependencies({ answer: 'Visit realdealer.com today.' }, details).map((dep) => String(dep.detailId))).toEqual([String(ids[2])]);
    expect(matchKnowledgeDependencies({ answer: 'Visit our showroom during business hours.' }, details)).toEqual([]);
  });

  it('allows approved contacts and programs without weakening the other rules', () => {
    const context = {
      contacts: { phones: new Set(['8018675309']), emails: new Set<string>(), domains: new Set(['realdealer.com']) },
      programNames: [normalizeKnowledgeKey('Military Appreciation Program')],
    };
    const check = (answer: string, ctx = context) => knowledgeContentCheck({ kind: 'faq', title: 'Programs', question: 'Do you have programs?', answer }, ctx).errors.map((issue) => `${issue.field}:${issue.code}`);
    expect(check('Call 801-867-5309 or visit realdealer.com.')).toEqual([]);
    expect(check('Email sales@realdealer.com for help.')).toEqual(['answer:real_email']);
    expect(check('Email sales@realdealer.com for help.', { ...context, contacts: { ...context.contacts, emails: new Set(['sales@realdealer.com']) } })).toEqual([]);
    expect(check('Email sales@shop.realdealer.com for help.', { ...context, contacts: { ...context.contacts, emails: new Set(['sales@realdealer.com']) } })).toEqual(['answer:real_email']);
    expect(check('Email test@example.com for help.')).toEqual([]);
    expect(check('Call 801-867-5309.', { ...context, contacts: { phones: new Set(), emails: new Set(), domains: new Set() } })).toEqual(['answer:real_phone']);
    expect(check('Our Military Appreciation Program offers a discount for active-duty and retired service members. Our team can confirm eligibility.')).toEqual([]);
    expect(check('Our Military Appreciation Program offers a discount for service members.', { ...context, programNames: [] })).toEqual(['answer:knowledge_discount_offer']);
    expect(check('Our Hero Savings Program offers a discount for service members.')).toEqual(['answer:knowledge_discount_offer']);
    expect(check('Our Military Appreciation Program takes $500 off for service members.')).toContain('answer:guardrail_figure');
    expect(check('All veterans qualify for our Military Appreciation Program discount.')).toEqual(['answer:knowledge_program_terms']);
    expect(check("With our Military Appreciation Program you'll save on any car.")).toEqual(['answer:knowledge_program_terms']);
    expect(check('Our Military Appreciation Program discount can be combined with any other offer.')).toEqual(['answer:knowledge_program_terms']);
    expect(check('Our Military Appreciation Program gets you the lowest price.')).toEqual(['answer:knowledge_price_claims']);
    expect(check('Our Military Appreciation Program includes zero down financing.')).toEqual(expect.arrayContaining(['answer:knowledge_payment_terms']));
    expect(check('Financing approval is guaranteed with our Military Appreciation Program.')).toEqual(expect.arrayContaining(['answer:guardrail_promise']));
  });

  describe('approved-program wording regressions', () => {
    const context = { programNames: [normalizeKnowledgeKey('Military Appreciation Program')] };
    const errors = (answer: string, ctx: any = context) =>
      knowledgeContentCheck({ kind: 'faq', title: 'Programs', question: 'Do you have programs?', answer }, ctx).errors.map((issue) => issue.code);

    it('only the sentence that names the approved program may mention a discount', () => {
      expect(errors('We offer the Military Appreciation Program. Ask about our spring rebates too.')).toEqual(['knowledge_discount_offer']);
      expect(errors('Our Military Appreciation Program is for service members. It is a discount on accessories.')).toEqual(['knowledge_discount_offer']);
      expect(errors('Our Military Appreciation Program offers a discount for service members.')).toEqual([]);
    });

    it('accepted limitation: a second discount word inside the program sentence is allowed, but never amounts or promises', () => {
      expect(errors('Our Military Appreciation Program offers a discount and other incentives for service members.')).toEqual([]);
      expect(errors('Our Military Appreciation Program offers a discount and $500 in incentives.')).toContain('guardrail_figure');
      expect(errors('Our Military Appreciation Program discount plus incentives means you will save on any car.')).toEqual(['knowledge_program_terms']);
    });

    it('unsupported programs never unlock discount wording', () => {
      expect(errors('Our Military Appreciation Program offers a discount.', { programNames: [] })).toEqual(['knowledge_discount_offer']);
      expect(errors('Our Military Program offers a discount.')).toEqual(['knowledge_discount_offer']);
      expect(errors('Our Veterans Appreciation Program offers a discount.')).toEqual(['knowledge_discount_offer']);
      expect(errors('Our military appreciation program offers a discount.')).toEqual([]);
    });

    it('blocks guaranteed eligibility in any wording', () => {
      for (const answer of [
        'All veterans qualify for our Military Appreciation Program discount.',
        'Every active-duty member gets the Military Appreciation Program discount.',
        'Our Military Appreciation Program discount is guaranteed for service members.',
        'With our Military Appreciation Program discount you will qualify automatically.',
        'Service members automatically qualify for the Military Appreciation Program discount.',
        'Everyone qualifies for the Military Appreciation Program discount.',
      ]) {
        expect(errors(answer)).toEqual(expect.arrayContaining([expect.stringMatching(/^(knowledge_program_terms|guardrail_promise)$/)]));
      }
    });

    it('blocks discount stacking and combining claims', () => {
      for (const answer of [
        'Our Military Appreciation Program discount stacks with other offers.',
        'You can stack the Military Appreciation Program discount with rebates.',
        'Our Military Appreciation Program discount can be combined with any other incentive.',
        'Combine our Military Appreciation Program discount with all current offers.',
        'Use the Military Appreciation Program discount together with other incentives.',
        'Get our Military Appreciation Program discount on top of other rebates.',
      ]) {
        expect(errors(answer)).toContain('knowledge_program_terms');
      }
    });

    it('never relaxes pricing, payment or financing rules inside a program sentence', () => {
      expect(errors('Our Military Appreciation Program discount gets you below invoice pricing.')).toContain('knowledge_price_claims');
      expect(errors('Our Military Appreciation Program discount includes zero down.')).toContain('knowledge_payment_terms');
      expect(errors('Our Military Appreciation Program discount comes with special financing.')).toContain('knowledge_financing_terms');
      expect(errors('Our Military Appreciation Program discount is 10% off.')).toContain('guardrail_figure');
    });
  });
});
