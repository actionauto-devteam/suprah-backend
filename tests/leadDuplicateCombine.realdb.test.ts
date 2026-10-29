const mockSendSms = jest.fn();

jest.mock('../src/services/telnyx.service', () => ({
  COMPANY_NUMBER: '+18015550999',
  sendSms: mockSendSms,
  verifyWebhookSignature: jest.fn(() => true),
}));
jest.mock('../src/utils/socketEmitter', () => ({
  emitToOrg: jest.fn(),
  emitToUser: jest.fn(),
  emitToCrmUser: jest.fn(),
  getSocketIO: () => null,
}));
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));

import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import Lead from '../src/models/lead.model';
import LeadInquiry from '../src/models/LeadInquiry.model';
import LeadIntakeControl from '../src/models/LeadIntakeControl.model';
import LeadIntakeAudit from '../src/models/LeadIntakeAudit.model';
import LeadCombineRun from '../src/models/LeadCombineRun.model';
import LeadCombineRecord from '../src/models/LeadCombineRecord.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import leadIntakeRoutes from '../src/routes/leadIntake.routes';
import { submitLeadInquiry } from '../src/services/leadIntake.service';
import { clearLeadIntakeModeCache, setLeadIntakeMode } from '../src/services/leadIntakeControl.service';
import {
  MAX_COMBINE_GROUP_SIZE,
  previewDuplicateLeads,
  runDuplicateCombine,
  runPendingDuplicateCombines,
  undoLeadCombine,
} from '../src/services/leadDuplicateCombine.service';
import { buildLeadConversation } from '../src/services/leadConversation.service';
import { getAllLeads, getLeadStatusCounts } from '../src/controllers/lead.controller';

const app = express();
app.use(express.json());
app.use('/api/crm/lead-intake', leadIntakeRoutes);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));

const ids = {
  owner: new mongoose.Types.ObjectId(),
  rep: new mongoose.Types.ObjectId(),
  rep2: new mongoose.Types.ObjectId(),
  crmAdmin: new mongoose.Types.ObjectId(),
  crmEmployee: new mongoose.Types.ObjectId(),
};
const tokens: Record<string, string> = {};
const auth = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
const admin = { userId: String(ids.crmAdmin), name: 'Ada Admin' };
let serial = 0;
const nextPhone = () => `+1801555${String(3000 + (++serial)).slice(-4)}`;
const nextEmail = () => `combine${++serial}@example.com`;
const daysAgo = (days: number) => new Date(Date.now() - days * 86400000);

async function newOrg() {
  const orgId = new mongoose.Types.ObjectId();
  await Organization.collection.insertOne({ _id: orgId, name: 'Combine Dealer', slug: `combine-${orgId}`, status: 'active', metadata: {} } as any);
  return { orgId, ORG: String(orgId) };
}

async function activate(orgId: mongoose.Types.ObjectId) {
  await LeadIntakeControl.collection.insertOne({ organizationId: orgId, mode: 'active', reason: 'test', version: 1, createdAt: new Date(), updatedAt: new Date() } as any);
  clearLeadIntakeModeCache(String(orgId));
}

async function makeLead(orgId: mongoose.Types.ObjectId, contact: { phone?: string; email?: string }, extra: Record<string, unknown> = {}) {
  return Lead.create({
    organizationId: orgId, createdBy: ids.owner, firstName: 'Kiran', lastName: 'Pasupuleti', phone: contact.phone, email: contact.email,
    source: 'Third-Party Lead', channel: 'adf', status: 'New', isRead: true, ...extra,
  });
}

function fakeRes() {
  const res: any = {};
  res.status = (code: number) => { res.code = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}

async function listedLeadIds(ORG: string, query: Record<string, string> = {}) {
  const res = fakeRes();
  await getAllLeads({ orgId: ORG, query: { limit: '100', ...query } } as any, res);
  return (res.body?.data?.leads || []).map((lead: any) => String(lead._id));
}

describe('Real-DB: combining existing duplicate leads (local MongoDB only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/test/i.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    await Promise.all([Lead.createIndexes(), LeadInquiry.init(), LeadIntakeControl.init(), LeadIntakeAudit.init(), LeadCombineRun.init(), LeadCombineRecord.init()]);
    await User.collection.insertMany([
      { _id: ids.owner, name: 'Olivia Owner', email: `combine-owner-${ids.owner}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', isActive: true },
      { _id: ids.rep, name: 'Ryan Rep', email: `combine-rep-${ids.rep}@example.com`, password: 'x', role: 'employee', isActive: true },
      { _id: ids.rep2, name: 'Rita Rep', email: `combine-rep2-${ids.rep2}@example.com`, password: 'x', role: 'employee', isActive: true },
    ] as any[]);
  });

  afterAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/test/i.test(dbName) && /127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      await mongoose.connection.db!.dropDatabase();
    }
  });

  it('groups open leads that share a phone or an email, including chains, and leaves everything else alone', async () => {
    const { orgId, ORG } = await newOrg();
    const phone = nextPhone();
    const email = nextEmail();
    const otherEmail = nextEmail();
    const oldest = await makeLead(orgId, { phone, email }, { createdAt: daysAgo(3) });
    const middle = await makeLead(orgId, { phone, email: otherEmail }, { createdAt: daysAgo(2) });
    const newest = await makeLead(orgId, { email: otherEmail }, { lastName: 'Pa', createdAt: daysAgo(1) });
    const sold = await makeLead(orgId, { phone, email }, { status: 'Sold', createdAt: daysAgo(10) });
    const chat = await makeLead(orgId, { email }, { intakeIdentity: 'unverified', channel: 'webchat', createdAt: daysAgo(1) });
    const stranger = await makeLead(orgId, { phone: nextPhone(), email: nextEmail() }, { firstName: 'Kiran' });
    const legacyPhone = nextPhone();
    await Lead.collection.insertOne({ organizationId: orgId, createdBy: ids.owner, firstName: 'Odd', lastName: 'Status', phone: legacyPhone, status: 'Legacy Waiting', createdAt: new Date(), updatedAt: new Date() });
    await makeLead(orgId, { phone: legacyPhone });

    expect(await previewDuplicateLeads(ORG)).toEqual({ customers: 1, leads: 2, skippedGroups: 0, complete: true });

    await activate(orgId);
    const stats: any = await runDuplicateCombine(ORG);
    expect(stats).toMatchObject({ customers: 1, leadsCombined: 2, skippedGroups: 0, failedGroups: 0 });

    const after = async (id: unknown) => Lead.findById(id).lean() as any;
    expect(await after(newest._id)).toMatchObject({ status: 'New', inquiryCount: 3 });
    expect((await after(newest._id)).combinedInto).toBeUndefined();
    for (const doc of [oldest, middle]) {
      const closed = await after(doc._id);
      expect(closed.status).toBe('Closed');
      expect(String(closed.combinedInto.leadId)).toBe(String(newest._id));
      expect(closed.combinedInto.previousStatus).toBe('New');
      expect(closed.statusHistory.at(-1)).toMatchObject({ from: 'New', to: 'Closed' });
    }
    expect((await after(sold._id)).status).toBe('Sold');
    expect((await after(chat._id)).combinedInto).toBeUndefined();
    expect((await after(stranger._id)).combinedInto).toBeUndefined();
    expect(await Lead.countDocuments({ organizationId: orgId, combinedInto: { $exists: true } })).toBe(2);

    const listed = await listedLeadIds(ORG);
    expect(listed).toContain(String(newest._id));
    expect(listed).not.toContain(String(oldest._id));
    expect(listed).not.toContain(String(middle._id));
    expect(listed).toContain(String(sold._id));
    const counts = fakeRes();
    await getLeadStatusCounts({ orgId: ORG, query: {} } as any, counts);
    expect(counts.body.data.counts.Closed || 0).toBe(0);

    const audit: any = await LeadIntakeAudit.findOne({ organizationId: orgId, event: 'duplicates_combined' }).lean();
    expect(String(audit.leadId)).toBe(String(newest._id));
    expect(await LeadCombineRun.findOne({ organizationId: orgId }).lean()).toMatchObject({ state: 'done', customers: 1, leadsCombined: 2 });
  });

  it('moves upcoming appointments, open tasks, the text thread and the assigned rep to the main lead, and undo puts them back', async () => {
    const { orgId, ORG } = await newOrg();
    const phone = nextPhone();
    const email = nextEmail();
    const older = await makeLead(orgId, { phone, email }, { createdAt: daysAgo(2), assignedTo: ids.rep, inquiryCount: 2 });
    const main = await makeLead(orgId, { phone, email }, { createdAt: daysAgo(1) });
    const db = mongoose.connection.db!;
    const upcoming = await db.collection('appointments').insertOne({ organizationId: ORG, leadId: older._id, title: 'Test drive', status: 'scheduled', startTime: new Date(Date.now() + 86400000), endTime: new Date(Date.now() + 90000000) });
    const past = await db.collection('appointments').insertOne({ organizationId: ORG, leadId: older._id, title: 'Old visit', status: 'completed', startTime: daysAgo(5), endTime: daysAgo(5) });
    const task = await db.collection('aiagenttasks').insertOne({ organizationId: ORG, leadId: older._id, channel: 'sms', question: 'Call back?', status: 'pending', assigneeIds: [], waitingSince: new Date() });
    const doneTask = await db.collection('aiagenttasks').insertOne({ organizationId: ORG, leadId: older._id, channel: 'sms', question: 'Old', status: 'resolved', assigneeIds: [], waitingSince: daysAgo(3) });
    const conversation = await db.collection('conversations').insertOne({ orgId: ORG, customerPhone: phone, leadId: older._id, lastMessageAt: new Date(), messageCount: 3 });

    await activate(orgId);
    await runDuplicateCombine(ORG);
    const leadOf = async (collection: string, id: unknown) => String(((await db.collection(collection).findOne({ _id: id as any })) as any).leadId);
    expect(await leadOf('appointments', upcoming.insertedId)).toBe(String(main._id));
    expect(await leadOf('appointments', past.insertedId)).toBe(String(older._id));
    expect(await leadOf('aiagenttasks', task.insertedId)).toBe(String(main._id));
    expect(await leadOf('aiagenttasks', doneTask.insertedId)).toBe(String(older._id));
    expect(await leadOf('conversations', conversation.insertedId)).toBe(String(main._id));
    const combinedMain: any = await Lead.findById(main._id).lean();
    expect(combinedMain).toMatchObject({ inquiryCount: 3 });
    expect(String(combinedMain.assignedTo)).toBe(String(ids.rep));

    const view: any = await buildLeadConversation(ORG, String(main._id));
    expect(view.combine).toMatchObject({ combined: { count: 1 } });
    expect(view.earlier.leads).toEqual(expect.arrayContaining([expect.objectContaining({ _id: String(older._id), combined: true, previousStatus: 'New' })]));
    const olderView: any = await buildLeadConversation(ORG, String(older._id));
    expect(olderView.combine.combinedInto).toMatchObject({ leadId: String(main._id) });

    const undone = await undoLeadCombine(ORG, String(main._id), admin);
    expect(undone).toEqual({ mainLeadId: String(main._id), restoredLeadIds: [String(older._id)] });
    const restored: any = await Lead.findById(older._id).lean();
    expect(restored.status).toBe('New');
    expect(restored.combinedInto).toBeUndefined();
    expect(restored.statusHistory.at(-1)).toMatchObject({ from: 'Closed', to: 'New', reason: 'Combine undone' });
    expect(await leadOf('appointments', upcoming.insertedId)).toBe(String(older._id));
    expect(await leadOf('aiagenttasks', task.insertedId)).toBe(String(older._id));
    expect(await leadOf('conversations', conversation.insertedId)).toBe(String(older._id));
    const mainAfterUndo: any = await Lead.findById(main._id).lean();
    expect(mainAfterUndo.inquiryCount).toBeUndefined();
    expect(mainAfterUndo.assignedTo).toBeUndefined();
    expect(await LeadIntakeAudit.countDocuments({ organizationId: orgId, event: 'duplicates_uncombined' })).toBe(1);
    await expect(undoLeadCombine(ORG, String(main._id), admin)).rejects.toMatchObject({ statusCode: 404 });
    expect(await runDuplicateCombine(ORG)).toBeNull();
    expect(await Lead.countDocuments({ organizationId: orgId, combinedInto: { $exists: true } })).toBe(0);
  });

  it('fills a missing phone on the main lead from a combined lead, and undo takes it away again', async () => {
    const { orgId, ORG } = await newOrg();
    const phone = nextPhone();
    const email = nextEmail();
    await makeLead(orgId, { phone, email }, { createdAt: daysAgo(2) });
    const main = await makeLead(orgId, { email }, { lastName: 'Pa', createdAt: daysAgo(1) });
    await activate(orgId);
    await runDuplicateCombine(ORG);
    const filled: any = await Lead.findById(main._id).lean();
    expect(filled).toMatchObject({ phone, normalizedPhone: phone, email });
    const record: any = await LeadCombineRecord.findOne({ organizationId: orgId }).lean();
    expect(record.filledContact).toMatchObject({ phone, email: null });
    await undoLeadCombine(ORG, String(main._id), admin);
    const cleared: any = await Lead.findById(main._id).lean();
    expect(cleared.phone).toBeUndefined();
    expect(cleared.normalizedPhone ?? null).toBeNull();
    expect(cleared.email).toBe(email);
  });

  it('never overwrites a phone the main lead already has', async () => {
    const { orgId, ORG } = await newOrg();
    const email = nextEmail();
    const ownPhone = nextPhone();
    await makeLead(orgId, { phone: nextPhone(), email }, { createdAt: daysAgo(2) });
    const main = await makeLead(orgId, { phone: ownPhone, email }, { createdAt: daysAgo(1) });
    await activate(orgId);
    await runDuplicateCombine(ORG);
    expect((await Lead.findById(main._id).lean() as any).phone).toBe(ownPhone);
    expect((await LeadCombineRecord.findOne({ organizationId: orgId }).lean() as any).filledContact).toMatchObject({ phone: null, email: null });
  });

  it('keeps the main lead’s own rep and leaves too-large groups for a manual check', async () => {
    const { orgId, ORG } = await newOrg();
    const phone = nextPhone();
    await makeLead(orgId, { phone }, { createdAt: daysAgo(2), assignedTo: ids.rep });
    const main = await makeLead(orgId, { phone }, { createdAt: daysAgo(1), assignedTo: ids.rep2 });
    const shared = 'shared.inbox@example.com';
    for (let index = 0; index <= MAX_COMBINE_GROUP_SIZE; index += 1) {
      await makeLead(orgId, { email: shared, phone: nextPhone() }, { firstName: `Many${index}` });
    }
    expect(await previewDuplicateLeads(ORG)).toMatchObject({ customers: 1, leads: 1, skippedGroups: 1 });
    await activate(orgId);
    const stats: any = await runDuplicateCombine(ORG);
    expect(stats).toMatchObject({ customers: 1, leadsCombined: 1, skippedGroups: 1 });
    expect(String((await Lead.findById(main._id).lean() as any).assignedTo)).toBe(String(ids.rep2));
    expect(await Lead.countDocuments({ organizationId: orgId, email: shared, combinedInto: { $exists: true } })).toBe(0);
    expect(await LeadCombineRun.findOne({ organizationId: orgId }).lean()).toMatchObject({ state: 'done', skippedGroups: 1 });
  });

  it('never groups leads by a fake email or phone, but still groups them by a real shared detail', async () => {
    const { orgId, ORG } = await newOrg();
    const fakeEmailOnly = [];
    for (let index = 0; index < 3; index += 1) {
      fakeEmailOnly.push(await makeLead(orgId, { email: 'none@none.com', phone: nextPhone() }, { firstName: `Fake${index}` }));
    }
    const sharedRealPhone = nextPhone();
    await makeLead(orgId, { email: 'noemail@gmail.com', phone: sharedRealPhone }, { createdAt: daysAgo(2) });
    const realMain = await makeLead(orgId, { email: 'none@none.com', phone: sharedRealPhone }, { createdAt: daysAgo(1) });
    await makeLead(orgId, { email: nextEmail(), phone: '888-888-8888' }, { firstName: 'FakePhoneA' });
    await makeLead(orgId, { email: nextEmail(), phone: '888-888-8888' }, { firstName: 'FakePhoneB' });
    expect(await previewDuplicateLeads(ORG)).toMatchObject({ customers: 1, leads: 1, skippedGroups: 0 });
    await activate(orgId);
    expect(await runDuplicateCombine(ORG)).toMatchObject({ customers: 1, leadsCombined: 1 });
    expect((await Lead.findById(realMain._id).lean() as any).combinedInto).toBeUndefined();
    expect(await Lead.countDocuments({ organizationId: orgId, combinedInto: { $exists: true } })).toBe(1);
    for (const lead of fakeEmailOnly) {
      expect((await Lead.findById(lead._id).lean() as any)).toMatchObject({ status: 'New' });
    }
    expect(await Lead.countDocuments({ organizationId: orgId, firstName: /^FakePhone/, status: 'New' })).toBe(2);
  });

  it('runs only while matching is On, only once, and only one copy at a time', async () => {
    const { orgId, ORG } = await newOrg();
    const phone = nextPhone();
    await makeLead(orgId, { phone }, { createdAt: daysAgo(2) });
    await makeLead(orgId, { phone }, { createdAt: daysAgo(1) });
    expect(await runDuplicateCombine(ORG)).toBeNull();
    expect(await LeadCombineRun.countDocuments({ organizationId: orgId })).toBe(0);
    await activate(orgId);
    const results = await Promise.all([runDuplicateCombine(ORG), runDuplicateCombine(ORG), runDuplicateCombine(ORG)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await LeadCombineRecord.countDocuments({ organizationId: orgId })).toBe(1);
    expect(await Lead.countDocuments({ organizationId: orgId, combinedInto: { $exists: true } })).toBe(1);
    await makeLead(orgId, { phone: nextPhone(), email: 'later@example.com' }, { createdAt: daysAgo(1) });
    await makeLead(orgId, { email: 'later@example.com' });
    expect(await runDuplicateCombine(ORG)).toBeNull();
    const swept = await runPendingDuplicateCombines();
    expect(swept.some((entry) => entry.organizationId === ORG)).toBe(false);
  });

  it('can be switched off for the whole server', async () => {
    const { orgId, ORG } = await newOrg();
    const phone = nextPhone();
    await makeLead(orgId, { phone });
    await makeLead(orgId, { phone });
    await activate(orgId);
    process.env.LEAD_DUPLICATE_COMBINE = 'off';
    try {
      expect(await runDuplicateCombine(ORG)).toBeNull();
    } finally {
      delete process.env.LEAD_DUPLICATE_COMBINE;
    }
    expect(await LeadCombineRun.countDocuments({ organizationId: orgId })).toBe(0);
  });

  it('combines automatically once when an admin turns matching On, and new inquiries then go to the main lead', async () => {
    const { orgId, ORG } = await newOrg();
    const phone = nextPhone();
    const email = nextEmail();
    await makeLead(orgId, { phone, email }, { createdAt: daysAgo(2) });
    const main = await makeLead(orgId, { phone, email }, { createdAt: daysAgo(1) });
    await setLeadIntakeMode({ organizationId: ORG, mode: 'active', reason: 'turn on', actor: admin });
    let run: any = null;
    for (let attempt = 0; attempt < 50 && run?.state !== 'done'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      run = await LeadCombineRun.findOne({ organizationId: orgId }).lean();
    }
    expect(run).toMatchObject({ state: 'done', leadsCombined: 1 });
    const result: any = await submitLeadInquiry({
      organizationId: ORG, kind: 'provider_inquiry', receivedAt: new Date(), channel: 'adf', source: 'Third-Party Lead',
      contact: { firstName: 'Kiran', lastName: 'Pasupuleti', phone, email }, comments: 'Still available?',
      sourceIds: { providerInquiryKey: `test:${new mongoose.Types.ObjectId()}` },
    } as any);
    expect(result).toMatchObject({ status: 'associated', created: false, leadId: String(main._id), reason: 'single_active_lead' });
  });

  it('lets only admins see the duplicate status and undo a combine', async () => {
    const { orgId, ORG } = await newOrg();
    await CrmUser.collection.insertMany([
      { _id: ids.crmAdmin, organizationId: orgId, fullName: 'Ada Admin', username: `combine-${ids.crmAdmin}`, email: `combine-admin-${orgId}@example.com`, role: 'admin', isActive: true, password: 'x' },
      { _id: ids.crmEmployee, organizationId: orgId, fullName: 'Erin Employee', username: `combine-${ids.crmEmployee}`, email: `combine-emp-${orgId}@example.com`, role: 'employee', isActive: true, password: 'x' },
    ] as any[]);
    tokens.admin = generateCrmToken(String(ids.crmAdmin));
    tokens.employee = generateCrmToken(String(ids.crmEmployee));
    const phone = nextPhone();
    await makeLead(orgId, { phone }, { createdAt: daysAgo(2) });
    const main = await makeLead(orgId, { phone }, { createdAt: daysAgo(1) });

    const before = await request(app).get('/api/crm/lead-intake/duplicates').set(auth('admin'));
    expect(before.status).toBe(200);
    expect(before.body.data).toMatchObject({ run: null, preview: { customers: 1, leads: 1 } });
    expect((await request(app).get('/api/crm/lead-intake/duplicates').set(auth('employee'))).status).toBe(403);

    await activate(orgId);
    await runDuplicateCombine(ORG);
    const after = await request(app).get('/api/crm/lead-intake/duplicates').set(auth('admin'));
    expect(after.body.data).toMatchObject({ run: { state: 'done', customers: 1, leadsCombined: 1 }, preview: null });

    expect((await request(app).post(`/api/crm/lead-intake/leads/${main._id}/undo-combine`).set(auth('employee'))).status).toBe(403);
    const undo = await request(app).post(`/api/crm/lead-intake/leads/${main._id}/undo-combine`).set(auth('admin'));
    expect(undo.status).toBe(200);
    expect(undo.body.data.restoredLeadIds).toHaveLength(1);
    const audit: any = await LeadIntakeAudit.findOne({ organizationId: orgId, event: 'duplicates_uncombined' }).lean();
    expect(audit.actor).toMatchObject({ kind: 'staff', userId: String(ids.crmAdmin) });
    expect((await request(app).post(`/api/crm/lead-intake/leads/${main._id}/undo-combine`).set(auth('admin'))).status).toBe(404);
    await CrmUser.collection.deleteMany({ _id: { $in: [ids.crmAdmin, ids.crmEmployee] } });
  });
});
