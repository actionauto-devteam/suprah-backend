jest.mock('../src/services/telnyx.service', () => ({
  COMPANY_NUMBER: '+18015550999',
  sendSms: jest.fn(),
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
import CrmUser from '../src/models/CrmUser.model';
import Lead from '../src/models/lead.model';
import LeadIntakeAudit from '../src/models/LeadIntakeAudit.model';
import LeadCombineRecord from '../src/models/LeadCombineRecord.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import leadIntakeRoutes from '../src/routes/leadIntake.routes';
import { buildLeadConversation, getEarlierConversation } from '../src/services/leadConversation.service';

const app = express();
app.use(express.json());
app.use('/api/crm/lead-intake', leadIntakeRoutes);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));

const orgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const people = {
  admin: new mongoose.Types.ObjectId(),
  manager: new mongoose.Types.ObjectId(),
  managerNoAccess: new mongoose.Types.ObjectId(),
  rep: new mongoose.Types.ObjectId(),
};
const tokens: Record<string, string> = {};
const as = (who: keyof typeof people) => ({ Authorization: `Bearer ${tokens[who]}` });
let serial = 0;
const phone = () => `+1801555${String(4000 + (++serial)).slice(-4)}`;
const email = () => `merge${++serial}@example.com`;
const daysAgo = (days: number) => new Date(Date.now() - days * 86400000);

async function makeLead(extra: Record<string, unknown>, org = orgId) {
  return Lead.create({
    organizationId: org,
    createdBy: people.admin,
    firstName: 'Mara',
    lastName: 'Merge',
    source: 'Email Inquiry',
    channel: 'email',
    status: 'Contacted',
    isRead: true,
    ...extra,
  } as any);
}

const merge = (keep: unknown, body: Record<string, unknown>, who: keyof typeof people = 'admin') =>
  request(app).post(`/api/crm/lead-intake/leads/${keep}/merge`).set(as(who)).send(body);

describe('Real-DB: merging two lead cards by hand (local MongoDB only)', () => {
  beforeAll(async () => {
    await Promise.all([Lead.createIndexes(), LeadIntakeAudit.init(), LeadCombineRecord.init()]);
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Merge Motors', slug: `merge-${orgId}`, status: 'active', metadata: {} },
      { _id: otherOrgId, name: 'Other Motors', slug: `merge-${otherOrgId}`, status: 'active', metadata: {} },
    ] as any[]);
    const crm = (_id: mongoose.Types.ObjectId, fullName: string, role: string, extra: Record<string, unknown> = {}) => ({
      _id, organizationId: orgId, fullName, username: `merge-${_id}`, email: `merge-${_id}@example.com`, role, isActive: true, password: 'x', ...extra,
    });
    await CrmUser.collection.insertMany([
      crm(people.admin, 'Ada Admin', 'admin'),
      crm(people.manager, 'Max Manager', 'manager', { leadReviewAccess: true }),
      crm(people.managerNoAccess, 'Nia Manager', 'manager', { leadReviewAccess: false }),
      crm(people.rep, 'Remy Rep', 'employee'),
    ] as any[]);
    for (const who of Object.keys(people) as Array<keyof typeof people>) tokens[who] = generateCrmToken(String(people[who]));
  });

  it('merges a card with a different phone and email into the card you keep, and shows it under Earlier conversations', async () => {
    const keep = await makeLead({ email: email(), phone: phone(), createdAt: daysAgo(1) });
    const other = await makeLead({ firstName: 'Unknown', lastName: '', email: '', phone: phone(), channel: 'sms', source: 'SMS', status: 'New', createdAt: daysAgo(3) });

    const res = await merge(keep._id, { mergeLeadId: String(other._id), note: 'Same customer, confirmed by phone' });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ mainLeadId: String(keep._id), combinedLeadIds: [String(other._id)] });

    const closed: any = await Lead.findById(other._id).lean();
    expect(closed.status).toBe('Closed');
    expect(closed.combinedInto).toMatchObject({ leadId: keep._id, previousStatus: 'New' });
    const last = closed.statusHistory[closed.statusHistory.length - 1];
    expect(last.reason).toBe(`Merged into lead ${keep._id} by Ada Admin: Same customer, confirmed by phone`);
    expect(String(last.changedBy)).toBe(String(people.admin));

    const kept: any = await Lead.findById(keep._id).lean();
    expect(kept.status).toBe('Contacted');
    expect(kept.phone).toBe(keep.phone);

    const audit: any = await LeadIntakeAudit.findOne({ organizationId: orgId, leadId: keep._id, event: 'duplicates_combined' }).lean();
    expect(audit.actor).toMatchObject({ kind: 'staff', userId: String(people.admin), name: 'Ada Admin' });
    expect(audit.reason).toContain('by hand: Same customer, confirmed by phone');

    const view: any = await buildLeadConversation(ORG, String(keep._id));
    expect(view.combine).toMatchObject({ combined: { count: 1 } });
    expect(view.earlier.available).toBe(true);
    expect(view.earlier.leads.map((entry: any) => entry._id)).toContain(String(other._id));
    const opened: any = await getEarlierConversation(ORG, String(keep._id), String(other._id));
    expect(opened.lead).toMatchObject({ _id: String(other._id), status: 'Closed' });
  });

  it('keeps the card you chose even when the other card is newer', async () => {
    const keep = await makeLead({ email: email(), createdAt: daysAgo(10) });
    const newer = await makeLead({ email: email(), createdAt: daysAgo(1) });
    const res = await merge(keep._id, { mergeLeadId: String(newer._id) });
    expect(res.status).toBe(200);
    expect(res.body.data.mainLeadId).toBe(String(keep._id));
    expect((await Lead.findById(keep._id).lean() as any).combinedInto).toBeUndefined();
    expect(String((await Lead.findById(newer._id).lean() as any).combinedInto.leadId)).toBe(String(keep._id));
  });

  it('lets a manager with lead review access merge, but not a rep or a manager without that access', async () => {
    const keep = await makeLead({ email: email() });
    const other = await makeLead({ email: email() });
    expect((await merge(keep._id, { mergeLeadId: String(other._id) }, 'rep')).status).toBe(403);
    expect((await merge(keep._id, { mergeLeadId: String(other._id) }, 'managerNoAccess')).status).toBe(403);
    expect((await Lead.findById(other._id).lean() as any).status).toBe('Contacted');
    const res = await merge(keep._id, { mergeLeadId: String(other._id) }, 'manager');
    expect(res.status).toBe(200);
    const audit: any = await LeadIntakeAudit.findOne({ organizationId: orgId, leadId: keep._id, event: 'duplicates_combined' }).lean();
    expect(audit.actor).toMatchObject({ kind: 'staff', name: 'Max Manager' });
  });

  it('refuses the same card, a card from another dealership, a card already merged, an unverified chat or a bad id', async () => {
    const keep = await makeLead({ email: email() });
    const foreign = await makeLead({ email: email() }, otherOrgId);
    const already = await makeLead({ email: email() });
    const target = await makeLead({ email: email() });
    expect((await merge(target._id, { mergeLeadId: String(already._id) })).status).toBe(200);
    const chat = await makeLead({ email: email(), channel: 'webchat', intakeIdentity: 'unverified' });

    const same = await merge(keep._id, { mergeLeadId: String(keep._id) });
    expect(same.status).toBe(400);
    expect(same.body.message).toBe('Pick a different lead.');
    expect((await merge(keep._id, { mergeLeadId: String(foreign._id) })).status).toBe(404);
    const merged = await merge(keep._id, { mergeLeadId: String(already._id) });
    expect(merged.status).toBe(409);
    expect(merged.body.message).toBe('One of these leads was already merged into another lead. Open that lead instead.');
    const unverified = await merge(keep._id, { mergeLeadId: String(chat._id) });
    expect(unverified.status).toBe(409);
    expect(unverified.body.message).toBe('This is an unverified chat. Use Link to a lead instead.');
    expect((await merge(keep._id, { mergeLeadId: 'nope' })).status).toBe(400);
    expect((await merge(keep._id, {})).status).toBe(400);

    const untouched: any = await Lead.find({ _id: { $in: [keep._id, foreign._id, chat._id] } }).lean();
    expect(untouched.every((lead: any) => !lead.combinedInto && lead.status === 'Contacted')).toBe(true);
  });

  it('an admin can undo a merge made by hand, and both cards come back as they were', async () => {
    const keep = await makeLead({ email: email(), phone: phone() });
    const other = await makeLead({ email: email(), phone: phone(), status: 'Pending' });
    expect((await merge(keep._id, { mergeLeadId: String(other._id) }, 'manager')).status).toBe(200);
    expect((await request(app).post(`/api/crm/lead-intake/leads/${keep._id}/undo-combine`).set(as('manager'))).status).toBe(403);
    const undo = await request(app).post(`/api/crm/lead-intake/leads/${keep._id}/undo-combine`).set(as('admin'));
    expect(undo.status).toBe(200);
    expect(undo.body.data.restoredLeadIds).toEqual([String(other._id)]);
    const restored: any = await Lead.findById(other._id).lean();
    expect(restored.status).toBe('Pending');
    expect(restored.combinedInto).toBeUndefined();
    const view: any = await buildLeadConversation(ORG, String(keep._id));
    expect((view.earlier?.leads || []).map((entry: any) => entry._id)).not.toContain(String(other._id));
  });
});
