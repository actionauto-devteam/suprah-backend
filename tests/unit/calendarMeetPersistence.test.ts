const save = jest.fn(), sync = jest.fn();
jest.mock('../../src/utils/asyncHandler', () => ({ asyncHandler: (handler: unknown) => handler }));
jest.mock('../../src/models/calendarEvent.model', () => ({ CalendarEvent: class {
  _id = 'event-one';
  constructor(value: any) { Object.assign(this, value); }
  save() { return save(); }
  async populate() { return this; }
  toObject() { return { ...this }; }
} }));
jest.mock('../../src/models/Appointment.model', () => ({ __esModule: true, default: {} }));
jest.mock('../../src/services/calendarMeetSync.service', () => ({ syncCalendarMeeting: sync, calendarMeetingTimes: jest.fn() }));
jest.mock('../../src/services/calendarSocket.service', () => ({ emitCalendarChange: jest.fn() }));
jest.mock('../../src/services/notification.service', () => ({ __esModule: true, default: { createNotificationBatch: jest.fn() } }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, default: { error: jest.fn() } }));
jest.mock('ical-generator', () => ({ __esModule: true, default: jest.fn() }));
import { createEvent } from '../../src/controllers/calendar.controller';

const request: any = { crmUser: { _id: 'host', fullName: 'Host' }, orgId: 'org', body: {
  type: 'meeting', title: 'HR planning', start: '2030-01-01T16:00:00Z', end: '2030-01-01T17:00:00Z', assignees: [],
} };
beforeEach(() => { jest.clearAllMocks(); save.mockResolvedValue(undefined); });

it('returns the saved calendar event when room sync fails, with a durable retry marker', async () => {
  sync.mockRejectedValue(new Error('Temporary database failure'));
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await (createEvent as any)(request, res);
  expect(res.status).toHaveBeenCalledWith(201);
  expect(res.json.mock.calls[0][0].item).toMatchObject({ id: 'event-one', title: 'HR planning', meetingSyncPending: true });
  expect(save).toHaveBeenCalledTimes(1);
});

it('does not report success when the calendar event itself could not be saved', async () => {
  save.mockRejectedValue(new Error('Calendar write failed'));
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await expect((createEvent as any)(request, res)).rejects.toThrow('Calendar write failed');
  expect(sync).not.toHaveBeenCalled();
  expect(res.json).not.toHaveBeenCalled();
});
