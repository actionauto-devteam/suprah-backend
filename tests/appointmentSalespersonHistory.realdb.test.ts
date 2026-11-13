jest.mock('../src/services/googleCalendar.service', () => ({
  __esModule: true,
  default: {
    syncAppointmentToGoogleCalendar: jest.fn().mockResolvedValue(undefined),
    deleteFromGoogleCalendar: jest.fn().mockResolvedValue(undefined),
  },
}));
jest.mock('../src/services/email.service', () => ({
  __esModule: true,
  default: new Proxy({}, { get: () => jest.fn().mockResolvedValue(true) }),
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
import appointmentService from '../src/services/appointment.service';

const orgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const ids = {
  bethUser: new mongoose.Types.ObjectId(),
  bethCrm: new mongoose.Types.ObjectId(),
  maryCrm: new mongoose.Types.ObjectId(),
  repAUser: new mongoose.Types.ObjectId(),
  repACrm: new mongoose.Types.ObjectId(),
  repBUser: new mongoose.Types.ObjectId(),
  repBCrm: new mongoose.Types.ObjectId(),
  customerUser: new mongoose.Types.ObjectId(),
};
let leadId: mongoose.Types.ObjectId;

function tomorrowAt(hour: number, minute = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 2);
  date.setUTCHours(hour, minute, 0, 0);
  return date;
}

const customer = { isCustomerBooking: true, firstName: 'Paul', lastName: 'Neville', email: 'paul.neville.p51@example.com', phone: '+18015557701' };

function booking(extra: Record<string, unknown> = {}) {
  return {
    title: 'Test Drive — 2022 Honda Civic',
    startTime: tomorrowAt(17),
    endTime: tomorrowAt(17, 30),
    type: 'test-drive',
    entryType: 'appointment',
    participants: [],
    customerBooking: customer,
    leadId: String(leadId),
    ...extra,
  } as any;
}

async function cleanup() {
  await Promise.all([
    Organization.collection.deleteMany({ _id: orgId }),
    User.collection.deleteMany({ organizationId: orgId }),
    CrmUser.collection.deleteMany({ organizationId: orgId }),
    Lead.collection.deleteMany({ organizationId: orgId }),
    Appointment.collection.deleteMany({ organizationId: ORG }),
    UserActivity.collection.deleteMany({ organizationId: { $in: [orgId, ORG] } }),
  ]);
}

describe('Real-DB: appointment salesperson, staff edits and change history (local test DB only)', () => {
  beforeAll(async () => {
    if (mongoose.connection.host !== '127.0.0.1' || mongoose.connection.port !== 27018 || !/_test$/.test(mongoose.connection.name)) throw new Error('Local test DB only');
    await cleanup();
    await Organization.collection.insertOne({ _id: orgId, name: 'Appointment Motors', slug: `p51-${orgId}`, status: 'active', metadata: {} } as any);
    const user = (id: mongoose.Types.ObjectId, name: string, email: string, role = 'employee') => ({ _id: id, organizationId: orgId, name, email, role, isActive: true, password: 'x' });
    await User.collection.insertMany([
      user(ids.bethUser, 'Beth Reyes', `beth-${ORG}@example.com`),
      user(ids.repAUser, 'Rep Alpha', `repa-${ORG}@example.com`),
      user(ids.repBUser, 'Rep Bravo', `repb-${ORG}@example.com`),
      user(ids.customerUser, 'Some Customer', `cust-${ORG}@example.com`, 'customer'),
    ] as any[]);
    const crm = (id: mongoose.Types.ObjectId, fullName: string, email: string, role = 'employee') => ({ _id: id, organizationId: orgId, fullName, username: `u-${id}`, email, role, isActive: true, password: 'x', isOffboarded: false, isSystem: false });
    await CrmUser.collection.insertMany([
      crm(ids.bethCrm, 'Beth Reyes', `beth-${ORG}@example.com`),
      crm(ids.maryCrm, 'Mary Pinero', `mary-${ORG}@example.com`),
      crm(ids.repACrm, 'Rep Alpha', `repa-${ORG}@example.com`),
      crm(ids.repBCrm, 'Rep Bravo', `repb-${ORG}@example.com`),
    ] as any[]);
    const lead = await Lead.collection.insertOne({ organizationId: orgId, createdBy: ids.bethUser, firstName: 'Paul', lastName: 'Neville', phone: '+18015557701', status: 'New', source: 'Third-Party Lead', channel: 'email', notes: [], createdAt: new Date(), updatedAt: new Date() } as any);
    leadId = lead.insertedId as mongoose.Types.ObjectId;
  });

  afterAll(async () => {
    await cleanup();
  });

  it('lets two salespeople have a customer at the same time, but not the same salesperson twice', async () => {
    const first: any = await appointmentService.createAppointment(String(ids.bethCrm), ORG, booking({ salespersonUserId: String(ids.repAUser) }));
    expect(first.salesperson.name).toBe('Rep Alpha');
    expect(first.participants.map((p: any) => String(p._id ?? p))).toEqual([String(ids.repACrm)]);

    const second: any = await appointmentService.createAppointment(String(ids.bethCrm), ORG, booking({ salespersonUserId: String(ids.repBUser) }));
    expect(second.salesperson.name).toBe('Rep Bravo');

    await expect(appointmentService.createAppointment(String(ids.bethCrm), ORG, booking({ salespersonUserId: String(ids.repAUser) })))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/^Double-Booking Conflict: Rep Alpha already has "Test Drive — 2022 Honda Civic" from .+M[SD]T/) });

    await expect(appointmentService.createAppointment(String(ids.bethCrm), ORG, booking({ customerBooking: undefined, title: 'Beth team huddle', participants: [] })))
      .resolves.toBeTruthy();

    const noSalesperson: any = await appointmentService.createAppointment(String(ids.bethCrm), ORG, booking());
    expect(noSalesperson.salesperson).toBeNull();

    await expect(appointmentService.createAppointment(String(ids.bethCrm), ORG, booking({ customerBooking: undefined, title: 'Beth second huddle', participants: [] })))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/M[SD]T/) });
  });

  it('refuses a customer account or an inactive person as the salesperson', async () => {
    await expect(appointmentService.createAppointment(String(ids.bethCrm), ORG, booking({ startTime: tomorrowAt(19), endTime: tomorrowAt(19, 30), salespersonUserId: String(ids.customerUser) })))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('records a booking receipt on the appointment and in the lead thread', async () => {
    const appointment: any = await Appointment.findOne({ organizationId: ORG, 'salesperson.userId': ids.repAUser }).lean();
    expect(appointment.changeHistory[0]).toMatchObject({ action: 'created', byName: 'Beth Reyes' });
    const lead: any = await Lead.findById(leadId).lean();
    const booked = lead.notes.find((note: any) => note.noteKind === 'appointment' && /Appointment booked: Test Drive on .+ with Rep Alpha\./.test(note.text));
    expect(booked).toMatchObject({ authorName: 'Beth Reyes' });
  });

  it('lets any staff member change a customer appointment from the CRM and keeps a receipt of who changed what', async () => {
    const appointment: any = await Appointment.findOne({ organizationId: ORG, 'salesperson.userId': ids.repAUser });
    await expect(appointmentService.updateAppointment(String(appointment._id), ORG, String(ids.maryCrm), { type: 'phone' } as any))
      .rejects.toMatchObject({ statusCode: 403 });

    await appointmentService.updateAppointment(
      String(appointment._id),
      ORG,
      String(ids.maryCrm),
      { type: 'phone', participants: appointment.participants.map(String) } as any,
      { staffEditor: true, actorName: 'Mary Pinero' },
    );
    const updated: any = await Appointment.findById(appointment._id).lean();
    expect(updated.type).toBe('phone');
    const last = updated.changeHistory[updated.changeHistory.length - 1];
    expect(last).toMatchObject({ action: 'updated', byName: 'Mary Pinero', changes: [{ field: 'type', label: 'Type', from: 'Test Drive', to: 'Phone Call' }] });
    const lead: any = await Lead.findById(leadId).lean();
    expect(lead.notes.some((note: any) => note.noteKind === 'appointment' && note.authorName === 'Mary Pinero' && /Type: Test Drive → Phone Call/.test(note.text))).toBe(true);
  });

  it('checks the new salesperson calendar when the salesperson changes', async () => {
    const appointment: any = await Appointment.findOne({ organizationId: ORG, 'salesperson.userId': ids.repAUser });
    await expect(appointmentService.updateAppointment(String(appointment._id), ORG, String(ids.maryCrm), { salespersonUserId: String(ids.repBUser) } as any, { staffEditor: true, actorName: 'Mary Pinero' }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/^Double-Booking Conflict: Rep Bravo already has/) });

    await appointmentService.updateAppointment(
      String(appointment._id),
      ORG,
      String(ids.maryCrm),
      { salespersonUserId: String(ids.repBUser), startTime: tomorrowAt(18), endTime: tomorrowAt(18, 30) } as any,
      { staffEditor: true, actorName: 'Mary Pinero' },
    );
    const moved: any = await Appointment.findById(appointment._id).lean();
    expect(moved.salesperson.name).toBe('Rep Bravo');
    expect(moved.participants.map(String)).toEqual([String(ids.repBCrm)]);
    const last = moved.changeHistory[moved.changeHistory.length - 1];
    expect(last.changes.map((change: any) => change.field)).toEqual(expect.arrayContaining(['startTime', 'endTime', 'salesperson']));
  });

  it('lets staff cancel a customer appointment and records it; only the creator can delete', async () => {
    const appointment: any = await Appointment.findOne({ organizationId: ORG, 'salesperson.userId': ids.repBUser, type: 'test-drive' });
    await expect(appointmentService.deleteAppointment(String(appointment._id), ORG, String(ids.maryCrm))).rejects.toMatchObject({ statusCode: 403 });
    await appointmentService.cancelAppointment(String(appointment._id), ORG, String(ids.maryCrm), { staffEditor: true, actorName: 'Mary Pinero' });
    const cancelled: any = await Appointment.findById(appointment._id).lean();
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.changeHistory[cancelled.changeHistory.length - 1]).toMatchObject({ action: 'cancelled', byName: 'Mary Pinero' });
    const lead: any = await Lead.findById(leadId).lean();
    expect(lead.notes.some((note: any) => note.noteKind === 'appointment' && /^Appointment cancelled:/.test(note.text) && note.authorName === 'Mary Pinero')).toBe(true);

    await appointmentService.deleteAppointment(String(appointment._id), ORG, String(ids.bethCrm));
    expect(await Appointment.findById(appointment._id).lean()).toBeNull();
    const after: any = await Lead.findById(leadId).lean();
    expect(after.notes.some((note: any) => note.noteKind === 'appointment' && /^Appointment deleted:/.test(note.text) && note.authorName === 'Beth Reyes')).toBe(true);
  });
});
