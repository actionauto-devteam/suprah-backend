const mockNotifyUsers = jest.fn().mockResolvedValue(undefined);
jest.mock('../src/utils/safeNotification', () => ({
  notifyUsers: (...args: unknown[]) => mockNotifyUsers(...args),
  notifyOrgAdmins: jest.fn().mockResolvedValue(undefined),
  safeCreateNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/utils/socketEmitter', () => ({
  emitToOrg: jest.fn(),
  emitToUser: jest.fn(),
  emitToCrmUser: jest.fn(),
  streamLogToAdmins: jest.fn(),
  getSocketIO: () => null,
}));
jest.mock('../src/services/activity.service', () => ({
  __esModule: true,
  default: { createActivity: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../src/services/unifiedPush.service', () => ({ __esModule: true, default: { sendToUser: jest.fn().mockResolvedValue({}) } }));

import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import CrmLeadGroup from '../src/models/CrmLeadGroup.model';
import Lead from '../src/models/lead.model';
import LeadMention from '../src/models/LeadMention.model';
import { addLeadNote } from '../src/controllers/lead.controller';
import { completeLeadMentionsHandler, getLeadMentionCountHandler, listLeadMentionsHandler } from '../src/controllers/leadMention.controller';
import { addLeadNoteAndNotify } from '../src/utils/leadNote';
import { notifyLeadPeople } from '../src/services/leadNoticeRouting.service';
import { forgetMentionViewers, runLeadMentionBackfill } from '../src/services/leadMention.service';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import leadRoutes from '../src/routes/lead.route';

const app = express();
app.use(express.json());
app.use('/api/leads', leadRoutes);

const id = () => new mongoose.Types.ObjectId();
const DAY = 24 * 60 * 60 * 1000;
const orgId = id();
const otherOrgId = id();
const historyOrgId = id();
const ORG = String(orgId);
const people = { owner: id(), amy: id(), ben: id(), cal: id(), eve: id(), dee: id(), hal: id(), ivy: id() };
const crm = { owner: id(), amy: id(), ben: id(), dee: id() };
const salesTeam = id();
const historyTeam = id();
const leads = { pat: id(), sam: id(), open: id(), gone: id(), history: id(), historyOld: id() };
const email = (name: string) => `${name}-${orgId}@mentions.example.com`;
const crmUser = (name: 'owner' | 'amy' | 'ben' | 'dee') => ({
  _id: crm[name],
  fullName: { owner: 'Olivia Owner', amy: 'Amy Reyes', ben: 'Ben Cruz', dee: 'Dee Other' }[name],
  email: email(name),
  role: name === 'owner' ? 'admin' : 'employee',
});

function fakeRes() {
  return {
    statusCode: 200,
    body: null as any,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
}

async function writeNote(author: 'owner' | 'amy' | 'ben', leadId: mongoose.Types.ObjectId, note: string, mentions: { users?: unknown[]; groups?: unknown[] }) {
  const res = fakeRes();
  await addLeadNote({
    params: { id: String(leadId) },
    body: { note, mentionedUserIds: (mentions.users || []).map(String), mentionedGroupIds: (mentions.groups || []).map(String) },
    orgId: ORG,
    crmUser: crmUser(author),
  } as any, res as any);
  return res;
}

async function list(viewer: 'owner' | 'amy' | 'ben' | 'dee', query: Record<string, unknown> = {}, org = ORG) {
  const res = fakeRes();
  await listLeadMentionsHandler({ orgId: org, crmUser: crmUser(viewer), query } as any, res as any);
  return res.body?.data;
}

async function count(viewer: 'owner' | 'amy' | 'ben' | 'dee', org = ORG) {
  const res = fakeRes();
  await getLeadMentionCountHandler({ orgId: org, crmUser: crmUser(viewer) } as any, res as any);
  return res.body?.data?.count;
}

async function complete(viewer: 'owner' | 'amy' | 'ben' | 'dee', body: Record<string, unknown>) {
  const res = fakeRes();
  await completeLeadMentionsHandler({ orgId: ORG, crmUser: crmUser(viewer), body } as any, res as any);
  return res.body?.data?.completed;
}

async function rowsFor(noteId: unknown) {
  return LeadMention.find({ noteId }).lean();
}

describe('Real-DB: Mentioned list (local MongoDB only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/_test$/.test(dbName) || mongoose.connection.host !== '127.0.0.1') throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    await Promise.all([Lead.createIndexes(), LeadMention.init()]);
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Mention Motors', slug: `mention-${orgId}`, status: 'active', metadata: { aiHandoffFallbackGroupId: String(salesTeam), aiAgentName: 'Anna' } },
      { _id: otherOrgId, name: 'Other Motors', slug: `mention-other-${otherOrgId}`, status: 'active', metadata: {} },
      { _id: historyOrgId, name: 'History Motors', slug: `mention-history-${historyOrgId}`, status: 'active', metadata: {} },
    ] as any[]);
    const user = (key: keyof typeof people, name: string, org: mongoose.Types.ObjectId, extra: Record<string, unknown> = {}) => ({
      _id: people[key], name, email: email(key), password: 'x', role: key === 'owner' ? 'admin' : 'employee', organizationRole: key === 'owner' ? 'admin' : 'employee',
      organizationId: org, isActive: true, ...extra,
    });
    await User.collection.insertMany([
      user('owner', 'Olivia Owner', orgId),
      user('amy', 'Amy Reyes', orgId),
      user('ben', 'Ben Cruz', orgId),
      user('cal', 'Cal Inactive', orgId, { isActive: false }),
      user('eve', 'Eve Later', orgId),
      user('dee', 'Dee Other', otherOrgId),
      user('hal', 'Hal History', historyOrgId),
      user('ivy', 'Ivy History', historyOrgId),
    ] as any[]);
    await CrmUser.collection.insertMany([
      { _id: crm.owner, organizationId: orgId, fullName: 'Olivia Owner', username: `mention-owner-${orgId}`, email: email('owner'), role: 'admin', isActive: true, permissions: [] },
      { _id: crm.amy, organizationId: orgId, fullName: 'Amy Reyes', username: `mention-amy-${orgId}`, email: email('amy'), role: 'employee', isActive: true, permissions: [] },
      { _id: crm.ben, organizationId: orgId, fullName: 'Ben Cruz', username: `mention-ben-${orgId}`, email: email('ben'), role: 'employee', isActive: true, permissions: [] },
      { _id: crm.dee, organizationId: otherOrgId, fullName: 'Dee Other', username: `mention-dee-${orgId}`, email: email('dee'), role: 'employee', isActive: true, permissions: [] },
    ] as any[]);
    await CrmLeadGroup.collection.insertMany([
      { _id: salesTeam, organizationId: orgId, name: 'Sales', memberIds: [people.amy, people.ben, people.cal], isActive: true, createdAt: new Date(), updatedAt: new Date() },
      { _id: historyTeam, organizationId: historyOrgId, name: 'Floor', memberIds: [people.hal, people.ivy], isActive: true, createdAt: new Date(), updatedAt: new Date() },
    ] as any[]);
    const lead = (_id: mongoose.Types.ObjectId, firstName: string, lastName: string, org = orgId, extra: Record<string, unknown> = {}) => ({
      _id, organizationId: org, createdBy: people.owner, firstName, lastName, phone: '+18015550100', email: `${firstName.toLowerCase()}@customer.example.com`,
      status: 'New', source: 'Manual Entry', channel: 'sms', notes: [], createdAt: new Date(), updatedAt: new Date(), ...extra,
    });
    await Lead.collection.insertMany([
      lead(leads.pat, 'Pat', 'Lee'),
      lead(leads.sam, 'Sam', 'Stone'),
      lead(leads.open, 'Olga', 'Open'),
      lead(leads.gone, 'Gina', 'Gone'),
    ] as any[]);
  });

  beforeEach(() => {
    mockNotifyUsers.mockClear();
    forgetMentionViewers();
  });

  it('a note that mentions a person adds it to that person, not to the writer, and the bell link opens that note', async () => {
    const res = await writeNote('owner', leads.pat, '@Ben Cruz can you call Pat back today?', { users: [people.ben] });
    expect(res.statusCode).toBe(201);
    const noteId = res.body.data.note._id;

    const rows = await rowsFor(noteId);
    expect(rows.map((row: any) => [String(row.userId), row.via])).toEqual([[String(people.ben), 'person']]);
    expect(rows[0]).toMatchObject({ authorName: 'Olivia Owner', text: '@Ben Cruz can you call Pat back today?', completedAt: null });
    const metadata = mockNotifyUsers.mock.calls[0][5];
    expect(metadata.route).toBe(`/crm/leads?leadId=${leads.pat}&note=${noteId}`);
  });

  it('a team mention adds every active member at that moment, but not the writer and not inactive members', async () => {
    const res = await writeNote('amy', leads.sam, '@Sales who can take Sam? He wants a test drive.', { groups: [salesTeam] });
    const noteId = res.body.data.note._id;

    const rows = await rowsFor(noteId);
    expect(rows.map((row: any) => [String(row.userId), row.via, row.groupName])).toEqual([[String(people.ben), 'team', 'Sales']]);

    await CrmLeadGroup.updateOne({ _id: salesTeam }, { $addToSet: { memberIds: people.eve } });
    expect((await rowsFor(noteId)).map((row: any) => String(row.userId))).not.toContain(String(people.eve));
    await CrmLeadGroup.updateOne({ _id: salesTeam }, { $pull: { memberIds: people.eve } });
  });

  it("Anna's handoff that tags the rep and the team is listed; the automatic team tag for notices is not", async () => {
    const { note } = await addLeadNoteAndNotify({
      organizationId: ORG, leadId: String(leads.pat), text: '@Amy Reyes @Sales the customer wants a person to call about financing.',
      authorType: 'ai', authorName: 'Anna', mentionedUserIds: [String(people.amy)], mentionedGroupIds: [String(salesTeam)], suppressNotification: true,
    });
    const rows = await rowsFor((note as any)._id);
    expect(rows.map((row: any) => [String(row.userId), row.via]).sort()).toEqual([[String(people.amy), 'person'], [String(people.ben), 'team']].sort());

    await notifyLeadPeople({ organizationId: ORG, leadId: leads.open, type: 'new_lead', title: 'New lead', message: 'Olga Open asked about a truck.' });
    const tagged: any = await Lead.findById(leads.open).lean();
    const tag = (tagged.notes || []).find((entry: any) => entry.authorType === 'ai' && entry.mentionedGroupIds?.length);
    expect(tag).toBeTruthy();
    expect(await rowsFor(tag._id)).toHaveLength(0);
  });

  it('the same note sent twice in a row does not add the mention twice', async () => {
    const first = await writeNote('owner', leads.sam, '@Ben Cruz please confirm Saturday.', { users: [people.ben] });
    const again = await writeNote('owner', leads.sam, '@Ben Cruz please confirm Saturday.', { users: [people.ben] });
    expect(again.body.data.duplicate).toBe(true);
    expect(await rowsFor(first.body.data.note._id)).toHaveLength(1);
    expect(await LeadMention.countDocuments({ leadId: leads.sam, userId: people.ben, text: '@Ben Cruz please confirm Saturday.' })).toBe(1);
  });

  it('each person sees only their own mentions, newest first, with the customer and who wrote it', async () => {
    const ben = await list('ben');
    expect(ben.status).toBe('new');
    expect(ben.items.map((item: any) => item.text)).toEqual([
      '@Ben Cruz please confirm Saturday.',
      '@Amy Reyes @Sales the customer wants a person to call about financing.',
      '@Sales who can take Sam? He wants a test drive.',
      '@Ben Cruz can you call Pat back today?',
    ]);
    expect(ben.items[1]).toMatchObject({ customerName: 'Pat Lee', authorName: 'Anna', authorType: 'ai', via: 'team', teamName: 'Sales', leadId: String(leads.pat) });
    expect(ben.items[2]).toMatchObject({ customerName: 'Sam Stone', authorName: 'Amy Reyes', via: 'team' });
    expect(await count('ben')).toBe(4);

    const amy = await list('amy');
    expect(amy.items.map((item: any) => item.text)).toEqual(['@Amy Reyes @Sales the customer wants a person to call about financing.']);
    expect((await list('owner')).items).toEqual([]);
    expect((await list('dee', {}, String(otherOrgId))).items).toEqual([]);
    expect(await count('dee', String(otherOrgId))).toBe(0);

    const found = await list('ben', { q: 'stone' });
    expect(found.items.map((item: any) => item.customerName)).toEqual(['Sam Stone', 'Sam Stone']);
    expect((await list('ben', { q: 'financing' })).items).toHaveLength(1);
    expect((await list('ben', { q: 'Sam Stone' })).items.map((item: any) => item.customerName)).toEqual(['Sam Stone', 'Sam Stone']);
    expect((await list('ben', { q: 'pat lee' })).items.map((item: any) => item.customerName)).toEqual(['Pat Lee', 'Pat Lee']);
    expect((await list('ben', { q: '(801) 555-0100' })).items).toHaveLength(4);
    expect((await list('ben', { q: '801-555-0100' })).items).toHaveLength(4);
    expect((await list('ben', { q: 'Sam Lee' })).items).toHaveLength(0);
  });

  it('opening a mention completes it; a note link completes it; "Mark all as completed" completes the rest, only for that person', async () => {
    const before = await list('ben');
    const [first, second] = before.items;

    expect(await complete('ben', { mentionId: first.id })).toBe(1);
    expect(await count('ben')).toBe(3);
    expect((await list('ben', { status: 'completed' })).items.map((item: any) => item.id)).toEqual([first.id]);
    expect(await complete('ben', { mentionId: first.id })).toBe(0);

    expect(await complete('ben', { noteId: second.noteId })).toBe(1);
    expect(await count('amy')).toBe(1);

    const shown = await list('ben');
    expect(shown.items).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeNote('owner', leads.open, '@Ben Cruz Olga just called back.', { users: [people.ben] });
    expect(await complete('ben', { all: true, before: shown.asOf })).toBe(2);
    expect(await count('ben')).toBe(1);
    expect((await list('ben')).items.map((item: any) => item.text)).toEqual(['@Ben Cruz Olga just called back.']);
    expect(await complete('ben', { all: true })).toBe(1);
    expect(await count('ben')).toBe(0);
    expect((await list('ben', { status: 'all' })).items).toHaveLength(5);
    expect(await count('amy')).toBe(1);
    expect(await complete('ben', {})).toBe(0);
  });

  it('mentions on a deleted lead are not shown, are removed when the list opens, and the page is still full', async () => {
    await writeNote('owner', leads.gone, '@Ben Cruz look at this one.', { users: [people.ben] });
    await writeNote('owner', leads.gone, '@Ben Cruz and at this one too.', { users: [people.ben] });
    expect(await count('ben')).toBe(2);
    await Lead.deleteOne({ _id: leads.gone });
    const firstPage = await list('ben', { status: 'all', limit: 2 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.items.map((item: any) => item.customerName)).not.toContain('Gina Gone');
    expect(firstPage).toMatchObject({ total: 5, pages: 3 });
    expect(await LeadMention.countDocuments({ leadId: leads.gone })).toBe(0);
    expect(await count('ben')).toBe(0);
  });

  it('the list and the count are reachable through the lead routes', async () => {
    const token = generateCrmToken(String(crm.ben));
    const counted = await request(app).get('/api/leads/mentions/count').set('Authorization', `Bearer ${token}`).expect(200);
    expect(counted.body.data.count).toBe(0);
    const listed = await request(app).get('/api/leads/mentions?status=all').set('Authorization', `Bearer ${token}`).expect(200);
    expect(listed.body.data.items.length).toBeGreaterThan(0);
    await request(app).post('/api/leads/mentions/complete').set('Authorization', `Bearer ${token}`).send({ all: true }).expect(200);
  });

  it('the one-time fill adds past mentions: older than 7 days start as completed, the automatic team tag is left out, and running it again adds nothing', async () => {
    const now = new Date();
    const note = (text: string, daysAgo: number, extra: Record<string, unknown>) => ({
      _id: id(), text, createdAt: new Date(now.getTime() - daysAgo * DAY), authorType: 'user', authorName: 'Hal History', mentionedUserIds: [], mentionedGroupIds: [], ...extra,
    });
    const anna = { authorType: 'ai', authorName: 'Anna', mentionedGroupIds: [historyTeam] };
    const old = note('@Ivy History old note', 10, { createdBy: people.hal, mentionedUserIds: [people.ivy] });
    const recent = note('@Floor please help', 2, { createdBy: people.hal, mentionedGroupIds: [historyTeam] });
    const teamTag = note('@Floor, a new lead came in.', 1, anna);
    const attentionTag = note('@Floor, a new lead came in by text.', 1.5, anna);
    const handoff = note('@Floor the customer asked for a person.', 1, { ...anna, sourceTaskId: id() });
    const teamHandoff = note('@Floor, The customer wants to talk about financing. Topic: Finance.', 3, anna);
    const combinedHandoff = note('@Floor, Customer wants a trade-in value.', 2, anna);
    await Lead.collection.insertMany([
      {
        _id: leads.history, organizationId: historyOrgId, createdBy: people.hal, firstName: 'Hank', lastName: 'Past', phone: '+18015550199',
        status: 'New', source: 'Manual Entry', channel: 'sms', notes: [old, recent, teamTag, attentionTag, handoff, teamHandoff], createdAt: now, updatedAt: now,
      },
      {
        _id: leads.historyOld, organizationId: historyOrgId, createdBy: people.hal, firstName: 'Hank', lastName: 'Past', phone: '+18015550199',
        status: 'Closed', source: 'Manual Entry', channel: 'sms', notes: [combinedHandoff], combinedInto: { leadId: leads.history, at: now, previousStatus: 'New' },
        createdAt: now, updatedAt: now,
      },
    ] as any[]);
    const task = (leadId: mongoose.Types.ObjectId, question: string, near: { createdAt: Date }, seconds: number, extra: Record<string, unknown> = {}) => {
      const createdAt = new Date(near.createdAt.getTime() + seconds * 1000);
      return { organizationId: String(historyOrgId), leadId, channel: 'sms', status: 'pending', question, createdAt, updatedAt: createdAt, ...extra };
    };
    await mongoose.connection.db!.collection('aiagenttasks').insertMany([
      task(leads.history, 'Financing question', teamTag, -20),
      task(leads.history, 'a new lead came in', teamTag, 5),
      task(leads.history, 'a new lead came in by text', attentionTag, -10, { attentionKind: 'customer' }),
      task(leads.history, 'the customer wants to talk about financing', teamHandoff, -10),
      task(leads.history, 'Customer wants a trade-in value', combinedHandoff, -10),
    ]);

    const preview = await runLeadMentionBackfill({ apply: false, organizationId: String(historyOrgId), now });
    expect(preview).toMatchObject({ leads: 2, notes: 5, skippedTeamTags: 2, people: 8, startNew: 7, startCompleted: 1, alreadySaved: 0, saved: 0 });
    expect(await LeadMention.countDocuments({ leadId: { $in: [leads.history, leads.historyOld] } })).toBe(0);

    const applied = await runLeadMentionBackfill({ apply: true, organizationId: String(historyOrgId), now });
    expect(applied.saved).toBe(8);
    const saved: any[] = await LeadMention.find({ leadId: { $in: [leads.history, leads.historyOld] } }).lean();
    const peopleFor = (entry: { _id: unknown }) => saved.filter((row) => String(row.noteId) === String(entry._id)).map((row) => String(row.userId)).sort();
    const floor = [String(people.hal), String(people.ivy)].sort();
    expect(saved.filter((row) => String(row.noteId) === String(old._id)).map((row) => [String(row.userId), Boolean(row.completedAt)])).toEqual([[String(people.ivy), true]]);
    expect(peopleFor(recent)).toEqual([String(people.ivy)]);
    expect(peopleFor(handoff)).toEqual(floor);
    expect(peopleFor(teamHandoff)).toEqual(floor);
    expect(peopleFor(combinedHandoff)).toEqual(floor);
    expect(peopleFor(teamTag)).toEqual([]);
    expect(peopleFor(attentionTag)).toEqual([]);
    expect(saved.filter((row) => !row.completedAt)).toHaveLength(7);

    const again = await runLeadMentionBackfill({ apply: true, organizationId: String(historyOrgId), now });
    expect(again).toMatchObject({ people: 0, alreadySaved: 8, saved: 0 });
  });
});
