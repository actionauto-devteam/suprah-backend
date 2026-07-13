import googleCalendarService from '../../services/googleCalendar.service';
import CrmUser from '../../models/CrmUser.model';
import OrgLeadConfig from '../../models/OrgLeadConfig.model';
import mongoose from 'mongoose';

jest.mock('../../models/CrmUser.model');
jest.mock('../../models/OrgLeadConfig.model');
jest.mock('../../utils/crypto', () => ({
  encrypt: jest.fn().mockReturnValue('encrypted'),
  decrypt: jest.fn().mockReturnValue('decrypted'),
}));
jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn().mockImplementation(() => ({
        setCredentials: jest.fn(),
        generateAuthUrl: jest.fn().mockReturnValue('mock-url'),
        getToken: jest.fn().mockResolvedValue({ tokens: { access_token: 'mock-access' } }),
        on: jest.fn(),
      })),
    },
    calendar: jest.fn().mockReturnValue({
      events: {
        list: jest.fn().mockResolvedValue({ data: { items: [] } }),
        insert: jest.fn().mockResolvedValue({ data: { id: 'mock-event-id' } }),
        patch: jest.fn().mockResolvedValue({ data: { id: 'mock-event-id' } }),
        delete: jest.fn().mockResolvedValue({}),
        watch: jest.fn().mockResolvedValue({ data: { id: 'mock-channel' } }),
      },
    }),
  },
}));

describe('GoogleCalendarService Unit Tests', () => {
  const mockOrgId = new mongoose.Types.ObjectId().toString();
  const mockCrmUserId = new mongoose.Types.ObjectId().toString();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('isCrmUserCalendarConnected', () => {
    it('should return true if CrmUser has googleCalendar tokens', async () => {
      (CrmUser.findById as jest.Mock).mockReturnValue({
        select: jest.fn().mockResolvedValue({
          googleCalendar: { accessToken: 'some-token', calendarConnected: true }
        })
      });

      const result = await googleCalendarService.isCrmUserCalendarConnected(mockCrmUserId);
      expect(result).toBe(true);
    });

    it('should return false if CrmUser does not have tokens', async () => {
      (CrmUser.findById as jest.Mock).mockReturnValue({
        select: jest.fn().mockResolvedValue(null)
      });

      const result = await googleCalendarService.isCrmUserCalendarConnected(mockCrmUserId);
      expect(result).toBe(false);
    });
  });

  describe('disconnectCalendar', () => {
    it('should set calendarConnected to false in CrmUser', async () => {
      const mockUpdate = jest.fn().mockResolvedValue({});
      (CrmUser.updateOne as jest.Mock).mockImplementation(mockUpdate);

      await googleCalendarService.disconnectCalendar(mockCrmUserId);

      expect(CrmUser.updateOne).toHaveBeenCalledWith(
        { _id: mockCrmUserId },
        { $set: { 'googleCalendar.calendarConnected': false } }
      );
    });
  });

  describe('getCalendarClient', () => {
    it('should resolve to crmUser target if crmUser exists and has tokens', async () => {
      (CrmUser.findById as jest.Mock).mockResolvedValue({
        _id: mockCrmUserId,
        googleCalendar: {
          accessToken: 'user-access',
          refreshToken: 'user-refresh',
          calendarConnected: true
        }
      });

      const target = { type: 'crmUser' as const, id: mockCrmUserId };
      const client = await (googleCalendarService as any).getCalendarClient(target);
      
      expect(client).toBeDefined();
      expect(CrmUser.findById).toHaveBeenCalledWith(mockCrmUserId);
    });

    it('should resolve to org target if org configuration exists', async () => {
      (OrgLeadConfig.findOne as jest.Mock).mockResolvedValue({
        organizationId: mockOrgId,
        accessToken: 'org-access',
        refreshToken: 'org-refresh',
        calendarConnected: true
      });

      const target = { type: 'org' as const, id: mockOrgId };
      const client = await (googleCalendarService as any).getCalendarClient(target);
      
      expect(client).toBeDefined();
      expect(OrgLeadConfig.findOne).toHaveBeenCalled();
    });
  });
});
