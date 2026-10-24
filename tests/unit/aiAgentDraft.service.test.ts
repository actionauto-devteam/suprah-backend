const mockOrgFindById = jest.fn();
const mockLeadFindOne = jest.fn();
const mockGenerateReply = jest.fn();
const mockGenerateEmailReply = jest.fn();
const mockClassify = jest.fn();
const mockClassifyEmail = jest.fn();
const mockSelectCoaching = jest.fn();
const mockGetCoaching = jest.fn();
const mockResolvePrice = jest.fn();
const mockRecordUsage = jest.fn();
const mockResolveRestriction = jest.fn();
const mockLoadItems = jest.fn();
const mockPinned = jest.fn();
const mockHasKey = jest.fn();
const mockAssertOpen = jest.fn();

const chain = (value: unknown) => ({ select: () => ({ lean: () => Promise.resolve(value) }) });

jest.mock('../../src/models/Organization.model', () => ({ __esModule: true, default: { findById: (...args: unknown[]) => mockOrgFindById(...args) } }));
jest.mock('../../src/models/lead.model', () => ({ __esModule: true, default: { findOne: (...args: unknown[]) => mockLeadFindOne(...args) } }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../../src/services/aiAgent.service', () => ({
  HISTORY_LIMIT: 12,
  generateAlexReply: (...args: unknown[]) => mockGenerateReply(...args),
  generateAlexEmailReply: (...args: unknown[]) => mockGenerateEmailReply(...args),
  classifyAlexReplySafety: (...args: unknown[]) => mockClassify(...args),
  classifyAlexEmailReplySafety: (...args: unknown[]) => mockClassifyEmail(...args),
  selectRelevantAiCoaching: (...args: unknown[]) => mockSelectCoaching(...args),
}));
jest.mock('../../src/services/aiAgentCoaching.service', () => ({ getRelevantAiCoaching: (...args: unknown[]) => mockGetCoaching(...args) }));
jest.mock('../../src/services/aiReplyContext.service', () => ({ resolveCurrentVehicleAndPrice: (...args: unknown[]) => mockResolvePrice(...args) }));
jest.mock('../../src/services/aiOperatingMode.service', () => ({ recordAiUsage: (...args: unknown[]) => mockRecordUsage(...args) }));
jest.mock('../../src/services/contactRestriction.service', () => ({
  ...jest.requireActual('../../src/services/contactRestriction.service'),
  resolveContactRestriction: (...args: unknown[]) => mockResolveRestriction(...args),
}));
jest.mock('../../src/services/leadConversation.service', () => ({ loadConversationItems: (...args: unknown[]) => mockLoadItems(...args) }));
jest.mock('../../src/services/vehicleInquiryContext.service', () => ({
  resolvePinnedVehicleContext: (...args: unknown[]) => mockPinned(...args),
  buildVehicleContextNote: () => undefined,
}));
jest.mock('../../src/utils/aiOutboundSafety', () => ({
  ...jest.requireActual('../../src/utils/aiOutboundSafety'),
  hasGeminiApiKey: (...args: unknown[]) => mockHasKey(...args),
}));
jest.mock('../../src/utils/closedLeadGuard', () => ({ assertLeadOpenForManualSend: (...args: unknown[]) => mockAssertOpen(...args) }));

import { ApiError } from '../../src/utils/ApiError';
import { ContactRestrictedError } from '../../src/services/contactRestriction.service';
import {
  STAFF_DRAFT_CODES,
  STAFF_DRAFT_MESSAGES,
  draftTranscriptFromItems,
  generateStaffDraft,
} from '../../src/services/aiAgentDraft.service';

const ORG = '64b000000000000000000001';
const LEAD = '64b000000000000000000002';
const USER = '64b000000000000000000003';

const smsLead = { _id: LEAD, firstName: 'Pat', phone: '+18015557001', email: 'pat@example.com', channel: 'sms', status: 'New' };

function setOrg(metadata: Record<string, unknown> = { aiAgentName: 'Anna' }) {
  mockOrgFindById.mockReturnValue(chain({ name: 'Summit Motors', metadata }));
}

function setLead(lead: unknown = smsLead) {
  mockLeadFindOne.mockReturnValue(chain(lead));
}

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    return err as ApiError;
  }
  throw new Error('Expected the draft request to fail');
}

const request = (overrides: Record<string, unknown> = {}) =>
  generateStaffDraft({ organizationId: ORG, leadId: LEAD, channel: 'sms', staff: { userId: USER, name: 'Erin' }, ...overrides } as any);

describe('staff AI draft service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setOrg();
    setLead();
    mockAssertOpen.mockResolvedValue(undefined);
    mockResolveRestriction.mockResolvedValue({ status: 'allowed' });
    mockHasKey.mockReturnValue(true);
    mockLoadItems.mockResolvedValue({ items: [], nextCursor: null, unavailableSources: [] });
    mockPinned.mockResolvedValue(null);
    mockGetCoaching.mockResolvedValue({ notes: [], ids: [], rules: [] });
    mockGenerateReply.mockResolvedValue({ text: 'Thanks Pat, I can check that for you today.' });
    mockGenerateEmailReply.mockResolvedValue({ text: 'Hi Pat, thanks for reaching out. I will confirm the details with the team and follow up today.' });
    mockClassify.mockResolvedValue('SAFE');
    mockClassifyEmail.mockResolvedValue('SAFE');
    mockResolvePrice.mockResolvedValue(null);
    mockRecordUsage.mockResolvedValue(undefined);
  });

  it('returns a draft for review and records only the usage counter', async () => {
    const result = await request();
    expect(result).toEqual({ draft: 'Thanks Pat, I can check that for you today.', channel: 'sms', agentName: 'Anna', note: null });
    expect(mockGenerateReply).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'Anna', dealerName: 'Summit Motors', channel: 'sms', isFirstReply: false, draftFor: { name: 'Erin' } }));
    expect(mockRecordUsage).toHaveBeenCalledWith(ORG, 'staff_draft');
  });

  it('uses the email generator and email safety check for the Email channel', async () => {
    setLead({ ...smsLead, channel: 'web' });
    mockResolvePrice.mockResolvedValue({ vehicle: {}, price: 23995 });
    const result = await request({ channel: 'email' });
    expect(result.channel).toBe('email');
    expect(mockGenerateEmailReply).toHaveBeenCalledWith(expect.objectContaining({ confirmedPrice: 23995, draftFor: { name: 'Erin' } }));
    expect(mockClassifyEmail).toHaveBeenCalled();
    expect(mockGenerateReply).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '   ', '123'])('refuses to draft when the AI Agent name is %p', async (aiAgentName) => {
    setOrg({ aiAgentName });
    const err = await failure(request());
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe('Set an AI Agent name in CRM Settings to enable AI features.');
    expect(err.errors[0].code).toBe('AI_AGENT_NAME_REQUIRED');
    expect(mockLeadFindOne).not.toHaveBeenCalled();
    expect(mockGenerateReply).not.toHaveBeenCalled();
  });

  it('never uses a legacy "Alex" fallback when the name is missing', async () => {
    setOrg({});
    await failure(request());
    expect(mockGenerateReply).not.toHaveBeenCalled();
  });

  it('scopes the lead lookup to the caller organization', async () => {
    setLead(null);
    const err = await failure(request());
    expect(err.statusCode).toBe(404);
    expect(mockLeadFindOne).toHaveBeenCalledWith({ _id: LEAD, organizationId: ORG });
  });

  it('rejects malformed ids and unknown channels without touching the database', async () => {
    expect((await failure(request({ leadId: 'nope' }))).statusCode).toBe(404);
    const err = await failure(request({ channel: 'fax' }));
    expect(err.statusCode).toBe(400);
    expect(err.errors[0].code).toBe(STAFF_DRAFT_CODES.wrongChannel);
    expect(mockOrgFindById).not.toHaveBeenCalled();
  });

  it('keeps Web Chat leads on Web Chat and other leads off it', async () => {
    setLead({ ...smsLead, channel: 'webchat' });
    expect((await failure(request({ channel: 'sms' }))).errors[0].code).toBe(STAFF_DRAFT_CODES.wrongChannel);
    setLead(smsLead);
    expect((await failure(request({ channel: 'webchat' }))).errors[0].code).toBe(STAFF_DRAFT_CODES.wrongChannel);
  });

  it('does not draft for a Do Not Contact customer', async () => {
    mockResolveRestriction.mockResolvedValue({ status: 'restricted', leadIds: [LEAD], onThisLead: true });
    const err = await failure(request());
    expect(err).toBeInstanceOf(ContactRestrictedError);
    expect(mockGenerateReply).not.toHaveBeenCalled();
  });

  it('does not check the SMS/Email restriction for Web Chat drafts', async () => {
    setLead({ ...smsLead, channel: 'webchat' });
    await request({ channel: 'webchat' });
    expect(mockResolveRestriction).not.toHaveBeenCalled();
  });

  it('does not draft for a closed lead', async () => {
    mockAssertOpen.mockRejectedValue(new ApiError(409, 'closed', [{ code: 'lead_closed' }]));
    const err = await failure(request());
    expect(err.errors[0].code).toBe('lead_closed');
    expect(mockGenerateReply).not.toHaveBeenCalled();
  });

  it('returns the friendly message when AI is not available on this backend', async () => {
    mockHasKey.mockReturnValue(false);
    const err = await failure(request());
    expect(err.statusCode).toBe(502);
    expect(err.message).toBe("Couldn't generate a reply right now. Please try again.");
    expect(err.errors[0].code).toBe(STAFF_DRAFT_CODES.unavailable);
  });

  it('hides provider errors behind the friendly message', async () => {
    mockGenerateReply.mockResolvedValue({ text: null, error: '503 status code (no body)' });
    const err = await failure(request());
    expect(err.message).toBe(STAFF_DRAFT_MESSAGES.failed);
    expect(err.message).not.toMatch(/503|status code/);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('turns a thrown provider error into the friendly message', async () => {
    mockGenerateReply.mockRejectedValue(new Error('AxiosError: socket hang up'));
    const err = await failure(request());
    expect(err.statusCode).toBe(502);
    expect(err.message).toBe(STAFF_DRAFT_MESSAGES.failed);
  });

  it('holds back a draft that breaks the deterministic safety rules', async () => {
    mockGenerateReply.mockResolvedValue({ text: 'It is $500 off today and still available!' });
    const err = await failure(request());
    expect(err.statusCode).toBe(422);
    expect(err.errors[0].code).toBe(STAFF_DRAFT_CODES.unsafe);
    expect(mockClassify).not.toHaveBeenCalled();
  });

  it('holds back a draft the classifier marks unsafe, and fails closed on classifier errors', async () => {
    mockClassify.mockResolvedValueOnce('UNSAFE');
    expect((await failure(request())).statusCode).toBe(422);
    mockClassify.mockResolvedValueOnce('ERROR');
    expect((await failure(request())).statusCode).toBe(502);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('gives up with the friendly message after the deadline', async () => {
    jest.useFakeTimers();
    try {
      mockGenerateReply.mockReturnValue(new Promise(() => undefined));
      const pending = failure(request());
      await jest.advanceTimersByTimeAsync(36000);
      const err = await pending;
      expect(err.statusCode).toBe(502);
      expect(err.errors[0].code).toBe(STAFF_DRAFT_CODES.timeout);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects an overlapping request for the same lead and channel, then allows the next one', async () => {
    let release: (value: unknown) => void = () => undefined;
    mockGenerateReply.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const first = request();
    await new Promise((resolve) => setImmediate(resolve));
    const err = await failure(request());
    expect(err.statusCode).toBe(409);
    expect(err.errors[0].code).toBe(STAFF_DRAFT_CODES.inProgress);
    release({ text: 'Thanks Pat, I can check that for you today.' });
    await expect(first).resolves.toMatchObject({ draft: 'Thanks Pat, I can check that for you today.' });
    await expect(request()).resolves.toMatchObject({ channel: 'sms' });
  });

  it('passes a handoff suggestion back as a staff-only note', async () => {
    mockGenerateReply.mockResolvedValue({ text: 'Let me check on that for you.', handoffReason: 'Customer wants a walkaround video' });
    const result = await request();
    expect(result.note).toBe('Anna suggests a team member follows up: Customer wants a walkaround video');
  });
});

describe('draft transcript', () => {
  const at = new Date('2026-10-24T15:00:00Z');
  const item = (fields: Record<string, unknown>) => ({ id: String(Math.random()), occurredAt: at, channel: 'sms', author: { name: 'Pat', kind: 'customer' }, ...fields }) as any;

  it('maps customer, AI, staff and inquiry turns and skips notes and calls', () => {
    const transcript = draftTranscriptFromItems([
      item({ kind: 'inquiry', body: 'Is the Tacoma available?', subject: 'Tacoma inquiry' }),
      item({ kind: 'message', direction: 'inbound', body: 'Hello?' }),
      item({ kind: 'message', direction: 'outbound', body: 'Hi Pat!', author: { name: 'Anna', kind: 'ai' } }),
      item({ kind: 'message', direction: 'outbound', body: 'This is Erin.', author: { name: 'Erin', kind: 'staff' } }),
      item({ kind: 'note', body: 'internal only', author: { name: 'Erin', kind: 'staff' } }),
      item({ kind: 'call', body: 'Missed call', author: { name: 'System', kind: 'system' } }),
    ], 'Anna');
    expect(transcript).toEqual([
      { from: 'customer', body: 'Tacoma inquiry\nIs the Tacoma available?' },
      { from: 'customer', body: 'Hello?' },
      { from: 'staff', staffName: 'Anna (AI assistant)', body: 'Hi Pat!' },
      { from: 'staff', staffName: 'Erin', body: 'This is Erin.' },
    ]);
  });

  it('keeps only the most recent turns and clips very long bodies', () => {
    const items = Array.from({ length: 20 }, (_, index) => item({ kind: 'message', direction: 'inbound', body: `m${index}` }));
    items.push(item({ kind: 'message', direction: 'inbound', body: 'x'.repeat(4000) }));
    const transcript = draftTranscriptFromItems(items, 'Anna');
    expect(transcript).toHaveLength(12);
    expect(transcript[transcript.length - 1].body.length).toBeLessThanOrEqual(1501);
  });
});
