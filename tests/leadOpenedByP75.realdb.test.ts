jest.mock('googleapis', () => ({
  google: {
    gmail: jest.fn(() => ({ users: { threads: { get: jest.fn() }, messages: { get: jest.fn(), list: jest.fn(), send: jest.fn(), modify: jest.fn() } } })),
    auth: { OAuth2: jest.fn().mockImplementation(() => ({ setCredentials: jest.fn(), on: jest.fn(), generateAuthUrl: jest.fn(), getToken: jest.fn() })) },
    calendar: jest.fn(() => ({})),
    oauth2: jest.fn(() => ({})),
    drive: jest.fn(() => ({})),
    people: jest.fn(() => ({})),
  },
}));
jest.mock('../src/services/telnyx.service', () => ({
  COMPANY_NUMBER: '+18015550999',
  sendSms: jest.fn().mockResolvedValue({ id: 'out-1' }),
  verifyWebhookSignature: jest.fn(() => true),
}));
jest.mock('../src/utils/socketEmitter', () => ({
  emitToOrg: jest.fn(),
  emitToUser: jest.fn(),
  emitToCrmUser: jest.fn(),
  getSocketIO: () => null,
  streamLogToAdmins: jest.fn(),
}));
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));

import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import Lead from '../src/models/lead.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import leadRoutes from '../src/routes/lead.route';

const app = express();
app.use(express.json());
app.use('/api/leads', leadRoutes);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));

const orgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const ids = {
  owner: new mongoose.Types.ObjectId(),
  maryUser: new mongoose.Types.ObjectId(),
  maryCrm: new mongoose.Types.ObjectId(),
  bethCrm: new mongoose.Types.ObjectId(),
  jomCrm: new mongoose.Types.ObjectId(),
  otherCrm: new mongoose.Types.ObjectId(),
};
const tokens: Record<string, string> = {};
let serial = 0;

const opened = (leadId: unknown, who: string) => request(app).patch(`/api/leads/${leadId}/opened`).set({ Authorization: `Bearer ${tokens[who]}` });
const handlers = (leadId: unknown, who = 'mary') => request(app).get(`/api/leads/${leadId}/handlers`).set({ Authorization: `Bearer ${tokens[who]}` });

async function newLead(extra: Record<string, unknown> = {}) {
  return Lead.create({
    organizationId: orgId, createdBy: ids.owner, firstName: 'Johnny', lastName: `Opened${++serial}`, email: `opened${serial}@example.com`,
    source: 'Website Inquiry', channel: 'web', status: 'New', comments: 'Is the Atlas still available?', ...extra,
  });
}

async function oldLead() {
  const _id = new mongoose.Types.ObjectId();
  await Lead.collection.insertOne({
    _id, organizationId: orgId, createdBy: ids.owner, firstName: 'Old', lastName: `Lead${++serial}`, email: `old${serial}@example.com`,
    source: 'Website Inquiry', channel: 'web', status: 'New', isRead: false, statusHistory: [], notes: [],
    createdAt: new Date('2026-11-01T15:00:00Z'), updatedAt: new Date('2026-11-01T15:00:00Z'),
  } as any);
  return _id;
}

describe('Real-DB: Phase 75 who opened the lead (local MongoDB only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/_test$/.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    await Lead.createIndexes();
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Opened Dealer', slug: `opened-${orgId}`, status: 'active', metadata: {} },
      { _id: otherOrgId, name: 'Other Dealer', slug: `opened-${otherOrgId}`, status: 'active', metadata: {} },
    ] as any[]);
    await User.collection.insertMany([
      { _id: ids.owner, name: 'Olivia Owner', email: `opened-owner-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: orgId, isActive: true },
      { _id: ids.maryUser, name: 'Mary Pinero', email: `mary-${orgId}@example.com`, password: 'x', role: 'employee', organizationId: orgId, isActive: true },
    ] as any[]);
    await CrmUser.collection.insertMany([
      { _id: ids.maryCrm, organizationId: orgId, fullName: 'Mary P.', username: `mary-${ids.maryCrm}`, email: `mary-${orgId}@example.com`, role: 'employee', isActive: true, password: 'x' },
      { _id: ids.bethCrm, organizationId: orgId, fullName: 'Beth Reyes', username: `beth-${ids.bethCrm}`, email: `beth-${orgId}@example.com`, role: 'employee', isActive: true, password: 'x' },
      { _id: ids.jomCrm, organizationId: orgId, fullName: 'Jomalyn Cabillan', username: `jom-${ids.jomCrm}`, email: `jom-${orgId}@example.com`, role: 'admin', isActive: true, password: 'x' },
      { _id: ids.otherCrm, organizationId: otherOrgId, fullName: 'Other Dealer Rep', username: `other-${ids.otherCrm}`, email: `other-${otherOrgId}@example.com`, role: 'employee', isActive: true, password: 'x' },
    ] as any[]);
    tokens.mary = generateCrmToken(String(ids.maryCrm));
    tokens.beth = generateCrmToken(String(ids.bethCrm));
    tokens.jom = generateCrmToken(String(ids.jomCrm));
    tokens.other = generateCrmToken(String(ids.otherCrm));
  });

  afterAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/_test$/.test(dbName) && /127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      await mongoose.connection.db!.dropDatabase();
    }
  });

  it('starts every new lead with an empty opened list and leaves leads from before the update without one', async () => {
    const fresh = await newLead();
    const stored: any = await Lead.collection.findOne({ _id: fresh._id });
    expect(stored.openedBy).toEqual([]);

    const oldId = await oldLead();
    const old: any = await Lead.collection.findOne({ _id: oldId });
    expect(old).not.toHaveProperty('openedBy');
  });

  it('starts a lead made by an upsert (Gmail sync and the ADF webhook with lead intake off) tracked too', async () => {
    const messageId = `upsert-${++serial}`;
    const result: any = await Lead.findOneAndUpdate(
      { organizationId: orgId, messageId },
      { $setOnInsert: { organizationId: orgId, createdBy: ids.owner, firstName: 'Upsert', lastName: `Lead${serial}`, email: `upsert${serial}@example.com`, source: 'Email Inquiry', channel: 'email', messageId } },
      { new: true, upsert: true, includeResultMetadata: true, setDefaultsOnInsert: true },
    );

    const stored: any = await Lead.collection.findOne({ _id: result.value._id });
    expect(stored.openedBy).toEqual([]);
    expect((await opened(result.value._id, 'beth').expect(200)).body).toEqual({ recorded: true });
  });

  it('leaves a lead from before the update untracked when an upsert finds it', async () => {
    const oldId = await oldLead();
    await Lead.collection.updateOne({ _id: oldId }, { $set: { messageId: `old-upsert-${serial}` } });

    await Lead.findOneAndUpdate(
      { organizationId: orgId, messageId: `old-upsert-${serial}` },
      { $setOnInsert: { organizationId: orgId, createdBy: ids.owner, firstName: 'Should', lastName: 'NotInsert' } },
      { new: true, upsert: true, includeResultMetadata: true, setDefaultsOnInsert: true },
    );

    const stored: any = await Lead.collection.findOne({ _id: oldId });
    expect(stored).not.toHaveProperty('openedBy');
    expect(stored.firstName).toBe('Old');
  });

  it('records the first rep who opens a new lead once, with the main account id and name', async () => {
    const lead = await newLead();

    const first = await opened(lead._id, 'mary').expect(200);
    const again = await opened(lead._id, 'mary').expect(200);

    expect(first.body).toEqual({ recorded: true });
    expect(again.body).toEqual({ recorded: false });
    const stored: any = await Lead.findById(lead._id).lean();
    expect(stored.openedBy).toHaveLength(1);
    expect(stored.openedBy[0]).toMatchObject({ userId: String(ids.maryUser), name: 'Mary P.' });
    expect(new Date(stored.openedBy[0].at).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('adds each other rep after the first, and the Handled by data lists them in time order', async () => {
    const lead = await newLead();
    await opened(lead._id, 'jom').expect(200);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await opened(lead._id, 'mary').expect(200);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await opened(lead._id, 'beth').expect(200);
    await opened(lead._id, 'jom').expect(200);

    const res = await handlers(lead._id).expect(200);

    expect(res.body.data.opened.total).toBe(3);
    expect(res.body.data.opened.people.map((person: any) => person.name)).toEqual(['Jomalyn Cabillan', 'Mary Pinero', 'Beth Reyes']);
    const times = res.body.data.opened.people.map((person: any) => new Date(person.at).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('keeps one entry per person when the same lead is opened many times at the same moment', async () => {
    const lead = await newLead();

    const answers = await Promise.all([
      ...Array.from({ length: 5 }, () => opened(lead._id, 'mary')),
      ...Array.from({ length: 5 }, () => opened(lead._id, 'beth')),
    ]);

    expect(answers.every((answer) => answer.status === 200)).toBe(true);
    expect(answers.filter((answer) => answer.body.recorded).length).toBe(2);
    const stored: any = await Lead.findById(lead._id).lean();
    expect(stored.openedBy.map((entry: any) => entry.userId).sort()).toEqual([String(ids.bethCrm), String(ids.maryUser)].sort());
  });

  it('never records an open on a lead from before the update, so no wrong first name appears', async () => {
    const oldId = await oldLead();

    const answer = await opened(oldId, 'mary').expect(200);

    expect(answer.body).toEqual({ recorded: false });
    const stored: any = await Lead.collection.findOne({ _id: oldId });
    expect(stored).not.toHaveProperty('openedBy');
    const res = await handlers(oldId).expect(200);
    expect(res.body.data.opened).toBeNull();
  });

  it('does not let staff of another dealership record an open on this dealership’s lead', async () => {
    const lead = await newLead();

    const answer = await opened(lead._id, 'other');

    expect(answer.body.recorded).not.toBe(true);
    const stored: any = await Lead.findById(lead._id).lean();
    expect(stored.openedBy).toEqual([]);
  });

  it('does not change the lead’s updated time, so the lead does not move in the list', async () => {
    const lead = await newLead();
    await Lead.collection.updateOne({ _id: lead._id }, { $set: { updatedAt: new Date('2026-11-20T15:00:00Z') } });

    await opened(lead._id, 'mary').expect(200);

    const stored: any = await Lead.collection.findOne({ _id: lead._id });
    expect(stored.updatedAt.toISOString()).toBe('2026-11-20T15:00:00.000Z');
    expect(stored.openedBy).toHaveLength(1);
  });

  it('answers 404 for a lead id that is not valid', async () => {
    await opened('not-a-lead', 'mary').expect(404);
  });

  it('shows the saved name when the account is no longer there', async () => {
    const lead = await newLead();
    await Lead.collection.updateOne({ _id: lead._id }, { $set: { openedBy: [{ userId: String(new mongoose.Types.ObjectId()), name: 'Former Rep', at: new Date() }] } });

    const res = await handlers(lead._id).expect(200);

    expect(res.body.data.opened.people).toEqual([expect.objectContaining({ name: 'Former Rep' })]);
  });

  it('sends the opened list with the lead in the lead list and in a single lead, so the website knows when to record', async () => {
    const lead = await newLead();
    await opened(lead._id, 'beth').expect(200);

    const one = await request(app).get(`/api/leads/${lead._id}`).set({ Authorization: `Bearer ${tokens.mary}` }).expect(200);
    const listed = await request(app).get('/api/leads?limit=100').set({ Authorization: `Bearer ${tokens.mary}` }).expect(200);

    const single = one.body.data?.lead || one.body.data || one.body.lead || one.body;
    expect(single.openedBy).toEqual([expect.objectContaining({ userId: String(ids.bethCrm) })]);
    const rows = listed.body.data?.leads || listed.body.leads || [];
    expect(rows.find((row: any) => String(row._id) === String(lead._id))?.openedBy).toEqual([expect.objectContaining({ userId: String(ids.bethCrm) })]);
  });
});
