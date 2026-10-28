jest.mock('../src/services/telnyx.service', () => ({
  COMPANY_NUMBER: '+18015550900',
  transferToAgent: jest.fn().mockResolvedValue({ data: { result: 'ok' } }),
  playMissedAndHangup: jest.fn().mockResolvedValue(undefined),
  hangupCall: jest.fn().mockResolvedValue({}),
  answerCall: jest.fn().mockResolvedValue({}),
  speak: jest.fn().mockResolvedValue({}),
  speakIvr: jest.fn().mockResolvedValue({}),
  gatherIvr: jest.fn().mockResolvedValue({}),
  sendSms: jest.fn().mockResolvedValue({ id: 'sim-sms' }),
  verifyWebhookSignature: jest.fn(() => true),
}));
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));
jest.mock('../src/utils/safeNotification', () => ({
  notifyOrgAdmins: jest.fn().mockResolvedValue(undefined),
  notifyUsers: jest.fn().mockResolvedValue(undefined),
  safeCreateNotification: jest.fn().mockResolvedValue(undefined),
}));

import http from 'http';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { Server } from 'socket.io';
import config from '../src/config';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import { setupSocket } from '../src/socket';
import { setSocketIO, emitToOrg } from '../src/utils/socketEmitter';
import { CRM_STAFF_EVENTS } from '../src/utils/crmStaffRoom';
import { addLeadNoteAndNotify } from '../src/utils/leadNote';
import Lead from '../src/models/lead.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import * as comm from '../src/services/communication.service';

const { io: connectClient } = require('C:/Users/Admin/Desktop/actionauto-devteam/suprah-frontend/node_modules/socket.io-client');

const orgA = new mongoose.Types.ObjectId();
const orgB = new mongoose.Types.ObjectId();
const ids = {
  employee: new mongoose.Types.ObjectId(),
  admin: new mongoose.Types.ObjectId(),
  adminCrm: new mongoose.Types.ObjectId(),
  crmOnly: new mongoose.Types.ObjectId(),
  customer: new mongoose.Types.ObjectId(),
  driver: new mongoose.Types.ObjectId(),
  deactivated: new mongoose.Types.ObjectId(),
  deactivatedCrm: new mongoose.Types.ObjectId(),
  otherDealer: new mongoose.Types.ObjectId(),
};
const email = (name: string) => `p11-alerts-${name}-${orgA}@example.com`;
const mainToken = (id: mongoose.Types.ObjectId) => jwt.sign({ sub: String(id), type: 'access' }, config.jwt.accessSecret, { expiresIn: '10m' });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let server: http.Server;
let ioServer: Server;
const clients: Record<string, any> = {};
const received: Record<string, Array<{ event: string; data: any }>> = {};
const saved = process.env.COMM_ORG_ID;
const noteLead = new mongoose.Types.ObjectId();

async function connect(name: string, token: string) {
  const port = (server.address() as any).port;
  const socket = connectClient(`http://127.0.0.1:${port}`, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  received[name] = [];
  socket.onAny((event: string, data: any) => received[name].push({ event, data }));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (error: Error) => reject(new Error(`${name}: ${error.message}`)));
  });
  clients[name] = socket;
}

describe('Real-DB + real Socket.IO: who receives incoming-call alerts', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/test/i.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    process.env.COMM_ORG_ID = String(orgA);
    await Organization.collection.insertMany([
      { _id: orgA, name: 'Alert Motors', slug: `p11-alerts-${orgA}`, status: 'active', metadata: {} },
      { _id: orgB, name: 'Other Alert Motors', slug: `p11-alerts-${orgB}`, status: 'active', metadata: {} },
    ] as any[]);
    const user = (id: mongoose.Types.ObjectId, name: string, role: string, organizationId = orgA) =>
      ({ _id: id, name, email: email(name), password: 'x', role, organizationId, isActive: true });
    await User.collection.insertMany([
      user(ids.employee, 'employee', 'employee'),
      user(ids.admin, 'admin', 'admin'),
      user(ids.customer, 'customer', 'customer'),
      user(ids.driver, 'driver', 'driver'),
      user(ids.deactivated, 'deactivated', 'employee'),
      user(ids.otherDealer, 'otherdealer', 'employee', orgB),
    ] as any[]);
    await CrmUser.collection.insertMany([
      { _id: ids.adminCrm, organizationId: orgA, fullName: 'Admin CRM', username: `p11-alerts-admincrm-${orgA}`, email: email('admin'), role: 'admin', isActive: true, password: 'x' },
      { _id: ids.crmOnly, organizationId: orgA, fullName: 'CRM Only', username: `p11-alerts-crmonly-${orgA}`, email: email('crmonly'), role: 'employee', isActive: true, password: 'x' },
      { _id: ids.deactivatedCrm, organizationId: orgA, fullName: 'Deactivated CRM', username: `p11-alerts-deact-${orgA}`, email: email('deactivated'), role: 'employee', isActive: false, password: 'x' },
    ] as any[]);
    await Lead.collection.insertOne({ _id: noteLead, organizationId: orgA, createdBy: ids.employee, firstName: 'Note', lastName: 'Lead', phone: '+18015557398', source: 'Website Inquiry', channel: 'web', status: 'New', notes: [], createdAt: new Date(), updatedAt: new Date() } as any);
    server = http.createServer();
    ioServer = new Server(server);
    setupSocket(ioServer);
    setSocketIO(ioServer);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    await connect('employee', mainToken(ids.employee));
    await connect('adminWithCrmAccount', mainToken(ids.admin));
    await connect('crmOnly', generateCrmToken(String(ids.crmOnly)));
    await connect('customer', mainToken(ids.customer));
    await connect('driver', mainToken(ids.driver));
    await connect('deactivatedCrmAccount', mainToken(ids.deactivated));
    await connect('otherDealership', mainToken(ids.otherDealer));
  });

  afterAll(async () => {
    Object.values(clients).forEach((socket) => socket.disconnect());
    await new Promise<void>((resolve) => ioServer.close(() => resolve()));
    process.env.COMM_ORG_ID = saved;
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/test/i.test(dbName)) await mongoose.connection.db!.dropDatabase();
  });

  test('only staff who can answer get the ringing call; customers, drivers, deactivated staff and other dealerships do not', async () => {
    Object.values(received).forEach((list) => list.splice(0));
    const controlId = `v3:p11-alert-${Date.now()}`;
    await comm.handleCallInitiated({ direction: 'incoming', call_control_id: controlId, call_session_id: `session-${controlId}`, from: '+18015557301', to: '+18015550900' });
    await wait(800);
    const rang = (name: string) => received[name].some((entry) => entry.event === 'comm:call:incoming' && entry.data?.call?.providerCallControlId === controlId);
    expect({
      employee: rang('employee'),
      adminWithCrmAccount: rang('adminWithCrmAccount'),
      crmOnly: rang('crmOnly'),
      customer: rang('customer'),
      driver: rang('driver'),
      deactivatedCrmAccount: rang('deactivatedCrmAccount'),
      otherDealership: rang('otherDealership'),
    }).toEqual({
      employee: true,
      adminWithCrmAccount: true,
      crmOnly: true,
      customer: false,
      driver: false,
      deactivatedCrmAccount: false,
      otherDealership: false,
    });
    const customerData = JSON.stringify(received.customer) + JSON.stringify(received.driver);
    expect(customerData).not.toContain('+18015557301');
  });

  test('later call updates (claimed, ended) follow the same staff-only audience', async () => {
    Object.values(received).forEach((list) => list.splice(0));
    const controlId = `v3:p11-alert-end-${Date.now()}`;
    await comm.handleCallInitiated({ direction: 'incoming', call_control_id: controlId, call_session_id: `session-${controlId}`, from: '+18015557302', to: '+18015550900' });
    await comm.handleCallHangup({ call_control_id: controlId, call_session_id: `session-${controlId}`, hangup_cause: 'originator_cancel' });
    await wait(800);
    const updated = (name: string) => received[name].some((entry) => entry.event === 'comm:call:update' && entry.data?.call?.providerCallControlId === controlId);
    expect(updated('employee')).toBe(true);
    expect(updated('crmOnly')).toBe(true);
    expect(updated('customer')).toBe(false);
    expect(updated('driver')).toBe(false);
    expect(updated('otherDealership')).toBe(false);
  });

  test('the lead created for an unknown caller is also announced to staff only', async () => {
    Object.values(received).forEach((list) => list.splice(0));
    const controlId = `v3:p11-alert-lead-${Date.now()}`;
    await comm.handleCallInitiated({ direction: 'incoming', call_control_id: controlId, call_session_id: `session-${controlId}`, from: '+18015557303', to: '+18015550900' });
    await wait(800);
    const newLead = (name: string) => received[name].some((entry) => entry.event === 'lead:new' && entry.data?.phone === '+18015557303');
    expect(newLead('employee')).toBe(true);
    expect(newLead('crmOnly')).toBe(true);
    expect(newLead('customer')).toBe(false);
    expect(newLead('driver')).toBe(false);
    expect(newLead('otherDealership')).toBe(false);
  });

  test('a lead and its text message from an incoming text reach staff only', async () => {
    Object.values(received).forEach((list) => list.splice(0));
    await comm.handleInboundSms({ id: `p11-alert-sms-${Date.now()}`, from: { phone_number: '+18015557304' }, to: [{ phone_number: '+18015550900' }], text: 'Is the truck still available?' });
    await wait(800);
    const got = (name: string, event: string) => received[name].some((entry) => entry.event === event && JSON.stringify(entry.data).includes('+18015557304'));
    for (const event of ['lead:new', 'comm:message:new']) {
      expect({ event, employee: got('employee', event), crmOnly: got('crmOnly', event), customer: got('customer', event), driver: got('driver', event), deactivated: got('deactivatedCrmAccount', event), other: got('otherDealership', event) })
        .toEqual({ event, employee: true, crmOnly: true, customer: false, driver: false, deactivated: false, other: false });
    }
  });

  test('every CRM lead event sent to the dealership reaches staff only, through the shared emitter and the direct emits', async () => {
    Object.values(received).forEach((list) => list.splice(0));
    for (const event of Array.from(CRM_STAFF_EVENTS)) emitToOrg(String(orgA), event, { marker: `p11-${event}`, phone: '+18015557399' });
    await addLeadNoteAndNotify({ organizationId: String(orgA), leadId: String(noteLead), text: 'Customer prefers mornings', authorType: 'user', createdBy: String(ids.employee), authorName: 'Employee' } as any).catch(() => undefined);
    await wait(800);
    const seen = (name: string) => new Set(received[name].map((entry) => entry.event));
    for (const event of Array.from(CRM_STAFF_EVENTS)) {
      expect({ event, employee: seen('employee').has(event), customer: seen('customer').has(event), driver: seen('driver').has(event), deactivated: seen('deactivatedCrmAccount').has(event) })
        .toEqual({ event, employee: true, customer: false, driver: false, deactivated: false });
    }
    const noteUpdates = (name: string) => received[name].filter((entry) => entry.event === 'lead:update' && String(entry.data?._id) === String(noteLead)).length;
    expect(noteUpdates('employee')).toBeGreaterThan(0);
    expect(noteUpdates('customer') + noteUpdates('driver') + noteUpdates('deactivatedCrmAccount')).toBe(0);
  });

  test('other dealership-wide updates (not lead data) still reach every account linked to the dealership', async () => {
    Object.values(received).forEach((list) => list.splice(0));
    emitToOrg(String(orgA), 'activity:new', { marker: 'team-activity' });
    await wait(500);
    for (const name of ['employee', 'crmOnly', 'customer', 'driver', 'deactivatedCrmAccount']) {
      expect({ name, got: received[name].some((entry) => entry.event === 'activity:new') }).toEqual({ name, got: true });
    }
    expect(received.otherDealership.some((entry) => entry.event === 'activity:new')).toBe(false);
  });
});
