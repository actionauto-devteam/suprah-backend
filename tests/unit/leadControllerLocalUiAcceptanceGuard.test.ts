const gmailSendMock = jest.fn().mockResolvedValue({ data: { id: 'sent-msg-1' } });
const gmailThreadsGetMock = jest.fn().mockResolvedValue({ data: { messages: [] } });
const oauth2SetCredentials = jest.fn();
const oauth2On = jest.fn();

jest.mock('googleapis', () => ({
  google: {
    gmail: jest.fn().mockReturnValue({
      users: {
        messages: { send: gmailSendMock },
        threads: { get: gmailThreadsGetMock },
      },
    }),
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        setCredentials: oauth2SetCredentials,
        on: oauth2On,
      })),
    },
  },
}));

jest.mock('../../src/services/appointment.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/googleCalendar.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/lead.model', () => ({ __esModule: true, default: { findOne: jest.fn(), findById: jest.fn() } }));
jest.mock('../../src/models/Appointment.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: { findById: jest.fn().mockResolvedValue({ email: 'rep@example.com' }) } }));
jest.mock('../../src/services/activity.service', () => ({ __esModule: true, default: { createActivity: jest.fn() } }));
jest.mock('../../src/utils/safeNotification', () => ({ safeCreateNotification: jest.fn(), notifyOrgAdmins: jest.fn(), safeBroadcastNotification: jest.fn() }));
jest.mock('../../src/utils/notificationTemplates', () => ({ notificationTemplates: {} }));
jest.mock('../../src/utils/adfParser', () => ({ parseADF: jest.fn(), parseEmailBody: jest.fn(), isADFContent: jest.fn(), extractADFFromBody: jest.fn(), detectChannel: jest.fn() }));
jest.mock('../../src/utils/socketEmitter', () => ({ getSocketIO: jest.fn().mockReturnValue(null), emitToUser: jest.fn() }));
const orgLeadConfigDoc = { gmailConnected: true, refreshToken: 'enc:rt', accessToken: 'enc:at', expiryDate: Date.now() + 3600000, gmailAddress: 'dealer@example.com' };
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

import { sendLeadReplyEmail, getThreadMessages } from '../../src/controllers/lead.controller';
import Lead from '../../src/models/lead.model';
import { cacheService } from '../../src/services/cache.service';

function resetLocalUiAcceptanceMode() {
  delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
}

function invokeAsyncHandler(handler: any, req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const res: any = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn((payload: any) => {
        resolve(res);
        return res;
      }),
    };
    const next = (err?: any) => {
      if (err) reject(err);
    };
    handler(req, res, next);
  });
}

describe('LOCAL_UI_ACCEPTANCE_MODE guards in lead.controller.ts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (cacheService.get as jest.Mock).mockResolvedValue(null);
    resetLocalUiAcceptanceMode();
  });

  afterAll(() => {
    resetLocalUiAcceptanceMode();
  });

  describe('sendLeadReplyEmail', () => {
    const fakeLead = { firstName: 'Jordan', subject: 'Inquiry', senderEmail: 'customer@example.com', threadId: 'thread-1' };

    it('blocks and never reaches the Gmail client when the flag is set', async () => {
      process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
      await expect(sendLeadReplyEmail(fakeLead, 'Hello there', 'user-1', 'org-1')).rejects.toThrow(/LOCAL_UI_ACCEPTANCE_MODE/);
      expect(gmailSendMock).not.toHaveBeenCalled();
    });

    it('behaves exactly as before when the flag is absent', async () => {
      await sendLeadReplyEmail(fakeLead, 'Hello there', 'user-1', 'org-1');
      expect(gmailSendMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('getThreadMessages', () => {
    const fakeLead = { _id: 'lead-1', threadId: 'thread-1', messageId: 'inquiry-msg' };

    beforeEach(() => {
      (Lead.findOne as jest.Mock).mockResolvedValue(fakeLead);
    });

    it('blocks via a graceful empty-thread response and never reaches the Gmail client when the flag is set', async () => {
      process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
      const req: any = { params: { id: 'lead-1' }, user: { _id: 'user-1' }, orgId: 'org-1' };
      const res = await invokeAsyncHandler(getThreadMessages, req);
      expect(gmailThreadsGetMock).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledTimes(1);
      const payload = res.json.mock.calls[0][0];
      expect(payload.data).toEqual({ messages: [] });
      expect(payload.message).toMatch(/LOCAL_UI_ACCEPTANCE_MODE/);
    });

    it('behaves exactly as before when the flag is absent', async () => {
      const req: any = { params: { id: 'lead-1' }, user: { _id: 'user-1' }, orgId: 'org-1' };
      const res = await invokeAsyncHandler(getThreadMessages, req);
      expect(gmailThreadsGetMock).toHaveBeenCalledTimes(1);
      const payload = res.json.mock.calls[0][0];
      expect(payload.message).not.toMatch(/LOCAL_UI_ACCEPTANCE_MODE/);
    });

    it('still returns the existing empty-thread response for a lead with no threadId, regardless of the flag', async () => {
      (Lead.findOne as jest.Mock).mockResolvedValue({ _id: 'lead-2', threadId: null });
      process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
      const req: any = { params: { id: 'lead-2' }, user: { _id: 'user-1' }, orgId: 'org-1' };
      const res = await invokeAsyncHandler(getThreadMessages, req);
      expect(gmailThreadsGetMock).not.toHaveBeenCalled();
      const payload = res.json.mock.calls[0][0];
      expect(payload.message).toBe('No email thread yet');
    });
  });
});
