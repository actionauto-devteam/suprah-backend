import mongoose from 'mongoose';
import {
  resolveVehicleInquiry,
  resolveVehicleContextForReply,
  matchVehicleMention,
  groupDistinctVehicles,
  buildClarifyingQuestion,
  buildVehicleContextNote,
  lastAiMessageWasClarifyingQuestion,
  classifyInquiryScope,
  formatVehicleLabel,
  loadPhoneLeads,
  CLARIFYING_QUESTION_MARKER,
  InquiryTranscriptEntry,
} from '../../src/services/vehicleInquiryContext.service';
import { validateOutboundMessage } from '../../src/utils/aiOutboundSafety';

function lead(id: string, vehicle: any, updatedAt = '2026-10-14T18:00:00Z', extra: any = {}) {
  return { _id: id, firstName: 'Test', lastName: 'Martinez', phone: '385-336-5062', vehicle, updatedAt, createdAt: updatedAt, ...extra };
}

const jeep = lead('lead-jeep', { year: '2022', make: 'JEEP', model: 'GRAND CHEROKEE 4XE' }, '2026-10-14T18:09:00Z');
const civic = lead('lead-civic', { year: '2022', make: 'Honda', model: 'Civic Sport' }, '2026-10-14T18:00:00Z');
const audi = lead('lead-audi', { year: '2025', make: 'Audi', model: 'A5' }, '2026-10-14T16:42:00Z');
const rogue = lead('lead-rogue', { year: '2021', make: 'Nissan', model: 'Rogue Sport S' }, '2026-10-14T16:43:00Z');

const customer = (body: string): InquiryTranscriptEntry => ({ from: 'customer', body });
const ai = (body: string): InquiryTranscriptEntry => ({ from: 'ai', body });

describe('formatVehicleLabel', () => {
  it('title-cases all-caps feed values but keeps model codes intact', () => {
    expect(formatVehicleLabel(jeep.vehicle)).toBe('2022 Jeep Grand Cherokee 4XE');
  });

  it('leaves already mixed-case labels alone', () => {
    expect(formatVehicleLabel(civic.vehicle)).toBe('2022 Honda Civic Sport');
  });

  it('returns an empty label when the lead has no vehicle', () => {
    expect(formatVehicleLabel(undefined)).toBe('');
    expect(formatVehicleLabel({})).toBe('');
  });
});

describe('resolveVehicleInquiry — scenario A: same customer, same phone, multiple vehicle inquiries', () => {
  it('keeps a brand-new inquiry pinned to its own lead, even when the transcript mentions other vehicles', () => {
    const result = resolveVehicleInquiry({
      leads: [jeep, civic, audi, rogue],
      triggerLead: jeep,
      isNewInquiry: true,
      transcript: [
        customer('I am interested in a 2021 Nissan Rogue Sport S'),
        ai("Hi Test, I'd love to help you check on that 2025 Audi A5"),
        customer('Test Email Orem - AAU 10.14'),
      ],
    });
    expect(result.resolution).toBe('new_inquiry');
    expect(String(result.lead._id)).toBe('lead-jeep');
    expect(result.multipleInquiries).toBe(true);
  });

  it('tells the model which vehicle the reply is about and to ignore the others', () => {
    const result = resolveVehicleInquiry({ leads: [jeep, civic, audi], triggerLead: jeep, isNewInquiry: true, transcript: [] });
    const note = buildVehicleContextNote(result)!;
    expect(note).toContain('This message is about the 2022 Jeep Grand Cherokee 4XE only');
    expect(note).toContain('2022 Honda Civic Sport');
    expect(note).toContain('2025 Audi A5');
    expect(note).toMatch(/do not mention, confuse, or mix in/i);
  });

  it('leaves behavior unchanged (no context note) when the phone has only one vehicle inquiry', () => {
    const result = resolveVehicleInquiry({ leads: [jeep], triggerLead: jeep, transcript: [customer('is it still there?')] });
    expect(result.resolution).toBe('single');
    expect(String(result.lead._id)).toBe('lead-jeep');
    expect(result.multipleInquiries).toBe(false);
    expect(buildVehicleContextNote(result)).toBeUndefined();
  });

  it('treats two leads for the same vehicle (e.g. CarGurus + DealersCloud duplicates) as one inquiry, not an ambiguity', () => {
    const dup = lead('lead-jeep-dup', { year: '2022', make: 'Jeep', model: 'Grand Cherokee 4xe' }, '2026-10-14T18:10:00Z');
    const result = resolveVehicleInquiry({ leads: [jeep, dup], triggerLead: jeep, transcript: [customer('still available?')] });
    expect(result.resolution).toBe('single');
    expect(String(result.lead._id)).toBe('lead-jeep');
  });

  it('ignores sibling leads that have no vehicle on file', () => {
    const smsOnly = lead('lead-sms', undefined);
    const result = resolveVehicleInquiry({ leads: [jeep, smsOnly], triggerLead: smsOnly, transcript: [customer('hi')] });
    expect(result.resolution).toBe('single');
    expect(String(result.lead._id)).toBe('lead-sms');
  });
});

describe('resolveVehicleInquiry — scenario B: customer explicitly mentions a different vehicle than the opened lead', () => {
  it('routes the reply to the lead for the vehicle the customer named', () => {
    const result = resolveVehicleInquiry({
      leads: [jeep, civic],
      triggerLead: jeep,
      transcript: [customer('Actually is the Honda Civic still around?')],
    });
    expect(result.resolution).toBe('explicit_mention');
    expect(String(result.lead._id)).toBe('lead-civic');
  });

  it('matches short alphanumeric model names like A5', () => {
    const result = resolveVehicleInquiry({ leads: [jeep, audi], triggerLead: jeep, transcript: [customer('what about the A5?')] });
    expect(result.resolution).toBe('explicit_mention');
    expect(String(result.lead._id)).toBe('lead-audi');
  });

  it('prefers the more specific model match (Grand Cherokee over Cherokee)', () => {
    const cherokee = lead('lead-cherokee', { year: '2020', make: 'Jeep', model: 'Cherokee' });
    const result = resolveVehicleInquiry({ leads: [jeep, cherokee], triggerLead: cherokee, transcript: [customer('the grand cherokee please')] });
    expect(String(result.lead._id)).toBe('lead-jeep');
  });
});

describe('resolveVehicleInquiry — scenario C: ambiguous message with multiple active inquiries', () => {
  it('does not guess from the currently opened lead when the message names no vehicle', () => {
    const result = resolveVehicleInquiry({
      leads: [jeep, civic],
      triggerLead: jeep,
      transcript: [customer('Is it still available?')],
    });
    expect(result.resolution).toBe('ambiguous');
    expect(result.lead).toBeNull();
    expect(result.ambiguousCandidates.map((c) => c.leadId).sort()).toEqual(['lead-civic', 'lead-jeep']);
  });

  it('is ambiguous when the customer names only a make shared by two inquiries', () => {
    const accord = lead('lead-accord', { year: '2023', make: 'Honda', model: 'Accord' });
    const result = resolveVehicleInquiry({ leads: [civic, accord], triggerLead: civic, transcript: [customer('is the Honda ready?')] });
    expect(result.resolution).toBe('ambiguous');
    expect(result.ambiguousCandidates.map((c) => c.leadId).sort()).toEqual(['lead-accord', 'lead-civic']);
  });

  it('never resolves on a year-only match', () => {
    const result = resolveVehicleInquiry({ leads: [jeep, civic], triggerLead: jeep, transcript: [customer('is the 2022 ready?')] });
    expect(result.resolution).toBe('ambiguous');
  });

  it('uses recent conversation context when the vehicle was clearly established a turn earlier', () => {
    const result = resolveVehicleInquiry({
      leads: [jeep, civic],
      triggerLead: jeep,
      transcript: [
        customer('I want to test drive the Civic'),
        ai('Thanks for reaching out about that Honda Civic, Test!'),
        customer('Does Friday work?'),
      ],
    });
    expect(result.resolution).toBe('recent_context');
    expect(String(result.lead._id)).toBe('lead-civic');
  });

  it('stays ambiguous when the recent context itself mixes vehicles', () => {
    const result = resolveVehicleInquiry({
      leads: [jeep, civic],
      triggerLead: jeep,
      transcript: [ai('Are you asking about the Jeep or the Civic?'), customer('the first one lol')],
    });
    expect(result.resolution).toBe('ambiguous');
  });

  it('only looks back a few turns for context, not the whole history', () => {
    const result = resolveVehicleInquiry({
      leads: [jeep, civic],
      triggerLead: jeep,
      transcript: [
        customer('I like the Civic'),
        ai('ok'),
        customer('hmm'),
        ai('sure'),
        customer('ok'),
        ai('thanks'),
        customer('is it still there?'),
      ],
    });
    expect(result.resolution).toBe('ambiguous');
  });
});

describe('buildClarifyingQuestion', () => {
  const candidates = groupDistinctVehicles([jeep, civic, audi, rogue]);

  it('names the open vehicles, stays within SMS length, and passes outbound safety validation', () => {
    const text = buildClarifyingQuestion({ candidates, customerFirstName: 'Test', agentName: 'Anna', dealerName: 'Action Auto Utah' })!;
    expect(text).toContain(CLARIFYING_QUESTION_MARKER);
    expect(text).toContain('2022 Jeep Grand Cherokee 4XE');
    expect(text).toContain('another vehicle');
    expect(text.length).toBeLessThanOrEqual(300);
    expect(validateOutboundMessage(text).ok).toBe(true);
  });

  it('introduces the assistant on a first reply', () => {
    const text = buildClarifyingQuestion({ candidates: candidates.slice(0, 2), customerFirstName: 'Test', agentName: 'Anna', dealerName: 'Action Auto Utah', isFirstReply: true })!;
    expect(text.startsWith('Hi Test, this is Anna with Action Auto Utah!')).toBe(true);
  });

  it('returns null when there are fewer than two named vehicles to choose between', () => {
    expect(buildClarifyingQuestion({ candidates: candidates.slice(0, 1), agentName: 'Anna', dealerName: 'Action Auto Utah' })).toBeNull();
  });

  it('is detected as the previous AI turn so it is never asked twice in a row', () => {
    const text = buildClarifyingQuestion({ candidates, agentName: 'Anna', dealerName: 'Action Auto Utah' })!;
    expect(lastAiMessageWasClarifyingQuestion([ai(text), customer('yes')])).toBe(true);
    expect(lastAiMessageWasClarifyingQuestion([ai(text), { from: 'staff', body: 'I got this' }, customer('yes')])).toBe(false);
    expect(lastAiMessageWasClarifyingQuestion([ai('Sounds good!'), customer('yes')])).toBe(false);
  });
});

describe('matchVehicleMention', () => {
  it('handles hyphenated model names both ways', () => {
    const crv = lead('lead-crv', { year: '2025', make: 'Honda', model: 'CR-V Hybrid' });
    const candidates = groupDistinctVehicles([crv, jeep]);
    expect(matchVehicleMention('is the CR-V ready', candidates).map((c) => c.leadId)).toEqual(['lead-crv']);
    expect(matchVehicleMention('is the crv ready', candidates).map((c) => c.leadId)).toEqual(['lead-crv']);
  });
});

describe('classifyInquiryScope — timeline distinguishes shared vs inquiry-specific activity', () => {
  it('returns null (no change) when the customer has no other inquiries', () => {
    expect(classifyInquiryScope({ leadId: 'lead-jeep', body: 'hi' }, jeep, [])).toBeNull();
    expect(classifyInquiryScope({ leadId: 'lead-jeep', body: 'hi' }, jeep, [jeep])).toBeNull();
  });

  it('marks messages tagged to another lead as shared, with that inquiry\'s vehicle', () => {
    expect(classifyInquiryScope({ leadId: 'lead-civic', body: 'ok' }, jeep, [civic])).toEqual({
      inquiryScope: 'shared',
      relatedLeadId: 'lead-civic',
      relatedVehicleLabel: '2022 Honda Civic Sport',
    });
  });

  it('marks a message that clearly names a sibling vehicle as shared even if it was tagged to this lead', () => {
    const scope = classifyInquiryScope({ leadId: 'lead-jeep', body: "I'm interested in your 2022 Honda Civic Sport" }, jeep, [civic]);
    expect(scope).toEqual(expect.objectContaining({ inquiryScope: 'shared', relatedLeadId: 'lead-civic' }));
  });

  it('keeps messages about this lead\'s own vehicle as inquiry-specific', () => {
    expect(classifyInquiryScope({ leadId: 'lead-jeep', body: 'Is the Grand Cherokee still there?' }, jeep, [civic])).toEqual({
      inquiryScope: 'this_inquiry',
    });
  });
});

describe('loadPhoneLeads / resolveVehicleContextForReply — data access', () => {
  afterEach(() => jest.restoreAllMocks());

  function mockLeadModel(docs: any[]) {
    const chain: any = {
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      maxTimeMS: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(docs),
    };
    const find = jest.fn().mockReturnValue(chain);
    jest.spyOn(mongoose, 'model').mockReturnValue({ find } as any);
    return find;
  }

  it('scopes the lookup to the organization and only returns leads whose phone actually matches', async () => {
    const other = lead('lead-other', { make: 'Ford', model: 'F-150' }, undefined, { phone: '801-555-0000' });
    const find = mockLeadModel([jeep, civic, other]);

    const leads = await loadPhoneLeads('org-1', '+13853365062', { activeOnly: true });

    expect(leads.map((l) => l._id)).toEqual(['lead-jeep', 'lead-civic']);
    const filter = find.mock.calls[0][0];
    expect(filter.organizationId).toBe('org-1');
    expect(filter.status.$in).toEqual(expect.arrayContaining(['New', 'Contacted']));
    expect(filter.status.$in).not.toContain('Sold');
  });

  it('falls back to the triggering lead (today\'s behavior) if the sibling lookup fails', async () => {
    jest.spyOn(mongoose, 'model').mockImplementation(() => {
      throw new Error('boom');
    });
    const result = await resolveVehicleContextForReply({
      organizationId: 'org-1',
      phone: '+13853365062',
      triggerLead: jeep,
      transcript: [customer('is it still there?')],
    });
    expect(result.resolution).toBe('single');
    expect(String(result.lead._id)).toBe('lead-jeep');
  });

  it('end to end: an ambiguous reply on a shared phone is flagged instead of guessing the opened lead', async () => {
    mockLeadModel([jeep, civic]);
    const result = await resolveVehicleContextForReply({
      organizationId: 'org-1',
      phone: '+13853365062',
      triggerLead: jeep,
      transcript: [customer('is it still available?')],
    });
    expect(result.resolution).toBe('ambiguous');
  });
});
