const mockSms = jest.fn();

jest.mock('../src/services/telnyx.service', () => {
  const actual = jest.requireActual('../src/services/telnyx.service');
  return { ...actual, COMPANY_NUMBER: '+18015550900', sendSms: (...args: unknown[]) => mockSms(...args) };
});
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
import Lead from '../src/models/lead.model';
import UserActivity from '../src/models/UserActivity.model';
import { CommunicationMessage, Conversation } from '../src/models/communication.model';
import { getAllLeads, assignLead, markAsRead, getAssignedNewCount } from '../src/controllers/lead.controller';
import { sendSmsFromUser } from '../src/services/communication.service';
import { addLeadNoteAndNotify } from '../src/utils/leadNote';
import { touchLeadActivity } from '../src/utils/leadActivity';

const orgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const adminId = new mongoose.Types.ObjectId();
const repId = new mongoose.Types.ObjectId();
const rep2Id = new mongoose.Types.ObjectId();
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000);

function fakeRes() {
  const res: any = {};
  res.status = (code: number) => { res.code = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}

async function listed(query: Record<string, string> = {}) {
  const res = fakeRes();
  await getAllLeads({ orgId: ORG, query: { limit: '50', ...query } } as any, res);
  return (res.body?.data?.leads || []) as any[];
}

const names = (leads: any[]) => leads.map((lead) => lead.firstName);

async function newCount(userId: mongoose.Types.ObjectId) {
  const res = fakeRes();
  await getAssignedNewCount({ orgId: ORG, user: { _id: userId } } as any, res);
  return res.body?.data?.count;
}

async function assign(actor: mongoose.Types.ObjectId, leadId: unknown, assignedTo: mongoose.Types.ObjectId | null) {
  const res = fakeRes();
  await assignLead({ orgId: ORG, params: { id: String(leadId) }, user: { _id: actor, name: 'Actor' }, body: { assignedTo: assignedTo ? String(assignedTo) : null }, ip: '127.0.0.1' } as any, res);
  return res;
}

async function open(viewer: mongoose.Types.ObjectId, leadId: unknown) {
  const res = fakeRes();
  await markAsRead({ orgId: ORG, params: { id: String(leadId) }, user: { _id: viewer } } as any, res);
  return res;
}

let leadA: any;
let leadB: any;
let leadC: any;

async function cleanup() {
  await Promise.all([
    Organization.collection.deleteMany({ _id: orgId }),
    User.collection.deleteMany({ organizationId: orgId }),
    Lead.collection.deleteMany({ organizationId: orgId }),
    UserActivity.collection.deleteMany({ organizationId: { $in: [orgId, ORG] } }),
    Conversation.collection.deleteMany({ orgId: { $in: [orgId, ORG] } }),
    CommunicationMessage.collection.deleteMany({ orgId: { $in: [orgId, ORG] } }),
  ]);
}

describe('Real-DB: Recent / Newest sorting and new-assignment count (local test DB only)', () => {
  beforeAll(async () => {
    if (mongoose.connection.host !== '127.0.0.1' || mongoose.connection.port !== 27018 || !/_test$/.test(mongoose.connection.name)) throw new Error('Local test DB only');
    await cleanup();
    await Organization.collection.insertOne({ _id: orgId, name: 'Sort Motors', slug: `sort-${orgId}`, status: 'active', metadata: { aiAgentModes: { sms: 'off', email: 'off', webchat: 'off' } } } as any);
    await User.collection.insertMany([
      { _id: adminId, organizationId: orgId, name: 'Ada Admin', email: `sort-admin-${orgId}@example.com`, role: 'admin', isActive: true },
      { _id: repId, organizationId: orgId, name: 'Riley Rep', email: `sort-rep-${orgId}@example.com`, role: 'employee', isActive: true },
      { _id: rep2Id, organizationId: orgId, name: 'Rowan Rep', email: `sort-rep2-${orgId}@example.com`, role: 'employee', isActive: true },
    ] as any[]);
    const base = { organizationId: orgId, createdBy: adminId, source: 'Manual Entry', channel: 'sms', status: 'New', isRead: true };
    await Lead.collection.insertMany([
      { ...base, firstName: 'Alpha', phone: '+18015554801', normalizedPhone: '+18015554801', createdAt: minutesAgo(3 * 1440), updatedAt: minutesAgo(1), followUp: { lastCustomerActivityAt: minutesAgo(3 * 1440), lastActivityAt: minutesAgo(1) } },
      { ...base, firstName: 'Bravo', phone: '+18015554802', normalizedPhone: '+18015554802', createdAt: minutesAgo(2 * 1440), updatedAt: minutesAgo(10), followUp: { lastCustomerActivityAt: minutesAgo(10) } },
      { ...base, firstName: 'Charlie', phone: '+18015554803', normalizedPhone: '+18015554803', createdAt: minutesAgo(1440), updatedAt: minutesAgo(1440), followUp: { lastCustomerActivityAt: minutesAgo(1440) } },
    ] as any[]);
    leadA = await Lead.findOne({ organizationId: orgId, firstName: 'Alpha' }).lean();
    leadB = await Lead.findOne({ organizationId: orgId, firstName: 'Bravo' }).lean();
    leadC = await Lead.findOne({ organizationId: orgId, firstName: 'Charlie' }).lean();
  });

  beforeEach(() => {
    mockSms.mockReset().mockResolvedValue({ id: `sms-${Date.now()}` });
  });

  afterAll(cleanup);

  it('1. Recent ranks by the latest thing on either side; Newest by the latest customer activity; the plain created-date order is unchanged', async () => {
    expect(names(await listed({ sortBy: 'latest_activity' }))).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(names(await listed({ sortBy: 'customer_activity' }))).toEqual(['Bravo', 'Charlie', 'Alpha']);
    expect(names(await listed({ sortBy: 'newest' }))).toEqual(['Charlie', 'Bravo', 'Alpha']);
    expect(names(await listed())).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });

  it('2. a staff text moves the lead to the top of Recent only, without touching the customer time', async () => {
    await sendSmsFromUser({ orgId, user: { userId: String(adminId), name: 'Ada Admin' }, toPhone: '+18015554803', body: 'Hi Charlie, checking in!', leadId: leadC._id, destinationPolicy: 'manual' });
    const fresh: any = await Lead.findById(leadC._id).lean();
    expect(fresh.followUp.lastActivityAt).toBeTruthy();
    expect(new Date(fresh.followUp.lastCustomerActivityAt).getTime()).toBe(new Date(leadC.followUp.lastCustomerActivityAt).getTime());
    expect(names(await listed({ sortBy: 'latest_activity' }))[0]).toBe('Charlie');
    expect(names(await listed({ sortBy: 'customer_activity' }))).toEqual(['Bravo', 'Charlie', 'Alpha']);
  });

  it('3. an internal note moves the lead to the top of Recent', async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await addLeadNoteAndNotify({ organizationId: ORG, leadId: String(leadB._id), text: 'Customer prefers mornings', createdBy: String(adminId), authorName: 'Ada Admin', authorType: 'user' } as any);
    expect(names(await listed({ sortBy: 'latest_activity' }))[0]).toBe('Bravo');
  });

  it('4. the activity time never moves backwards', async () => {
    const before: any = await Lead.findById(leadB._id).lean();
    await touchLeadActivity(leadB._id, ORG, minutesAgo(600));
    const after: any = await Lead.findById(leadB._id).lean();
    expect(new Date(after.followUp.lastActivityAt).getTime()).toBe(new Date(before.followUp.lastActivityAt).getTime());
  });

  it('5. a lead assigned by someone else counts as new for that rep until the rep opens it', async () => {
    expect(await newCount(repId)).toBe(0);
    const res = await assign(adminId, leadA._id, repId);
    expect(res.code ?? 200).toBe(200);
    expect(String(((await Lead.findById(leadA._id).lean()) as any).assignmentUnseenBy)).toBe(String(repId));
    expect(await newCount(repId)).toBe(1);
    expect(await newCount(adminId)).toBe(0);
    const row = (await listed({ assignedTo: String(repId) })).find((lead) => lead.firstName === 'Alpha');
    expect(String(row?.assignmentUnseenBy)).toBe(String(repId));

    await open(adminId, leadA._id);
    expect(await newCount(repId)).toBe(1);
    await open(repId, leadA._id);
    expect(await newCount(repId)).toBe(0);
    expect(((await Lead.findById(leadA._id).lean()) as any).assignmentUnseenBy ?? null).toBeNull();
  });

  it('6. assigning a lead to yourself is not counted, reassigning moves the count, and unassigning clears it', async () => {
    await assign(repId, leadB._id, repId);
    expect(await newCount(repId)).toBe(0);

    await assign(adminId, leadC._id, repId);
    expect(await newCount(repId)).toBe(1);
    await assign(adminId, leadC._id, rep2Id);
    expect(await newCount(repId)).toBe(0);
    expect(await newCount(rep2Id)).toBe(1);
    await assign(adminId, leadC._id, null);
    expect(await newCount(rep2Id)).toBe(0);
    expect(((await Lead.findById(leadC._id).lean()) as any).assignmentUnseenBy ?? null).toBeNull();
  });
});
