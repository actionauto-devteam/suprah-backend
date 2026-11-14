const byId = jest.fn(), update = jest.fn(), logError = jest.fn();
let tokens: (value: unknown) => Promise<void>;
jest.mock('googleapis', () => ({ google: { auth: { OAuth2: jest.fn(() => ({ setCredentials: jest.fn(),
  on: (_event: string, callback: typeof tokens) => { tokens = callback; } })) }, calendar: jest.fn(() => ({})) } }));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: { findById: byId, updateOne: update } }));
jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/OrgLeadConfig.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/Appointment.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/Meeting.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/calendarMeetSync.service', () => ({}));
jest.mock('../../src/utils/crypto', () => ({ encrypt: (value: string) => `encrypted:${value}`, decrypt: (value: string) => value }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: logError } }));
import service from '../../src/services/googleCalendar.service';

beforeEach(() => { jest.clearAllMocks(); byId.mockResolvedValue({ googleCalendar: {
  calendarConnected: true, accessToken: 'old-access', refreshToken: 'refresh',
} }); update.mockResolvedValue({ modifiedCount: 1 }); });

it('a token persistence outage is handled instead of escaping as an unhandled event rejection', async () => {
  await (service as any).getCalendarClient({ type: 'crmUser', id: 'person' });
  update.mockRejectedValueOnce(new Error('Database temporarily unavailable'));
  await expect(tokens({ access_token: 'new-access' })).resolves.toBeUndefined();
  expect(logError).toHaveBeenCalled();
});
it('stores refreshed credentials under their CRM calendar fields without clearing a retained refresh token', async () => {
  await (service as any).getCalendarClient({ type: 'crmUser', id: 'person' });
  await tokens({ access_token: 'new-access' });
  expect(update).toHaveBeenCalledWith({ _id: 'person' }, { $set: { 'googleCalendar.accessToken': 'encrypted:new-access' } });
});
it('bounds every Google event-list request', async () => {
  const list = jest.fn().mockResolvedValue({ data: { items: [], nextSyncToken: 'next' } });
  await (service as any).fetchAllEventsFromGoogle({ events: { list } }, new Date('2030-01-01'), new Date('2030-02-01'));
  expect(list).toHaveBeenCalledWith(expect.any(Object), { timeout: 15_000 });
});
