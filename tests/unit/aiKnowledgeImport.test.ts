import {
  KNOWLEDGE_PREVIEW_CODES,
  contactVerificationMessage,
  mentionsContact,
  knowledgeBodyForImport,
  knowledgeScopeForImport,
  mergeContactSets,
  statusFromIssues,
} from '../../src/services/aiKnowledgeImport.service';

describe('Knowledge Base import helpers', () => {
  it('explains missing verified contacts in plain words and points to the screen to fix it', () => {
    expect(contactVerificationMessage([{ field: 'answer', code: 'real_phone', message: 'x' }])).toBe(
      "This answer has a phone number that isn't approved in Verified contacts for this location yet. Add it in Knowledge Base → Verified contacts & programs, then save this item again.",
    );
    expect(contactVerificationMessage([
      { field: 'answer', code: 'real_phone', message: 'x' },
      { field: 'answer', code: 'real_email', message: 'y' },
      { field: 'answer', code: 'real_link', message: 'z' },
    ])).toMatch(/^This answer has a phone number, email address and website that aren't approved/);
    expect(contactVerificationMessage([{ field: 'answer', code: 'real_phone', message: 'x' }], { pending: true })).toBe(
      'This answer has a phone number that is waiting for approval in Verified contacts. After another manager or admin approves it, save this item again.',
    );
    expect(contactVerificationMessage([{ field: 'answer', code: 'real_phone', message: 'x' }], { pending: true, preview: true })).toMatch(/waiting for approval.*can become a draft after another manager or admin approves it/);
    expect(contactVerificationMessage([{ field: 'answer', code: 'ssn', message: 'x' }])).toBeNull();
  });

  it('classifies issues as contact verification or general attention', () => {
    expect(statusFromIssues([{ field: 'answer', code: 'real_email', message: 'm' }]).state).toBe('needs_contact_verification');
    expect(statusFromIssues([{ field: 'answer', code: 'real_email', message: 'm' }], true)).toMatchObject({ state: 'needs_contact_verification', message: expect.stringMatching(/waiting for approval/) });
    expect(statusFromIssues([{ field: 'locations', code: 'location_archived', message: 'That location is archived.' }])).toEqual({ state: 'needs_attention', message: 'That location is archived.' });
    expect(statusFromIssues([]).state).toBe('needs_attention');
  });

  it('maps import locations to Knowledge Base scopes and never invents All Locations', () => {
    expect(knowledgeScopeForImport({ kind: 'all' })).toEqual({ scope: 'all', locationIds: [] });
    expect(knowledgeScopeForImport({ kind: 'location', locationId: 'abc' })).toEqual({ scope: 'locations', locationIds: ['abc'] });
    expect(knowledgeScopeForImport({ kind: 'none' })).toBeNull();
    expect(knowledgeScopeForImport({ kind: 'location' })).toBeNull();
    expect(knowledgeScopeForImport(undefined)).toBeNull();
  });

  it('builds the draft from the stored Podium content with a clear change note', () => {
    const payload = { kind: 'faq', topic: 'hours', title: 'Saturday hours', channels: ['sms', 'email'], content: { question: 'Open Saturday?', answer: 'Yes, nine to six.' } };
    expect(knowledgeBodyForImport(payload, { scope: 'locations', locationIds: ['l1'] as any }, 7, false)).toEqual({
      kind: 'faq', topic: 'hours', title: 'Saturday hours', question: 'Open Saturday?', answer: 'Yes, nine to six.', channels: ['sms', 'email'],
      locations: { scope: 'locations', locationIds: ['l1'] }, changeNote: 'Imported from Podium, import #7',
    });
    expect(knowledgeBodyForImport(payload, { scope: 'all', locationIds: [] }, 8, true)).toMatchObject({ locations: { scope: 'all' }, changeNote: 'Updated from Podium import #8' });
    expect(knowledgeBodyForImport(payload, null, undefined, false).locations).toBeUndefined();
  });

  it('adds verified contacts to the import screening list without dropping the importer’s own list', () => {
    const merged = mergeContactSets(
      { phones: new Set(['1']), emails: new Set(['a@b.com']), domains: new Set() },
      { phones: new Set(['2']), emails: new Set(), domains: new Set(['dealer.com']) },
    );
    expect(Array.from(merged.phones).sort()).toEqual(['1', '2']);
    expect(Array.from(merged.emails)).toEqual(['a@b.com']);
    expect(Array.from(merged.domains)).toEqual(['dealer.com']);
    const base = { phones: new Set(['1']), emails: new Set<string>(), domains: new Set<string>() };
    expect(mergeContactSets(base)).toBe(base);
  });

  it('keeps the preview notes out of the import fingerprint list', () => {
    expect(Array.from(KNOWLEDGE_PREVIEW_CODES).sort()).toEqual(['knowledge_contact_unverified', 'knowledge_entry_inactive', 'knowledge_new_draft', 'knowledge_revision', 'knowledge_similar_entry']);
  });

  it('recognises a registered contact in an answer by its normalized value', () => {
    const sets = { phones: new Set(['3858674411']), emails: new Set(['sales@dealer.com']), domains: new Set(['dealer.com']) };
    expect(mentionsContact('Call (385) 867-4411 today.', sets)).toBe(true);
    expect(mentionsContact('Email SALES@dealer.com any time.', sets)).toBe(true);
    expect(mentionsContact('Call 385-867-9999 instead.', sets)).toBe(false);
  });
});
