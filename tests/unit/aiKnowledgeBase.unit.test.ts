import mongoose from 'mongoose';
import {
  effectiveApprovedScope,
  isEligibleAt,
  isKnowledgeBaseEnabled,
  knowledgeApprovalState,
  isRuntimeEligible,
  knowledgeKey,
  needsReapproval,
  normalizeKnowledgeKey,
  parseKnowledgeInput,
  requireKnowledgeBaseServer,
  scopesOverlap,
} from '../../src/services/aiKnowledgeBase.service';
import { scopeCovers, scopeIncludesLocation } from '../../src/services/aiKnowledgeCommon';

const L1 = '64f0000000000000000000a1';
const L2 = '64f0000000000000000000a2';
const fields = (fn: () => unknown) => {
  try {
    fn();
    return [];
  } catch (err: any) {
    expect(err.statusCode).toBe(400);
    return (err.errors || []).map((issue: any) => `${issue.field}:${issue.code}`);
  }
};
const faq = (overrides: Record<string, unknown> = {}) => ({
  kind: 'faq', topic: 'hours', question: 'What are your Saturday hours?', answer: 'We are open Saturday from 9am to 5pm.', locations: { scope: 'all' }, ...overrides,
});

describe('parseKnowledgeInput', () => {
  it('accepts an FAQ for All Locations and defaults the title and channels', () => {
    expect(parseKnowledgeInput(faq({ changeNote: '  First draft  ' }))).toEqual({
      content: {
        kind: 'faq', topic: 'hours', title: 'What are your Saturday hours?', question: 'What are your Saturday hours?',
        answer: 'We are open Saturday from 9am to 5pm.', channels: ['sms', 'webchat', 'email'], locationScope: { scope: 'all', locationIds: [] },
      },
      changeNote: 'First draft',
    });
  });

  it('accepts business information for specific locations and keeps answer line breaks', () => {
    const { content } = parseKnowledgeInput({
      kind: 'business_info', topic: 'hours', title: 'Showroom hours', answer: 'Mon-Fri: 9am to 7pm\r\n  Sat:   9am to 5pm\n\n\n\nSun: closed',
      channels: ['sms', 'sms', 'webchat'], locations: { scope: 'locations', locationIds: [L1, L2] },
    });
    expect(content.answer).toBe('Mon-Fri: 9am to 7pm\nSat: 9am to 5pm\n\nSun: closed');
    expect(content.channels).toEqual(['sms', 'webchat']);
    expect(content.locationScope.locationIds.map(String)).toEqual([L1, L2]);
    expect(content.question).toBeUndefined();
  });

  it('requires an explicit location choice and never guesses one', () => {
    expect(fields(() => parseKnowledgeInput(faq({ locations: undefined })))).toEqual(['locations:location_required']);
    expect(fields(() => parseKnowledgeInput(faq({ locations: {} })))).toEqual(['locations.scope:location_required']);
    expect(fields(() => parseKnowledgeInput(faq({ locations: { scope: 'locations' } })))).toEqual(['locations.locationIds:location_required']);
    expect(fields(() => parseKnowledgeInput(faq({ locations: { scope: 'locations', locationIds: [] } })))).toEqual(['locations.locationIds:location_required']);
    expect(fields(() => parseKnowledgeInput(faq({ locations: { scope: 'all', locationIds: [L1] } })))).toEqual(['locations.locationIds:ambiguous_scope']);
    expect(fields(() => parseKnowledgeInput(faq({ locations: { scope: 'locations', locationIds: [L1, L1.toUpperCase(), 'orem', 7] } })))).toEqual([
      'locations.locationIds.1:duplicate_location', 'locations.locationIds.2:location_not_found', 'locations.locationIds.3:invalid_type',
    ]);
    expect(fields(() => parseKnowledgeInput(faq({ locations: { scope: 'locations', locationIds: Array.from({ length: 21 }, (_, i) => new mongoose.Types.ObjectId().toString() + String(i).slice(0, 0)) } })))).toEqual(['locations.locationIds:too_many']);
    expect(fields(() => parseKnowledgeInput(faq({ locations: 'all' })))).toEqual(['locations:invalid_type']);
  });

  it('validates required fields, types and limits field by field', () => {
    expect(fields(() => parseKnowledgeInput({}))).toEqual([
      'kind:required', 'topic:required', 'answer:required', 'locations:location_required',
    ]);
    expect(fields(() => parseKnowledgeInput(faq({ question: undefined })))).toEqual(['question:required']);
    expect(fields(() => parseKnowledgeInput(faq({ kind: 'business_info', question: undefined })))).toEqual(['title:required']);
    expect(fields(() => parseKnowledgeInput(faq({ kind: 'rule', topic: 'pricing' })))).toEqual(['kind:invalid_value', 'topic:invalid_value']);
    expect(fields(() => parseKnowledgeInput(faq({ answer: 'x'.repeat(1001), question: { text: 'hi' } })))).toEqual(['question:invalid_type', 'answer:too_long']);
    expect(fields(() => parseKnowledgeInput(faq({ channels: [] })))).toEqual(['channels:invalid_value']);
    expect(fields(() => parseKnowledgeInput(faq({ channels: ['sms', 'fax'] })))).toEqual(['channels.1:invalid_value']);
    expect(fields(() => parseKnowledgeInput(faq({ title: 'x'.repeat(121) })))).toEqual(['title:too_long']);
  });

  it("never lets an edit change an entry's type", () => {
    expect(fields(() => parseKnowledgeInput(faq({ kind: 'business_info', title: 'Hours' }), 'faq'))).toEqual(['kind:kind_immutable']);
    expect(parseKnowledgeInput(faq({ kind: undefined }), 'faq').content.kind).toBe('faq');
  });
});

describe('keys, overlap and eligibility', () => {
  it('normalizes questions so wording differences in case, accents and punctuation still match', () => {
    expect(normalizeKnowledgeKey('  What ARE your hours…?? ')).toBe('what are your hours');
    expect(normalizeKnowledgeKey('Café hours')).toBe('cafe hours');
    expect(knowledgeKey({ kind: 'faq', topic: 'hours', title: 'x', question: 'What are your hours?' })).toBe('what are your hours');
    expect(knowledgeKey({ kind: 'business_info', topic: 'hours', title: 'Showroom Hours' })).toBe('hours:showroom hours');
  });

  it('treats All Locations as overlapping everything and specific lists as overlapping only when they share a location', () => {
    const all = { scope: 'all', locationIds: [] };
    const one = { scope: 'locations', locationIds: [L1] };
    const two = { scope: 'locations', locationIds: [L2] };
    expect(scopesOverlap(all, one)).toBe(true);
    expect(scopesOverlap(one, all)).toBe(true);
    expect(scopesOverlap(one, { scope: 'locations', locationIds: [L2, L1] })).toBe(true);
    expect(scopesOverlap(one, two)).toBe(false);
    expect(scopesOverlap(one, null)).toBe(false);
  });

  it('only an active entry with a valid approval for at least one location could ever be used later', () => {
    const all = { scope: 'all', locationIds: [] };
    const two = { scope: 'locations', locationIds: [L1, L2] };
    expect(isRuntimeEligible({ lifecycle: 'active', approvedVersion: 2, approvedLocationScope: all })).toBe(true);
    expect(isRuntimeEligible({ lifecycle: 'disabled', approvedVersion: 2, approvedLocationScope: all })).toBe(false);
    expect(isRuntimeEligible({ lifecycle: 'archived', approvedVersion: 2, approvedLocationScope: all })).toBe(false);
    expect(isRuntimeEligible({ lifecycle: 'active', approvedLocationScope: all })).toBe(false);
    expect(isRuntimeEligible({ lifecycle: 'active', approvedVersion: 2, approvedLocationScope: all, approvalInvalidation: { reason: 'detail_revoked' } })).toBe(false);
    expect(isRuntimeEligible({ lifecycle: 'active', approvedVersion: 2, approvedLocationScope: two, approvalSuspendedLocationIds: [L1] })).toBe(true);
    expect(isRuntimeEligible({ lifecycle: 'active', approvedVersion: 2, approvedLocationScope: two, approvalSuspendedLocationIds: [L1, L2] })).toBe(false);
  });

  it('suspends single locations of a multi-location approval and asks for re-approval', () => {
    const two = { scope: 'locations', locationIds: [L1, L2] };
    expect(effectiveApprovedScope({ approvedLocationScope: two, approvalSuspendedLocationIds: [L1] })).toEqual({ scope: 'locations', locationIds: [L2] });
    expect(effectiveApprovedScope({ approvedLocationScope: two, approvalSuspendedLocationIds: [L1, L2] })).toBeNull();
    expect(effectiveApprovedScope({ approvedLocationScope: { scope: 'all', locationIds: [] }, approvalSuspendedLocationIds: [L1] })).toEqual({ scope: 'all', locationIds: [], excludedLocationIds: [L1] });
    expect(needsReapproval({ approvedVersion: 1, approvalSuspendedLocationIds: [L1] })).toBe(true);
    expect(needsReapproval({ approvedVersion: 1, approvalInvalidation: { reason: 'entry_restored' } })).toBe(true);
    expect(needsReapproval({ approvedVersion: 1, approvalSuspendedLocationIds: [] })).toBe(false);
    expect(needsReapproval({ approvalInvalidation: { reason: 'entry_restored' } })).toBe(false);
  });

  it('an All Locations approval stays usable elsewhere but not at a suspended location', () => {
    const all = { lifecycle: 'active', approvedVersion: 1, approvedLocationScope: { scope: 'all', locationIds: [] }, approvalSuspendedLocationIds: [L1] };
    expect(isRuntimeEligible(all)).toBe(true);
    expect(isEligibleAt(all, L1)).toBe(false);
    expect(isEligibleAt(all, L2)).toBe(true);
    const specific = { lifecycle: 'active', approvedVersion: 1, approvedLocationScope: { scope: 'locations', locationIds: [L1, L2] }, approvalSuspendedLocationIds: [L1] };
    expect(isEligibleAt(specific, L1)).toBe(false);
    expect(isEligibleAt(specific, L2)).toBe(true);
    expect(isEligibleAt({ ...specific, approvalInvalidation: { reason: 'entry_restored' } }, L2)).toBe(false);
    expect(isEligibleAt({ ...specific, lifecycle: 'disabled' }, L2)).toBe(false);
  });

  it('reports an honest approval state and ignores suspensions of locations that are still archived', () => {
    const base = { lifecycle: 'active', approvedVersion: 1, approvedLocationScope: { scope: 'all', locationIds: [] } };
    expect(knowledgeApprovalState({ lifecycle: 'active' })).toBe('not_approved');
    expect(knowledgeApprovalState(base)).toBe('valid');
    expect(knowledgeApprovalState({ ...base, approvalSuspendedLocationIds: [L1] }, new Set([L1, L2]))).toBe('partial');
    expect(knowledgeApprovalState({ ...base, approvalSuspendedLocationIds: [L1] }, new Set([L2]))).toBe('valid');
    expect(knowledgeApprovalState({ ...base, approvedLocationScope: { scope: 'locations', locationIds: [L1] }, approvalSuspendedLocationIds: [L1] })).toBe('suspended');
    expect(knowledgeApprovalState({ ...base, approvalInvalidation: { reason: 'detail_revoked' } })).toBe('invalidated');
    expect(knowledgeApprovalState({ ...base, lifecycle: 'disabled' })).toBe('disabled');
    expect(knowledgeApprovalState({ ...base, lifecycle: 'archived' })).toBe('archived');
    expect(needsReapproval({ ...base, approvalSuspendedLocationIds: [L1] }, new Set([L2]))).toBe(false);
    expect(needsReapproval({ ...base, approvalSuspendedLocationIds: [L1] }, new Set([L1]))).toBe(true);
  });

  it('scope checks understand All Locations with suspended locations', () => {
    const allButOne = { scope: 'all', locationIds: [], excludedLocationIds: [L1] };
    expect(scopeIncludesLocation(allButOne, L1)).toBe(false);
    expect(scopeIncludesLocation(allButOne, L2)).toBe(true);
    expect(scopesOverlap(allButOne, { scope: 'locations', locationIds: [L1] })).toBe(false);
    expect(scopesOverlap(allButOne, { scope: 'locations', locationIds: [L1, L2] })).toBe(true);
    expect(scopeCovers(allButOne, { scope: 'locations', locationIds: [L2] })).toBe(true);
    expect(scopeCovers(allButOne, { scope: 'locations', locationIds: [L1] })).toBe(false);
    expect(scopeCovers(allButOne, { scope: 'all', locationIds: [] })).toBe(false);
    expect(scopeCovers(allButOne, allButOne)).toBe(true);
  });

  it('a verified detail only covers an entry when it covers every location the entry uses', () => {
    const all = { scope: 'all', locationIds: [] };
    expect(scopeCovers(all, { scope: 'locations', locationIds: [L1] })).toBe(true);
    expect(scopeCovers(all, all)).toBe(true);
    expect(scopeCovers({ scope: 'locations', locationIds: [L1] }, all)).toBe(false);
    expect(scopeCovers({ scope: 'locations', locationIds: [L1, L2] }, { scope: 'locations', locationIds: [L2] })).toBe(true);
    expect(scopeCovers({ scope: 'locations', locationIds: [L1] }, { scope: 'locations', locationIds: [L1, L2] })).toBe(false);
  });
});

describe('feature flag', () => {
  const original = process.env.AI_KNOWLEDGE_BASE_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.AI_KNOWLEDGE_BASE_ENABLED;
    else process.env.AI_KNOWLEDGE_BASE_ENABLED = original;
  });

  it('is off unless AI_KNOWLEDGE_BASE_ENABLED is exactly "true", and is independent of AI runtime flags', () => {
    for (const value of [undefined, '', 'false', 'TRUE', '1', 'yes']) {
      if (value === undefined) delete process.env.AI_KNOWLEDGE_BASE_ENABLED;
      else process.env.AI_KNOWLEDGE_BASE_ENABLED = value;
      process.env.AI_AGENT_ENABLED = 'true';
      process.env.AI_TRAINING_ENABLED = 'true';
      expect(isKnowledgeBaseEnabled()).toBe(false);
      expect(() => requireKnowledgeBaseServer()).toThrow('The Knowledge Base is not available.');
    }
    process.env.AI_KNOWLEDGE_BASE_ENABLED = 'true';
    delete process.env.AI_AGENT_ENABLED;
    delete process.env.AI_TRAINING_ENABLED;
    expect(isKnowledgeBaseEnabled()).toBe(true);
  });
});
