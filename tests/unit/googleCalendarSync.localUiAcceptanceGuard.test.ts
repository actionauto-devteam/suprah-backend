jest.mock('../../src/models/User.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/Appointment.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/models/OrgLeadConfig.model', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../src/models/CrmUser.model', () => ({ __esModule: true, default: { findById: jest.fn() } }));

import googleCalendarService from '../../src/services/googleCalendar.service';

function resetLocalUiAcceptanceMode() {
  delete process.env.LOCAL_UI_ACCEPTANCE_MODE;
}

describe('LOCAL_UI_ACCEPTANCE_MODE guard for googleCalendar.service.ts syncAllEvents', () => {
  let syncInternalSpy: jest.SpyInstance;

  beforeEach(() => {
    syncInternalSpy = jest.spyOn(googleCalendarService as any, 'syncInternal').mockResolvedValue(7);
    resetLocalUiAcceptanceMode();
  });

  afterEach(() => {
    syncInternalSpy.mockRestore();
    resetLocalUiAcceptanceMode();
  });

  it('blocks and never reaches syncInternal (the real Google Calendar API path) when the flag is set', async () => {
    process.env.LOCAL_UI_ACCEPTANCE_MODE = 'true';
    const result = await googleCalendarService.syncAllEvents('org-1', 'user-1');
    expect(result).toBe(0);
    expect(syncInternalSpy).not.toHaveBeenCalled();
  });

  it('behaves exactly as before when the flag is absent', async () => {
    const result = await googleCalendarService.syncAllEvents('org-1', 'user-1');
    expect(result).toBe(7);
    expect(syncInternalSpy).toHaveBeenCalledWith({ type: 'org', id: 'org-1' }, 'user-1', undefined);
  });
});
