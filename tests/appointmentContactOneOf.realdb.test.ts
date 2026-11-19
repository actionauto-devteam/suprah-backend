const mockEmailCalls: Record<string, jest.Mock> = {};
jest.mock('../src/services/googleCalendar.service', () => ({
  __esModule: true,
  default: {
    syncAppointmentToGoogleCalendar: jest.fn().mockResolvedValue(undefined),
    deleteFromGoogleCalendar: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../src/services/email.service', () => ({
  __esModule: true,
  default: new Proxy({}, {
    get: (_target, key: string) => {
      if (!mockEmailCalls[key]) mockEmailCalls[key] = jest.fn().mockResolvedValue(true);
      return mockEmailCalls[key];
    },
  }),
}));
jest.mock('../src/utils/socketEmitter', () => ({
  emitToOrg: jest.fn(),
  emitToUser: jest.fn(),
  emitToCrmUser: jest.fn(),
  streamLogToAdmins: jest.fn(),
  getSocketIO: () => null,
}));
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));
jest.mock('../src/utils/safeNotification', () => ({
  notifyOrgAdmins: jest.fn().mockResolvedValue(undefined),
  notifyUsers: jest.fn().mockResolvedValue(undefined),
  safeCreateNotification: jest.fn().mockResolvedValue(undefined),
}));

import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import Lead from '../src/models/lead.model';
import Appointment from '../src/models/Appointment.model';
import UserActivity from '../src/models/UserActivity.model';
import appointmentService, { CUSTOMER_CONTACT_REQUIRED_MESSAGE } from '../src/services/appointment.service';
import customerBookingService from '../src/services/customerbooking.service';
import appointmentController from '../src/controllers/appointment.controller';
import { getAppointmentsDashboard } from '../src/controllers/appointmentDashboard.controller';

const orgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const OTHER = String(otherOrgId);
const bethUser = new mongoose.Types.ObjectId();
const bethCrm = new mongoose.Types.ObjectId();
const otherCrm = new mongoose.Types.ObjectId();
let slot = 0;

function nextSlot() {
  slot += 1;
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 3);
  start.setUTCHours(15, 0, 0, 0);
  start.setUTCMinutes(slot * 40);
  return { startTime: start, endTime: new Date(start.getTime() + 30 * 60 * 1000) };
}

function booking(customer: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    title: 'Test Drive',
    type: 'test-drive',
    entryType: 'appointment',
    participants: [],
    customerBooking: { isCustomerBooking: true, firstName: 'Pat', lastName: 'Lee', ...customer },
    ...nextSlot(),
    ...extra,
  } as any;
}

const emailCalls = (name: string) => (mockEmailCalls[name] ? mockEmailCalls[name].mock.calls : []);

function callHandler(handler: any, req: Record<string, unknown>) {
  return new Promise<{ statusCode: number; body: any }>((resolve, reject) => {
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { resolve({ statusCode: this.statusCode, body }); return this; },
    };
    handler(req, res, (error: unknown) => (error ? reject(error) : resolve({ statusCode: res.statusCode, body: null })));
  });
}

async function cleanup() {
  await Promise.all([
    Organization.collection.deleteMany({ _id: { $in: [orgId, otherOrgId] } }),
    User.collection.deleteMany({ organizationId: { $in: [orgId, otherOrgId] } }),
    CrmUser.collection.deleteMany({ organizationId: { $in: [orgId, otherOrgId] } }),
    Lead.collection.deleteMany({ organizationId: { $in: [orgId, otherOrgId] } }),
    Appointment.collection.deleteMany({ organizationId: { $in: [ORG, OTHER] } }),
    UserActivity.collection.deleteMany({ organizationId: { $in: [orgId, otherOrgId, ORG, OTHER] } }),
  ]);
}

describe('Real-DB: customer appointments need a phone or an email, not both (local test DB only)', () => {
  beforeAll(async () => {
    if (mongoose.connection.host !== '127.0.0.1' || mongoose.connection.port !== 27018 || !/_test$/.test(mongoose.connection.name)) throw new Error('Local test DB only');
    await cleanup();
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Contact Motors', slug: `p71-${orgId}`, status: 'active', metadata: {} },
      { _id: otherOrgId, name: 'Other Motors', slug: `p71-${otherOrgId}`, status: 'active', metadata: {} },
    ] as any[]);
    await User.collection.insertOne({ _id: bethUser, organizationId: orgId, name: 'Beth Reyes', email: `beth-${ORG}@example.com`, role: 'employee', isActive: true, password: 'x' } as any);
    const crm = (id: mongoose.Types.ObjectId, org: mongoose.Types.ObjectId, fullName: string, email: string) => ({
      _id: id, organizationId: org, fullName, username: `u-${id}`, email, role: 'employee', isActive: true, password: 'x', isOffboarded: false, isSystem: false,
    });
    await CrmUser.collection.insertMany([
      crm(bethCrm, orgId, 'Beth Reyes', `beth-${ORG}@example.com`),
      crm(otherCrm, otherOrgId, 'Olive Other', `olive-${OTHER}@example.com`),
    ] as any[]);
  });

  beforeEach(() => {
    for (const fn of Object.values(mockEmailCalls)) fn.mockClear();
  });

  afterAll(async () => {
    await cleanup();
  });

  it('books a customer with only a phone number and does not try to email them', async () => {
    const created: any = await appointmentService.createAppointment(String(bethCrm), ORG, booking({ firstName: 'Ana', lastName: 'Phone', email: '', phone: '+18015550111' }));
    const saved: any = await Appointment.findById(created._id).lean();
    expect(saved.customerBooking).toMatchObject({ firstName: 'Ana', email: '', phone: '+18015550111' });
    expect(emailCalls('sendAppointmentInvitation')).toHaveLength(0);
  });

  it('books a customer with only an email and sends the invitation to that email', async () => {
    const created: any = await appointmentService.createAppointment(String(bethCrm), ORG, booking({ firstName: 'Ben', lastName: 'Email', email: ' Ben.Email@Example.com ', phone: '' }));
    const saved: any = await Appointment.findById(created._id).lean();
    expect(saved.customerBooking).toMatchObject({ email: 'ben.email@example.com', phone: '' });
    expect(emailCalls('sendAppointmentInvitation').map((call) => call[2])).toEqual(['ben.email@example.com']);
  });

  it('still books a customer with both, as before', async () => {
    const created: any = await appointmentService.createAppointment(String(bethCrm), ORG, booking({ firstName: 'Cy', lastName: 'Both', email: 'cy@example.com', phone: '+18015550133' }));
    expect(created.customerBooking).toMatchObject({ email: 'cy@example.com', phone: '+18015550133' });
    expect(emailCalls('sendAppointmentInvitation')).toHaveLength(1);
  });

  it('refuses a customer booking with neither, with a plain message, even when the fields are left out', async () => {
    const before = await Appointment.countDocuments({ organizationId: ORG });
    await expect(appointmentService.createAppointment(String(bethCrm), ORG, booking({ email: '  ', phone: '' })))
      .rejects.toMatchObject({ statusCode: 400, message: CUSTOMER_CONTACT_REQUIRED_MESSAGE });
    await expect(appointmentService.createAppointment(String(bethCrm), ORG, booking({ email: undefined, phone: undefined })))
      .rejects.toMatchObject({ statusCode: 400, message: CUSTOMER_CONTACT_REQUIRED_MESSAGE });
    expect(await Appointment.countDocuments({ organizationId: ORG })).toBe(before);
    expect(CUSTOMER_CONTACT_REQUIRED_MESSAGE).toBe('Add a phone number or an email for the customer.');
  });

  it('edits keep the rule: clearing the only contact is refused, other edits work and skip the customer email when there is none', async () => {
    const phoneOnly: any = await Appointment.findOne({ organizationId: ORG, 'customerBooking.lastName': 'Phone' });
    await expect(appointmentService.updateAppointment(String(phoneOnly._id), ORG, String(bethCrm), {
      customerBooking: { ...phoneOnly.customerBooking.toObject(), phone: '' },
    } as any)).rejects.toMatchObject({ statusCode: 400, message: CUSTOMER_CONTACT_REQUIRED_MESSAGE });
    expect((await Appointment.findById(phoneOnly._id).lean() as any).customerBooking.phone).toBe('+18015550111');

    await appointmentService.updateAppointment(String(phoneOnly._id), ORG, String(bethCrm), { notes: 'Bring the trade-in title' } as any);
    expect(emailCalls('sendAppointmentUpdate')).toHaveLength(0);

    const emailOnly: any = await Appointment.findOne({ organizationId: ORG, 'customerBooking.lastName': 'Email' });
    await appointmentService.updateAppointment(String(emailOnly._id), ORG, String(bethCrm), { notes: 'Called to confirm' } as any);
    expect(emailCalls('sendAppointmentUpdate').map((call) => call[2])).toEqual(['ben.email@example.com']);
  });

  it('cancel and delete of a phone-only booking skip the customer email', async () => {
    const cancelMe: any = await appointmentService.createAppointment(String(bethCrm), ORG, booking({ firstName: 'Cal', lastName: 'Cancel', email: '', phone: '+18015550144' }));
    await appointmentService.cancelAppointment(String(cancelMe._id), ORG, String(bethCrm));
    expect((await Appointment.findById(cancelMe._id).lean() as any).status).toBe('cancelled');

    const deleteMe: any = await appointmentService.createAppointment(String(bethCrm), ORG, booking({ firstName: 'Dee', lastName: 'Delete', email: '', phone: '+18015550155' }));
    await appointmentService.deleteAppointment(String(deleteMe._id), ORG, String(bethCrm));
    expect(await Appointment.exists({ _id: deleteMe._id })).toBeNull();
    expect(emailCalls('sendAppointmentCancellation')).toHaveLength(0);
  });

  it('booking history does not join customers just because they have no email, and stays inside the dealership', async () => {
    const one: any = await appointmentService.createAppointment(String(bethCrm), ORG, booking({ firstName: 'Hana', lastName: 'One', email: '', phone: '+18015550161' }));
    const two: any = await appointmentService.createAppointment(String(bethCrm), ORG, booking({ firstName: 'Ivan', lastName: 'Two', email: '', phone: '+18015550162' }));
    const elsewhere: any = await appointmentService.createAppointment(String(otherCrm), OTHER, booking({ firstName: 'Hana', lastName: 'One', email: '', phone: '+18015550163' }));
    const again: any = await appointmentService.createAppointment(String(bethCrm), ORG, booking({ firstName: 'Hana', lastName: 'One', email: '', phone: '+18015550161' }));

    const history = async (id: unknown) => ((await Appointment.findById(id).lean()) as any).customerBooking.bookingHistory;
    expect((await history(two._id)).totalBookings).toBe(1);
    expect((await history(elsewhere._id)).totalBookings).toBe(1);
    const hana = await history(again._id);
    expect(hana.totalBookings).toBe(2);
    expect(hana.previousBookings.map(String).sort()).toEqual([String(one._id), String(again._id)].sort());
  });

  it('the duplicate check used by the main appointments page does not treat blank details as a match', async () => {
    const phoneOnlyAna = { firstName: 'Ana', lastName: 'Phone', organizationId: ORG };
    const start = nextSlot().startTime;
    await expect(customerBookingService.checkDuplicateBooking({ ...phoneOnlyAna, email: '', phone: '+18015559999' }, start))
      .resolves.toEqual({ isDuplicate: false });
    await expect(customerBookingService.checkDuplicateBooking({ ...phoneOnlyAna, email: '', phone: '' }, start))
      .resolves.toEqual({ isDuplicate: false });
    await expect(customerBookingService.checkDuplicateBooking({ ...phoneOnlyAna, email: undefined, phone: undefined } as any, start))
      .resolves.toEqual({ isDuplicate: false });
    await expect(customerBookingService.checkDuplicateBooking({ ...phoneOnlyAna, email: '', phone: '+18015550111' }, start))
      .resolves.toMatchObject({ isDuplicate: true });

    await appointmentService.createAppointment(String(bethCrm), ORG, booking({ firstName: 'Gus', lastName: 'Dash', email: '', phone: '(801) 555-0199' }));
    await expect(customerBookingService.checkDuplicateBooking({ firstName: 'Gus', lastName: 'Dash', organizationId: ORG, email: '', phone: '801-555-0199' }, start))
      .resolves.toMatchObject({ isDuplicate: true });
    await expect(customerBookingService.checkDuplicateBooking({ firstName: 'Gus', lastName: 'Dash', organizationId: ORG, email: '', phone: '801 555 0198' }, start))
      .resolves.toEqual({ isDuplicate: false });
  });

  it('the Service Hub list shows no phone for an email-only booking instead of "N/A"', async () => {
    const emailOnly: any = await Appointment.findOne({ organizationId: ORG, 'customerBooking.lastName': 'Email' }).lean();
    const date = new Date(emailOnly.startTime).toLocaleDateString('en-CA', { timeZone: 'America/Denver' });
    const listed = await callHandler(getAppointmentsDashboard, { orgId: ORG, query: { date } });
    const row = listed.body.data.appointments.find((item: any) => String(item._id) === String(emailOnly._id));
    expect(row.customerBooking).toMatchObject({ email: 'ben.email@example.com', phone: '' });
  });

  it('the public test drive form still needs both, and spaces do not count as a phone or an email', async () => {
    const startTime = nextSlot().startTime.toISOString();
    const body = { vehicleId: String(new mongoose.Types.ObjectId()), firstName: 'Web', lastName: 'Visitor', startTime };
    const before = await Appointment.countDocuments({});
    for (const contact of [{ email: '   ', phone: '   ' }, { email: 'web@example.com', phone: '   ' }, { email: '  ', phone: '+18015550170' }]) {
      const response = await callHandler(appointmentController.createPublicTestDriveBooking, { body: { ...body, ...contact }, ip: '127.0.0.1', headers: {} });
      expect(response.statusCode).toBe(400);
    }
    expect(await Appointment.countDocuments({})).toBe(before);
  });
});
