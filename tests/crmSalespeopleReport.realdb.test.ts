import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';

jest.mock('../src/utils/socketEmitter', () => ({ emitToOrg: jest.fn(), emitToUser: jest.fn(), emitToCrmUser: jest.fn(), getSocketIO: () => null }));

import CrmUser from '../src/models/CrmUser.model';
import User from '../src/models/User.model';
import Lead from '../src/models/lead.model';
import Appointment from '../src/models/Appointment.model';
import { CallLog, CommunicationMessage } from '../src/models/communication.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import crmReportsRoute from '../src/routes/crmReports.routes';
import { leadStatusBucket } from '../src/services/crmSalespeopleReport.service';

const app = express();
app.use(express.json());
app.use('/api/crm/reports', crmReportsRoute);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));

const org = new mongoose.Types.ObjectId();
const otherOrg = new mongoose.Types.ObjectId();
const orgKey = String(org);
const ids = {
  anaUser: new mongoose.Types.ObjectId(),
  benUser: new mongoose.Types.ObjectId(),
  benCrm: new mongoose.Types.ObjectId(),
  managerCrm: new mongoose.Types.ObjectId(),
  carlaCrm: new mongoose.Types.ObjectId(),
  formerUser: new mongoose.Types.ObjectId(),
};
const tokens: Record<string, string> = {};
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const from = new Date('2026-11-01T06:00:00.000Z');
const to = new Date('2026-11-08T06:59:59.999Z');
const inRange = (hours: number) => new Date(from.getTime() + hours * 60 * 60 * 1000);
const range = { from: from.toISOString(), to: to.toISOString() };
const leadIds: Record<string, mongoose.Types.ObjectId> = {};

function lead(name: string, fields: Record<string, any>) {
  const _id = new mongoose.Types.ObjectId();
  leadIds[name] = _id;
  return {
    _id,
    organizationId: org,
    createdBy: ids.anaUser,
    firstName: name,
    lastName: 'Test',
    email: `${name.toLowerCase()}@example.com`,
    phone: '+18015550199',
    source: 'Cars.com',
    channel: 'email',
    status: 'New',
    comments: '',
    vehicle: { year: '2022', make: 'Honda', model: 'Civic' },
    createdAt: inRange(10),
    updatedAt: inRange(10),
    ...fields,
  };
}

function text(fields: Record<string, any>) {
  return { orgId: orgKey, conversationId: new mongoose.Types.ObjectId(), direction: 'outbound', body: 'Hi', from: '+13855100468', to: '+18015550123', status: 'delivered', createdAt: inRange(20), updatedAt: inRange(20), ...fields };
}

function call(fields: Record<string, any>) {
  return { orgId: orgKey, direction: 'outbound', from: '+13855100468', to: '+18015550123', status: 'completed', createdAt: inRange(30), updatedAt: inRange(30), ...fields };
}

function appointment(leadId: mongoose.Types.ObjectId, status: string, entryType = 'appointment') {
  return { organizationId: orgKey, leadId, status, entryType, title: 'Test drive', startTime: inRange(50), endTime: inRange(51), createdBy: ids.anaUser, createdByModel: 'User', participantModel: 'User', createdAt: inRange(12), updatedAt: inRange(12) };
}

describe('Real-DB proof: CRM report by salesperson (local dev MongoDB only)', () => {
  beforeAll(async () => {
    await User.collection.insertMany([
      { _id: ids.anaUser, name: 'Ana Sales', email: 'ana.sales@example.com', role: 'employee', isActive: true, organizationId: org },
      { _id: ids.benUser, name: 'Ben Lot', email: 'Ben.Lot@example.com', role: 'employee', isActive: true, organizationId: org },
    ] as any[]);
    const crm = (id: any, fullName: string, email: string, role: string) => ({ _id: id, organizationId: org, fullName, username: `u-${id}`, email, role, isActive: true, password: 'x' });
    await CrmUser.collection.insertMany([
      crm(ids.benCrm, 'Ben Lot', 'ben.lot@example.com', 'employee'),
      crm(ids.managerCrm, 'Mia Manager', 'mia.manager@example.com', 'manager'),
      crm(ids.carlaCrm, 'Carla New', 'carla.new@example.com', 'employee'),
    ] as any[]);
    tokens.manager = generateCrmToken(String(ids.managerCrm));
    tokens.ben = generateCrmToken(String(ids.benCrm));
    tokens.carla = generateCrmToken(String(ids.carlaCrm));

    await Lead.collection.insertMany([
      lead('AnaNew', { assignedTo: ids.anaUser, status: 'New', createdAt: inRange(1) }),
      lead('AnaWorking', { assignedTo: ids.anaUser, status: 'Contacted', createdAt: inRange(2) }),
      lead('AnaSold', { assignedTo: ids.anaUser, status: 'Sold', createdAt: inRange(3), source: 'Third-Party Lead', sourceProvider: 'CarGurus', channel: 'adf' }),
      lead('BenLost', { assignedTo: ids.benUser, status: 'Missed Opportunity', createdAt: inRange(4) }),
      lead('BenAppt', { assignedTo: ids.benUser, status: 'Appointment Set', createdAt: inRange(5) }),
      lead('Nobody', { status: 'Viewed', createdAt: inRange(6) }),
      lead('Former', { assignedTo: ids.formerUser, status: 'Bought Elsewhere', createdAt: inRange(7) }),
      lead('Demo', { assignedTo: ids.anaUser, source: 'Demo', phone: '+18015550142', createdAt: inRange(8) }),
      lead('Combined', { assignedTo: ids.anaUser, status: 'Closed', combinedInto: { leadId: new mongoose.Types.ObjectId(), at: inRange(9), previousStatus: 'New' } }),
      lead('TooOld', { assignedTo: ids.anaUser, createdAt: new Date('2026-10-20T12:00:00.000Z') }),
      lead('OtherOrg', { organizationId: otherOrg, assignedTo: ids.anaUser }),
    ] as any[]);

    await Appointment.collection.insertMany([
      appointment(leadIds.AnaSold, 'completed'),
      appointment(leadIds.AnaSold, 'scheduled'),
      appointment(leadIds.AnaWorking, 'cancelled'),
      appointment(leadIds.AnaNew, 'scheduled', 'task'),
      appointment(leadIds.BenAppt, 'confirmed'),
    ] as any[]);

    await CommunicationMessage.collection.insertMany([
      text({ sentBy: { userId: ids.benCrm, name: 'Ben Lot', email: 'ben.lot@example.com' } }),
      text({ sentBy: { userId: String(ids.benCrm), name: 'Ben Lot' } }),
      text({ sentBy: { userId: ids.benCrm, name: 'Ben Lot' }, status: 'failed' }),
      text({ sentBy: { userId: ids.anaUser, name: 'Ana Sales', email: 'ana.sales@example.com' } }),
      text({ sentBy: { userId: 'ai-agent', name: 'Anna' } }),
      text({ sentBy: { userId: 'system', name: 'Anna' } }),
      text({ direction: 'inbound', status: 'received', sentBy: null }),
      text({ sentBy: { userId: ids.anaUser, name: 'Ana Sales' }, createdAt: new Date('2026-10-20T12:00:00.000Z') }),
      text({ orgId: String(otherOrg), sentBy: { userId: ids.anaUser, name: 'Ana Sales' } }),
    ] as any[]);

    await CallLog.collection.insertMany([
      call({ placedBy: { userId: String(ids.anaUser), name: 'Ana Sales' } }),
      call({ placedBy: { userId: String(ids.anaUser), name: 'Ana Sales' }, status: 'canceled' }),
      call({ direction: 'inbound', answeredBy: { userId: String(ids.benCrm), name: 'Ben Lot' }, answeredAt: inRange(31) }),
      call({ direction: 'inbound', answeredBy: { userId: String(ids.anaUser), name: 'Ana Sales' }, answeredAt: null, status: 'missed' }),
      call({ direction: 'inbound', status: 'missed', answeredBy: null }),
      call({ orgId: org, direction: 'inbound', answeredBy: { userId: String(ids.anaUser), name: 'Ana Sales' }, answeredAt: inRange(33) }),
    ] as any[]);
  });

  afterAll(async () => {
    await Promise.all([
      User.collection.deleteMany({ _id: { $in: [ids.anaUser, ids.benUser] } }),
      CrmUser.collection.deleteMany({ organizationId: org }),
      Lead.collection.deleteMany({ organizationId: { $in: [org, otherOrg] } }),
      Appointment.collection.deleteMany({ organizationId: orgKey }),
      CommunicationMessage.collection.deleteMany({ orgId: { $in: [orgKey, String(otherOrg)] } }),
      CallLog.collection.deleteMany({ orgId: { $in: [orgKey, org] } }),
    ]);
  });

  it('puts every lead status in the right group', () => {
    expect(leadStatusBucket('New')).toBe('notWorked');
    expect(leadStatusBucket('Viewed')).toBe('notWorked');
    expect(leadStatusBucket('')).toBe('notWorked');
    expect(leadStatusBucket('Contacted')).toBe('working');
    expect(leadStatusBucket('Appointment Set')).toBe('working');
    expect(leadStatusBucket('Sold')).toBe('sold');
    expect(leadStatusBucket('In Finance')).toBe('sold');
    expect(leadStatusBucket('Missed Opportunity')).toBe('lost');
    expect(leadStatusBucket('Bought Elsewhere')).toBe('lost');
    expect(leadStatusBucket('Closed')).toBe('lost');
  });

  it('shows a manager every salesperson with their leads, appointments, texts and calls', async () => {
    const res = await request(app).get('/api/crm/reports/salespeople').query(range).set(as('manager'));
    expect(res.status).toBe(200);
    const report = res.body.data;
    expect(report.scope).toBe('everyone');
    expect(report.rows.map((row: any) => row.name)).toEqual(['Ana Sales', 'Ben Lot', 'Former team member', 'Unassigned']);
    const byName = new Map<string, any>(report.rows.map((row: any) => [row.name, row]));
    expect(byName.get('Ana Sales')).toMatchObject({ email: 'ana.sales@example.com', active: true, leads: 3, notWorked: 1, working: 1, sold: 1, lost: 0, appointments: 1, textsSent: 1, callsMade: 2, callsAnswered: 1 });
    expect(byName.get('Ben Lot')).toMatchObject({ leads: 2, notWorked: 0, working: 1, sold: 0, lost: 1, appointments: 1, textsSent: 2, callsMade: 0, callsAnswered: 1 });
    expect(byName.get('Former team member')).toMatchObject({ leads: 1, lost: 1, active: false });
    expect(byName.get('Unassigned')).toMatchObject({ leads: 1, notWorked: 1, textsSent: 0 });
    expect(report.totals).toMatchObject({ leads: 7, notWorked: 2, working: 2, sold: 1, lost: 2, appointments: 2, textsSent: 3, callsMade: 2, callsAnswered: 2 });
    expect(report.leads).toBeUndefined();
    expect(report.rows.some((row: any) => row.name === 'Mia Manager' || row.name === 'Carla New')).toBe(false);
  });

  it('shows a salesperson only their own numbers', async () => {
    const res = await request(app).get('/api/crm/reports/salespeople').query({ ...range, leads: '1' }).set(as('ben'));
    expect(res.status).toBe(200);
    const report = res.body.data;
    expect(report.scope).toBe('self');
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({ name: 'Ben Lot', leads: 2, textsSent: 2, callsAnswered: 1 });
    expect(report.totals.leads).toBe(2);
    expect(report.leads.map((row: any) => row.firstName).sort()).toEqual(['BenAppt', 'BenLost']);

    const empty = await request(app).get('/api/crm/reports/salespeople').query(range).set(as('carla'));
    expect(empty.status).toBe(200);
    expect(empty.body.data.rows).toEqual([expect.objectContaining({ name: 'Carla New', leads: 0, textsSent: 0 })]);
  });

  it('lists the leads behind the numbers for the Excel export, grouped by salesperson', async () => {
    const res = await request(app).get('/api/crm/reports/salespeople').query({ ...range, leads: '1' }).set(as('manager'));
    expect(res.status).toBe(200);
    const rows = res.body.data.leads;
    expect(res.body.data.leadsTruncated).toBe(false);
    expect(rows.map((row: any) => `${row.salesperson}:${row.firstName}`)).toEqual([
      'Ana Sales:AnaSold', 'Ana Sales:AnaWorking', 'Ana Sales:AnaNew',
      'Ben Lot:BenAppt', 'Ben Lot:BenLost',
      'Former team member:Former',
      'Unassigned:Nobody',
    ]);
    expect(rows[0]).toMatchObject({ lastName: 'Test', phone: '+18015550199', email: 'anasold@example.com', source: 'Third-Party Lead (CarGurus)', status: 'Sold' });
    expect(rows.find((row: any) => row.firstName === 'AnaNew').source).toBe('Other (Cars.com)');
    expect(rows.some((row: any) => ['Demo', 'Combined', 'TooOld', 'OtherOrg'].includes(row.firstName))).toBe(false);
  });

  it('refuses a missing or too long date range', async () => {
    const missing = await request(app).get('/api/crm/reports/salespeople').query({ from: range.from }).set(as('manager'));
    expect(missing.status).toBe(400);
    const long = await request(app).get('/api/crm/reports/salespeople').query({ from: '2025-01-01T07:00:00.000Z', to: range.to }).set(as('manager'));
    expect(long.status).toBe(400);
    expect(long.body.message).toBe('Pick a date range of one year or less.');
    const noToken = await request(app).get('/api/crm/reports/salespeople').query(range);
    expect(noToken.status).toBe(401);
  });
});
