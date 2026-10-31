const mockRoomEmit = jest.fn();

jest.mock('../src/services/telnyx.service', () => ({
  ...jest.requireActual('../src/services/telnyx.service'),
  COMPANY_NUMBER: '+18015550900',
}));
jest.mock('../src/utils/socketEmitter', () => ({
  ...jest.requireActual('../src/utils/socketEmitter'),
  getSocketIO: () => ({ to: (room: string) => ({ emit: (event: string, data: unknown) => mockRoomEmit(room, event, data) }), emit: jest.fn() }),
  emitToOrg: (orgId: string, event: string, data: unknown) => mockRoomEmit(`org:${orgId}`, event, data),
  emitToUser: jest.fn(),
  emitToCrmUser: jest.fn(),
  streamLogToAdmins: jest.fn(),
}));
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));
jest.mock('../src/utils/safeNotification', () => ({
  notifyOrgAdmins: jest.fn().mockResolvedValue(undefined),
  notifyUsers: jest.fn().mockResolvedValue(undefined),
  safeCreateNotification: jest.fn().mockResolvedValue(undefined),
}));

import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import Lead from '../src/models/lead.model';
import DealershipPhoneNumber from '../src/models/DealershipPhoneNumber.model';
import ContactRestrictionAudit from '../src/models/ContactRestrictionAudit.model';
import { CallLog } from '../src/models/communication.model';
import { CallRecording } from '../src/models/CallRecording.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import { errorHandler } from '../src/middleware/error.middleware';
import communicationRoutes from '../src/routes/communication.routes';
import leadRoutes from '../src/routes/lead.route';

const app = express();
app.use(express.json());
app.use('/api/crm/communications', communicationRoutes);
app.use('/api/leads', leadRoutes);
app.use(errorHandler);

const orgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const MAIN = '+18015550905';
const ownerUser = new mongoose.Types.ObjectId();
const repCrm = new mongoose.Types.ObjectId();
let token = '';
let serial = 0;
const saved = { org: process.env.COMM_ORG_ID, skip: process.env.SKIP_RATE_LIMIT };
const nextPhone = () => `+1801555${String(8100 + (++serial)).slice(-4)}`;
const nextClientId = () => `cc_p17_${Date.now()}_${++serial}`;

const api = (method: 'get' | 'post', path: string) => request(app)[method](path).set('Authorization', `Bearer ${token}`);
const logCall = (body: Record<string, unknown>) => api('post', '/api/crm/communications/calls/log').send(body);
const active = async () => (await api('get', '/api/crm/communications/calls/active')).body.data.items as any[];
const conversation = async (leadId: unknown) => (await api('get', `/api/leads/${leadId}/conversation`)).body.data;
const callItem = async (leadId: unknown) => (await conversation(leadId)).items.find((item: any) => item.kind === 'call');

async function newLead(fields: Record<string, unknown> = {}) {
  const phone = nextPhone();
  const lead = await Lead.create({ organizationId: orgId, createdBy: ownerUser, firstName: 'Riley', lastName: 'Buyer', phone, status: 'New', channel: 'web', source: 'Website Inquiry', ...fields });
  return { phone, lead };
}

describe('Real-DB: calling from Leads and live call status (local MongoDB, no live Telnyx)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/test/i.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('External network is blocked in this test'));
    process.env.COMM_ORG_ID = ORG;
    process.env.SKIP_RATE_LIMIT = 'true';
    await Promise.all([Lead.createIndexes(), CallLog.init(), CallRecording.init(), DealershipPhoneNumber.init()]);
    await Organization.collection.insertOne({ _id: orgId, name: 'Phase 17 Motors', slug: `p17-${orgId}`, status: 'active', metadata: {} } as any);
    await Organization.collection.insertOne({ _id: otherOrgId, name: 'Other Motors', slug: `p17-${otherOrgId}`, status: 'active', metadata: {} } as any);
    await User.collection.insertOne({ _id: ownerUser, name: 'Ada Admin', email: `p17-owner-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: orgId, isActive: true } as any);
    await CrmUser.collection.insertOne({ _id: repCrm, organizationId: orgId, fullName: 'Remy Rep', username: `p17-rep-${orgId}`, email: `p17-rep-${orgId}@example.com`, role: 'employee', isActive: true, password: 'x' } as any);
    await DealershipPhoneNumber.create({ organizationId: orgId, number: MAIN, label: 'Main Line', kind: 'main', location: '', department: '', telnyx: { status: 'ready', readyForCalls: true, readyForTexts: true, message: '', checkedAt: new Date() }, createdBy: ownerUser, updatedBy: ownerUser });
    token = generateCrmToken(String(repCrm));
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    process.env.COMM_ORG_ID = saved.org;
    process.env.SKIP_RATE_LIMIT = saved.skip;
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/test/i.test(dbName)) await mongoose.connection.db!.dropDatabase();
  });

  test('a rep can call a lead who never contacted the dealership, and the main number is used', async () => {
    const { phone, lead } = await newLead();
    const started = await logCall({ clientCallId: nextClientId(), event: 'start', toPhone: phone, leadId: String(lead._id) });
    expect(started.status).toBe(200);
    expect(started.body.data.call).toMatchObject({ direction: 'outbound', status: 'ringing', from: MAIN, to: phone, lineLabel: 'Main Line' });
  });

  test('a Do Not Contact customer cannot be called, no call is logged, and the attempt is recorded', async () => {
    const { phone, lead } = await newLead({ status: 'Do Not Contact' });
    const refused = await logCall({ clientCallId: nextClientId(), event: 'start', toPhone: phone, leadId: String(lead._id) });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toMatch(/Do Not Contact/);
    expect(await CallLog.countDocuments({ to: phone })).toBe(0);
    expect(await ContactRestrictionAudit.countDocuments({ leadId: lead._id, event: 'outbound_blocked', purpose: 'manual_call' })).toBe(1);
  });

  test('a call shows as active with its number, then disappears when it ends', async () => {
    const { phone, lead } = await newLead();
    const clientCallId = nextClientId();
    await logCall({ clientCallId, event: 'start', toPhone: phone, leadId: String(lead._id) });
    const row = (await active()).find((item) => item.leadId === String(lead._id));
    expect(row).toMatchObject({ direction: 'outbound', status: 'ringing', number: MAIN, customerNumber: phone, lineLabel: 'Main Line' });

    const ringing = await callItem(lead._id);
    expect(ringing.call).toMatchObject({ live: true, number: MAIN, customerNumber: phone, lineLabel: 'Main Line', recording: null });

    await logCall({ clientCallId, event: 'answered' });
    expect((await active()).find((item) => item.leadId === String(lead._id)).status).toBe('in-progress');
    await CallLog.updateOne({ clientCallId }, { $set: { answeredAt: new Date(Date.now() - 65000) } });
    await logCall({ clientCallId, event: 'end' });

    expect((await active()).some((item) => item.leadId === String(lead._id))).toBe(false);
    const ended = await callItem(lead._id);
    expect(ended.call).toMatchObject({ live: false, status: 'completed', label: 'Answered', placedBy: 'Remy Rep' });
    expect(ended.call.durationSec).toBeGreaterThanOrEqual(64);
  });

  test('a call left open by a closed browser stops showing as active after two hours', async () => {
    const { phone, lead } = await newLead();
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const inserted = await CallLog.collection.insertOne({ orgId, leadId: lead._id, direction: 'outbound', from: MAIN, to: phone, status: 'in-progress', startedAt: old, createdAt: old, updatedAt: old } as any);
    expect((await active()).some((item) => item.callId === String(inserted.insertedId))).toBe(false);
    expect((await callItem(lead._id)).call.live).toBe(false);
  });

  test('other dealerships and calls with no lead are never listed', async () => {
    const { lead } = await newLead();
    const now = new Date();
    const foreign = await CallLog.collection.insertOne({ orgId: otherOrgId, leadId: lead._id, direction: 'inbound', from: nextPhone(), to: MAIN, status: 'in-progress', startedAt: now, createdAt: now, updatedAt: now } as any);
    const noLead = await CallLog.collection.insertOne({ orgId, leadId: null, direction: 'inbound', from: nextPhone(), to: MAIN, status: 'ringing', startedAt: now, createdAt: now, updatedAt: now } as any);
    const ids = (await active()).map((item) => item.callId);
    expect(ids).not.toContain(String(foreign.insertedId));
    expect(ids).not.toContain(String(noLead.insertedId));
  });

  test('an inbound call shows the number the customer called and the menu choice', async () => {
    const { phone, lead } = await newLead();
    const now = new Date();
    await CallLog.collection.insertOne({ orgId, leadId: lead._id, direction: 'inbound', from: phone, to: MAIN, status: 'completed', lineLabel: 'Main Line', durationSec: 42, answeredBy: { userId: String(repCrm), name: 'Remy Rep' }, routing: { selectedLabel: 'Sales' }, startedAt: now, answeredAt: now, endedAt: now, createdAt: now, updatedAt: now } as any);
    expect((await callItem(lead._id)).call).toMatchObject({ number: MAIN, customerNumber: phone, answeredBy: 'Remy Rep', selectedOption: 'Sales', durationSec: 42 });
  });

  test('a saved recording shows on its call, but deleted, expired and never-started ones do not', async () => {
    const row = async (recording: Record<string, unknown>) => {
      const { phone, lead } = await newLead();
      const now = new Date();
      const call = await CallLog.collection.insertOne({ orgId, leadId: lead._id, direction: 'outbound', from: MAIN, to: phone, status: 'completed', startedAt: now, createdAt: now, updatedAt: now } as any);
      await CallRecording.collection.insertOne({ organizationId: ORG, callLogId: call.insertedId, startedAt: now, state: 'ready', files: [], ...recording } as any);
      return (await callItem(lead._id)).call.recording;
    };
    const shown = await row({});
    expect(shown).toEqual({ id: expect.any(String), state: 'ready' });
    expect(await row({ state: 'deleted' })).toBeNull();
    expect(await row({ expiresAt: new Date(Date.now() - 1000) })).toBeNull();
    expect(await row({ startedAt: null, state: 'failed' })).toBeNull();
  });

  test('someone without recording access still gets the card data but cannot open the recording', async () => {
    const { phone, lead } = await newLead();
    const now = new Date();
    const call = await CallLog.collection.insertOne({ orgId, leadId: lead._id, direction: 'outbound', from: MAIN, to: phone, status: 'completed', startedAt: now, createdAt: now, updatedAt: now } as any);
    const recording = await CallRecording.collection.insertOne({ organizationId: ORG, callLogId: call.insertedId, startedAt: now, endedAt: now, state: 'ready', files: [] } as any);
    expect((await callItem(lead._id)).call.recording.id).toBe(String(recording.insertedId));
    expect((await api('get', `/api/crm/communications/recordings/${recording.insertedId}`)).status).toBe(403);
  });
});
