const mockOrgLeadConfigFindOne = jest.fn();
const mockOrgLeadConfigUpdateOne = jest.fn();
const mockLeadFindOne = jest.fn();
const mockLeadFindOneAndUpdate = jest.fn();
const mockGmailList = jest.fn();
const mockGmailGet = jest.fn();
const mockGmailBatchModify = jest.fn();
const mockIntakeMode = jest.fn();
const mockProcessThroughIntake = jest.fn();

jest.mock('googleapis', () => ({
  google: {
    gmail: jest.fn().mockReturnValue({
      users: {
        messages: {
          list: (...args: any[]) => mockGmailList(...args),
          get: (...args: any[]) => mockGmailGet(...args),
          batchModify: (...args: any[]) => mockGmailBatchModify(...args),
        },
      },
    }),
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({ setCredentials: jest.fn(), once: jest.fn() })),
    },
  },
}));
jest.mock('../../src/models/OrgLeadConfig.model', () => ({
  __esModule: true,
  default: { findOne: mockOrgLeadConfigFindOne, updateOne: mockOrgLeadConfigUpdateOne },
}));
jest.mock('../../src/models/lead.model', () => ({
  __esModule: true,
  default: { findOne: mockLeadFindOne, findOneAndUpdate: mockLeadFindOneAndUpdate },
}));
jest.mock('../../src/utils/orgSystemUser', () => ({ resolveOrgSystemUserId: jest.fn().mockResolvedValue('staff-1') }));
jest.mock('../../src/utils/crypto', () => ({
  __esModule: true,
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}));
jest.mock('../../src/utils/adfParser', () => ({
  __esModule: true,
  parseEmailBody: jest.fn().mockResolvedValue({ parsedContent: 'parsed', channel: 'email', adfData: null }),
  extractADFFromBody: jest.fn(),
  parseADF: jest.fn(),
  detectChannel: jest.fn().mockReturnValue('email'),
}));
jest.mock('../../src/utils/socketEmitter', () => ({ __esModule: true, getSocketIO: jest.fn().mockReturnValue(null) }));
jest.mock('../../src/services/leadIntakeControl.service', () => ({ getLeadIntakeMode: (...args: any[]) => mockIntakeMode(...args) }));
jest.mock('../../src/services/gmailLeadIntake', () => ({ processGmailMessageThroughIntake: (...args: any[]) => mockProcessThroughIntake(...args) }));
jest.mock('../../src/services/communication.service', () => ({ triggerAiReplyForNewInquiry: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/services/aiEmailReply.service', () => ({ triggerAiEmailReplyForNewInquiry: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../src/services/leadLocation.service', () => ({ resolveVehicleContextForLead: jest.fn().mockResolvedValue(null) }));

import orgGmailService, { forgetCheckedMessages, wasMessageCheckedRecently } from '../../src/services/orgGmail.service';

const textPayload = (body: string) => ({ headers: [], parts: [{ mimeType: 'text/plain', body: { data: Buffer.from(body).toString('base64') } }] });
const leadLookup = (value: unknown) => ({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(value) }) });
const fetchedIds = () => mockGmailGet.mock.calls.map(([args]) => args.id);

describe('orgGmail.service syncLeadsForOrg — every-minute sync does not re-read the same unread email every run', () => {
  const start = Date.parse('2026-10-28T13:00:00Z');
  let now = start;

  beforeEach(() => {
    jest.clearAllMocks();
    forgetCheckedMessages();
    now = start;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    mockOrgLeadConfigFindOne.mockResolvedValue({ gmailConnected: true, accessToken: 'enc:at', refreshToken: 'enc:rt', expiryDate: start + 3600000, leadSourceEmail: '' });
    mockOrgLeadConfigUpdateOne.mockResolvedValue({});
    mockGmailBatchModify.mockResolvedValue({});
    mockIntakeMode.mockResolvedValue('off');
  });

  afterEach(() => jest.restoreAllMocks());

  it('skips a reply in an already-imported thread on the next runs, then checks it again after 10 minutes', async () => {
    mockGmailList.mockResolvedValue({ data: { messages: [{ id: 'reply-1' }] } });
    mockGmailGet.mockResolvedValue({ data: { id: 'reply-1', threadId: 'thread-1', payload: textPayload('thanks!') } });
    mockLeadFindOne.mockReturnValue(leadLookup({ _id: 'lead-existing' }));

    await orgGmailService.syncLeadsForOrg('org-1');
    expect(fetchedIds()).toEqual(['reply-1']);
    expect(wasMessageCheckedRecently('org-1', 'reply-1')).toBe(true);
    expect(wasMessageCheckedRecently('org-2', 'reply-1')).toBe(false);

    now = start + 60_000;
    await orgGmailService.syncLeadsForOrg('org-1');
    now = start + 9 * 60_000;
    await orgGmailService.syncLeadsForOrg('org-1');
    expect(fetchedIds()).toEqual(['reply-1']);

    now = start + 10 * 60_000 + 1;
    await orgGmailService.syncLeadsForOrg('org-1');
    expect(fetchedIds()).toEqual(['reply-1', 'reply-1']);
    expect(mockLeadFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('still reads and imports a brand-new email on the very next minute', async () => {
    mockGmailList.mockResolvedValueOnce({ data: { messages: [{ id: 'reply-1' }] } });
    mockGmailGet.mockResolvedValueOnce({ data: { id: 'reply-1', threadId: 'thread-1', payload: textPayload('thanks!') } });
    mockLeadFindOne.mockReturnValueOnce(leadLookup({ _id: 'lead-existing' }));
    await orgGmailService.syncLeadsForOrg('org-1');

    now = start + 60_000;
    mockGmailList.mockResolvedValueOnce({ data: { messages: [{ id: 'reply-1' }, { id: 'new-lead-1' }] } });
    mockGmailGet.mockResolvedValueOnce({ data: { id: 'new-lead-1', threadId: 'thread-2', internalDate: String(now), payload: textPayload('Is the truck available?') } });
    mockLeadFindOne.mockReturnValueOnce(leadLookup(null));
    mockLeadFindOneAndUpdate.mockResolvedValueOnce({ lastErrorObject: { updatedExisting: false }, value: { _id: 'lead-new', messageId: 'new-lead-1' } });

    const result = await orgGmailService.syncLeadsForOrg('org-1');

    expect(result.synced).toBe(1);
    expect(fetchedIds()).toEqual(['reply-1', 'new-lead-1']);
    expect(mockGmailBatchModify).toHaveBeenCalledTimes(1);
    expect(wasMessageCheckedRecently('org-1', 'new-lead-1')).toBe(false);
  });

  it('a message whose processing failed is retried after 10 minutes instead of every minute', async () => {
    mockGmailList.mockResolvedValue({ data: { messages: [{ id: 'broken-1' }] } });
    mockGmailGet.mockResolvedValue({ data: { id: 'broken-1', threadId: 'thread-9', payload: textPayload('hello') } });
    mockLeadFindOne.mockReturnValue(leadLookup(null));
    mockLeadFindOneAndUpdate.mockRejectedValue(new Error('database busy'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await orgGmailService.syncLeadsForOrg('org-1');
    now = start + 5 * 60_000;
    await orgGmailService.syncLeadsForOrg('org-1');
    expect(mockLeadFindOneAndUpdate).toHaveBeenCalledTimes(1);

    now = start + 11 * 60_000;
    await orgGmailService.syncLeadsForOrg('org-1');
    expect(mockLeadFindOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it('with lead intake on: a non-lead email is not re-read every minute, and a new lead email is imported and marked read', async () => {
    mockIntakeMode.mockResolvedValue('active');
    mockGmailList.mockResolvedValue({ data: { messages: [{ id: 'newsletter-1' }, { id: 'lead-email-1' }] } });
    mockGmailGet.mockImplementation(async ({ id }: { id: string }) => ({ data: { id, threadId: `t-${id}`, internalDate: String(now), payload: textPayload(`body ${id}`) } }));
    mockProcessThroughIntake.mockImplementation(async ({ message }: { message: { id: string } }) => (
      message.id === 'newsletter-1' ? { status: 'skipped', reason: 'not_a_lead_email' } : { status: 'associated', created: true }
    ));

    const first = await orgGmailService.syncLeadsForOrg('org-1');
    expect(first.synced).toBe(1);
    expect(mockGmailBatchModify).toHaveBeenCalledTimes(1);
    expect(mockGmailBatchModify.mock.calls[0][0].requestBody.ids).toEqual(['lead-email-1']);

    now = start + 60_000;
    mockGmailList.mockResolvedValue({ data: { messages: [{ id: 'newsletter-1' }] } });
    await orgGmailService.syncLeadsForOrg('org-1');
    expect(fetchedIds()).toEqual(['newsletter-1', 'lead-email-1']);

    now = start + 10 * 60_000 + 1;
    await orgGmailService.syncLeadsForOrg('org-1');
    expect(fetchedIds()).toEqual(['newsletter-1', 'lead-email-1', 'newsletter-1']);
  });
});
