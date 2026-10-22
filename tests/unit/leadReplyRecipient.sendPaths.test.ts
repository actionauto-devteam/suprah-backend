const gmailSendMock = jest.fn().mockResolvedValue({ data: { id: 'sent-msg-1', threadId: 'thread-1' } });
const oauth2Constructor = jest.fn().mockImplementation(() => ({ setCredentials: jest.fn(), on: jest.fn() }));
const mockLeadFindOne = jest.fn();
const mockLeadFind = jest.fn();

jest.mock('googleapis', () => ({
  google: {
    gmail: jest.fn().mockReturnValue({
      users: {
        messages: { send: gmailSendMock },
        threads: { get: jest.fn().mockResolvedValue({ data: { messages: [] } }) },
      },
    }),
    auth: { OAuth2: oauth2Constructor },
  },
}));

jest.mock('../../src/services/appointment.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/googleCalendar.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/lead.model', () => ({
  __esModule: true,
  default: { findOne: mockLeadFindOne, find: mockLeadFind, findById: jest.fn(), updateOne: jest.fn().mockResolvedValue({}) },
}));
jest.mock('../../src/models/Appointment.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: { findById: jest.fn().mockResolvedValue({ email: 'rep@example.com' }) } }));
jest.mock('../../src/services/activity.service', () => ({ __esModule: true, default: { createActivity: jest.fn() } }));
jest.mock('../../src/utils/safeNotification', () => ({ safeCreateNotification: jest.fn(), notifyOrgAdmins: jest.fn(), safeBroadcastNotification: jest.fn() }));
jest.mock('../../src/utils/notificationTemplates', () => ({ notificationTemplates: {} }));
jest.mock('../../src/utils/adfParser', () => ({ parseADF: jest.fn(), parseEmailBody: jest.fn(), isADFContent: jest.fn(), extractADFFromBody: jest.fn(), detectChannel: jest.fn() }));
jest.mock('../../src/utils/socketEmitter', () => ({ getSocketIO: jest.fn().mockReturnValue(null), emitToUser: jest.fn() }));
const orgLeadConfigDoc = {
  gmailConnected: true,
  refreshToken: 'enc:rt',
  accessToken: 'enc:at',
  expiryDate: Date.now() + 3600000,
  gmailAddress: 'dealer@example.com',
  leadSourceEmail: 'inbound-leads@example.com',
};
jest.mock('../../src/models/OrgLeadConfig.model', () => ({
  __esModule: true,
  default: {
    findOne: jest.fn().mockImplementation(() => ({
      lean: jest.fn().mockResolvedValue(orgLeadConfigDoc),
      then: (resolve: any) => resolve(orgLeadConfigDoc),
    })),
  },
}));
jest.mock('../../src/utils/crypto', () => ({ decrypt: (v: string) => String(v).replace(/^enc:/, ''), encrypt: (v: string) => `enc:${v}` }));
jest.mock('../../src/services/cache.service', () => ({ cacheService: { get: jest.fn().mockResolvedValue(null), set: jest.fn(), del: jest.fn() } }));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/utils/leadNote', () => ({ addLeadNoteAndNotify: jest.fn() }));
jest.mock('../../src/services/leadLocation.service', () => ({ resolveVehicleContextForLead: jest.fn(), UNMAPPED_LEAD_LOCATION_LABEL: 'Unknown Location' }));

import { sendLeadReplyEmail, replyToInquiry, bulkReplyToInquiries } from '../../src/controllers/lead.controller';
import { LeadReplyRecipientError } from '../../src/utils/leadReplyRecipient';

function sentToHeader(callIndex = 0): string {
  const raw = gmailSendMock.mock.calls[callIndex][0].requestBody.raw as string;
  const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return decoded.split('\r\n').find((line) => line.startsWith('To: '))?.slice(4) || '';
}

function makeLead(overrides: Record<string, unknown> = {}) {
  return {
    _id: 'lead-1',
    firstName: 'Jordan',
    subject: 'Inquiry',
    status: 'New',
    threadId: 'thread-1',
    followUp: {},
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function mockResponse() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

const adfLeadWithCustomer = { email: 'customer@example.com', senderEmail: 'leads@dealerscloud.com', channel: 'adf', centralIngestion: true };
const adfLeadWithoutCustomer = { email: '', senderEmail: 'leads@dealerscloud.com', channel: 'adf', centralIngestion: true };

describe('manual email replies use a verified customer recipient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
  });

  it('sends a manual reply for an ADF lead to the customer email, not the lead-source senderEmail', async () => {
    await sendLeadReplyEmail(makeLead(adfLeadWithCustomer), 'Hello', 'user-1', 'org-1', [], undefined, { requireVerifiedRecipient: true });
    expect(gmailSendMock).toHaveBeenCalledTimes(1);
    expect(sentToHeader()).toBe('customer@example.com');
  });

  it('refuses a manual reply when the lead has no customer email, before any Gmail client is created', async () => {
    await expect(
      sendLeadReplyEmail(makeLead(adfLeadWithoutCustomer), 'Hello', 'user-1', 'org-1', [], undefined, { requireVerifiedRecipient: true }),
    ).rejects.toBeInstanceOf(LeadReplyRecipientError);
    expect(oauth2Constructor).not.toHaveBeenCalled();
    expect(gmailSendMock).not.toHaveBeenCalled();
  });

  it('refuses a manual reply when the saved email is the organization lead-source inbox', async () => {
    await expect(
      sendLeadReplyEmail(makeLead({ email: 'inbound-leads@example.com', channel: 'email' }), 'Hello', 'user-1', 'org-1', [], undefined, { requireVerifiedRecipient: true }),
    ).rejects.toBeInstanceOf(LeadReplyRecipientError);
    expect(gmailSendMock).not.toHaveBeenCalled();
  });

  it('keeps the previous recipient order when the option is not passed (the Alex email path is unchanged)', async () => {
    await sendLeadReplyEmail(makeLead(adfLeadWithCustomer), 'Hello', 'ai-agent', 'org-1', [], 'dealer@example.com');
    expect(sentToHeader()).toBe('leads@dealerscloud.com');
  });

  it('replyToInquiry answers 400 NO_CUSTOMER_EMAIL and leaves the lead untouched when there is no customer email', async () => {
    const lead = makeLead(adfLeadWithoutCustomer);
    mockLeadFindOne.mockResolvedValue(lead);
    const res = mockResponse();
    await replyToInquiry({ params: { id: 'lead-1' }, body: { message: 'Hi' }, files: [], user: { _id: 'user-1' }, orgId: 'org-1' } as any, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'NO_CUSTOMER_EMAIL' }));
    expect(gmailSendMock).not.toHaveBeenCalled();
    expect(lead.save).not.toHaveBeenCalled();
    expect(lead.status).toBe('New');
  });

  it('replyToInquiry sends to the customer email for an ADF lead', async () => {
    const lead = makeLead(adfLeadWithCustomer);
    mockLeadFindOne.mockResolvedValue(lead);
    const res = mockResponse();
    await replyToInquiry({ params: { id: 'lead-1' }, body: { message: 'Hi' }, files: [], user: { _id: 'user-1' }, orgId: 'org-1', ip: '127.0.0.1' } as any, res);
    expect(sentToHeader()).toBe('customer@example.com');
    expect(lead.save).toHaveBeenCalled();
  });

  it('bulk reply skips leads without a customer email, reports them, and does not change their status', async () => {
    const good = makeLead({ _id: 'lead-good', ...adfLeadWithCustomer });
    const missing = makeLead({ _id: 'lead-missing', ...adfLeadWithoutCustomer });
    mockLeadFind.mockResolvedValue([good, missing]);
    const res = mockResponse();
    await bulkReplyToInquiries({ body: { leadIds: ['lead-good', 'lead-missing'], message: 'Hi all' }, user: { _id: 'user-1' }, orgId: 'org-1' } as any, res);
    const payload = res.json.mock.calls[0][0];
    expect(payload.sent).toBe(1);
    expect(payload.failed).toEqual([{ leadId: 'lead-missing', error: expect.stringMatching(/no customer email/i) }]);
    expect(gmailSendMock).toHaveBeenCalledTimes(1);
    expect(sentToHeader()).toBe('customer@example.com');
    expect(missing.save).not.toHaveBeenCalled();
    expect(missing.status).toBe('New');
  });
});
