const mockOrgLeadConfigFindOne = jest.fn();
const mockOrgLeadConfigUpdateOne = jest.fn();
const mockLeadFindOne = jest.fn();
const mockLeadFindOneAndUpdate = jest.fn();
const mockUserFindOne = jest.fn();
const mockGmailList = jest.fn();
const mockGmailGet = jest.fn();
const mockGmailBatchModify = jest.fn();

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
      OAuth2: jest.fn().mockImplementation(() => ({
        setCredentials: jest.fn(),
        once: jest.fn(),
      })),
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
jest.mock('../../src/models/User.model', () => ({
  __esModule: true,
  default: { findOne: mockUserFindOne },
}));
jest.mock('../../src/utils/orgSystemUser', () => ({ resolveOrgSystemUserId: jest.fn().mockResolvedValue('staff-1') }));
jest.mock('../../src/utils/crypto', () => ({
  __esModule: true,
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}));
jest.mock('../../src/utils/adfParser', () => ({
  __esModule: true,
  parseEmailBody: jest.fn().mockResolvedValue({
    parsedContent: 'parsed body',
    channel: 'email',
    adfData: { firstName: 'Jordan', lastName: 'Lee', email: 'jordan@example.com', phone: '8015550100', vehicle: {}, comments: '', source: '' },
  }),
  extractADFFromBody: jest.fn(),
  parseADF: jest.fn(),
  detectChannel: jest.fn().mockReturnValue('email'),
}));
jest.mock('../../src/utils/socketEmitter', () => ({
  __esModule: true,
  getSocketIO: jest.fn().mockReturnValue(null),
}));

import orgGmailService from '../../src/services/orgGmail.service';
import { parseEmailBody } from '../../src/utils/adfParser';
import { resolveOrgSystemUserId } from '../../src/utils/orgSystemUser';

function textPart(body: string) {
  return { parts: [{ mimeType: 'text/plain', body: { data: Buffer.from(body).toString('base64') } }] };
}

describe('orgGmail.service syncLeadsForOrg — atomic messageId dedup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOrgLeadConfigFindOne.mockResolvedValue({
      gmailConnected: true,
      accessToken: 'enc:at',
      refreshToken: 'enc:rt',
      expiryDate: Date.now() + 3600000,
      gmailAddress: 'dealer@gmail.com',
      leadSourceEmail: '',
    });
    mockOrgLeadConfigUpdateOne.mockResolvedValue({});
    mockUserFindOne.mockResolvedValue({ _id: 'staff-1' });
    mockGmailBatchModify.mockResolvedValue({});
  });

  it('imports a brand-new message via an atomic upsert and marks it read', async () => {
    mockGmailList.mockResolvedValue({ data: { messages: [{ id: 'msg-1' }] } });
    mockGmailGet.mockResolvedValue({
      data: { id: 'msg-1', threadId: 'thread-1', internalDate: '1700000000000', payload: { headers: [], ...textPart('hello') } },
    });
    mockLeadFindOne.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }) });
    mockLeadFindOneAndUpdate.mockResolvedValue({
      lastErrorObject: { updatedExisting: false },
      value: { _id: 'lead-1', messageId: 'msg-1' },
    });

    const result = await orgGmailService.syncLeadsForOrg('org-1');

    expect(result.synced).toBe(1);
    expect(mockLeadFindOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update] = mockLeadFindOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ organizationId: 'org-1', messageId: 'msg-1' });
    expect(update.$setOnInsert.senderEmail).toBe('');
    expect(update.$setOnInsert.sourceSubmittedAt).toBeInstanceOf(Date);
    expect(mockGmailBatchModify).toHaveBeenCalledTimes(1);
  });

  it('skips a message whose thread was already imported, without attempting the upsert', async () => {
    mockGmailList.mockResolvedValue({ data: { messages: [{ id: 'msg-2' }] } });
    mockGmailGet.mockResolvedValue({
      data: { id: 'msg-2', threadId: 'thread-already-seen', payload: { headers: [], ...textPart('hello again') } },
    });
    mockLeadFindOne.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ _id: 'existing-lead' }) }) });

    const result = await orgGmailService.syncLeadsForOrg('org-1');

    expect(result.synced).toBe(0);
    expect(mockLeadFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockGmailBatchModify).not.toHaveBeenCalled();
  });

  it('never double-imports the same message when two sync runs race on it (only one upsert wins)', async () => {
    mockGmailList.mockResolvedValue({ data: { messages: [{ id: 'msg-race' }] } });
    mockGmailGet.mockResolvedValue({
      data: { id: 'msg-race', threadId: 'thread-race', payload: { headers: [], ...textPart('race body') } },
    });
    mockLeadFindOne.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }) });

    let winnerClaimed = false;
    mockLeadFindOneAndUpdate.mockImplementation(async () => {
      if (!winnerClaimed) {
        winnerClaimed = true;
        return { lastErrorObject: { updatedExisting: false }, value: { _id: 'lead-race', messageId: 'msg-race' } };
      }
      return { lastErrorObject: { updatedExisting: true }, value: { _id: 'lead-race', messageId: 'msg-race' } };
    });

    const [first, second] = await Promise.all([
      orgGmailService.syncLeadsForOrg('org-1'),
      orgGmailService.syncLeadsForOrg('org-1'),
    ]);

    expect(first.synced + second.synced).toBe(1);
    expect(mockGmailBatchModify).toHaveBeenCalledTimes(1);
  });

  it('retries messages.list once on a 429 before giving up', async () => {
    const rateLimitError: any = new Error('rate limited');
    rateLimitError.code = 429;
    mockGmailList
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({ data: { messages: [] } });

    const result = await orgGmailService.syncLeadsForOrg('org-1');

    expect(mockGmailList).toHaveBeenCalledTimes(2);
    expect(result.synced).toBe(0);
  }, 10000);
  it('plain email uses the normalized sender and a scoped intake user', async () => {
    (parseEmailBody as jest.Mock).mockResolvedValueOnce({ parsedContent: 'Email only', channel: 'email', adfData: null });
    mockGmailList.mockResolvedValue({ data: { messages: [{ id: 'email-only' }] } });
    mockGmailGet.mockResolvedValue({ data: { id: 'email-only', payload: { headers: [{ name: 'From', value: 'Customer <PERSON@Example.com>' }], ...textPart('Email only') } } });
    mockLeadFindOneAndUpdate.mockResolvedValue({ lastErrorObject: { updatedExisting: false }, value: { _id: 'email-lead' } });
    expect((await orgGmailService.syncLeadsForOrg('org-1')).synced).toBe(1);
    expect(resolveOrgSystemUserId).toHaveBeenCalledWith('org-1');
    expect(mockLeadFindOneAndUpdate.mock.calls[0][1].$setOnInsert).toMatchObject({ email: 'person@example.com', createdBy: 'staff-1' });
  });
  it('ADF without customer email does not substitute the vendor sender', async () => {
    (parseEmailBody as jest.Mock).mockResolvedValueOnce({ parsedContent: 'Phone only', channel: 'adf', adfData: { firstName: 'Customer', phone: '8015550123', vehicle: {} } });
    mockGmailList.mockResolvedValue({ data: { messages: [{ id: 'adf-phone-only' }] } });
    mockGmailGet.mockResolvedValue({ data: { id: 'adf-phone-only', payload: { headers: [{ name: 'From', value: 'vendor@example.com' }], ...textPart('Phone only') } } });
    mockLeadFindOneAndUpdate.mockResolvedValue({ lastErrorObject: { updatedExisting: false }, value: { _id: 'adf-lead' } });
    await orgGmailService.syncLeadsForOrg('org-1');
    expect(mockLeadFindOneAndUpdate.mock.calls[0][1].$setOnInsert).toMatchObject({ email: '', phone: '8015550123' });
  });
});

describe('orgGmail.service syncLeadsForOrg — LOCAL_UI_ACCEPTANCE_MODE guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
  });

  afterAll(() => {
    delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
  });

  it('returns a safe no-op result and never reads OrgLeadConfig or calls Gmail when the flag is set', async () => {
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
    const result = await orgGmailService.syncLeadsForOrg('org-1');
    expect(result).toEqual({ total: 0, synced: 0 });
    expect(mockOrgLeadConfigFindOne).not.toHaveBeenCalled();
    expect(mockGmailList).not.toHaveBeenCalled();
    expect(mockGmailGet).not.toHaveBeenCalled();
  });

  it('behaves exactly as before when the flag is absent', async () => {
    mockOrgLeadConfigFindOne.mockResolvedValue({
      gmailConnected: true,
      accessToken: 'enc:at',
      refreshToken: 'enc:rt',
      expiryDate: Date.now() + 3600000,
      gmailAddress: 'dealer@gmail.com',
      leadSourceEmail: '',
    });
    mockUserFindOne.mockResolvedValue({ _id: 'staff-1' });
    mockGmailBatchModify.mockResolvedValue({});
    mockGmailList.mockResolvedValue({ data: { messages: [] } });
    const result = await orgGmailService.syncLeadsForOrg('org-1');
    expect(mockOrgLeadConfigFindOne).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ total: 0, synced: 0 });
  });
});
