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
import Notification from '../src/models/Notification.model';
import { Conversation, CommunicationMessage } from '../src/models/communication.model';
import { generateCrmToken } from '../src/middleware/crmAuth.middleware';
import tokenService from '../src/services/token.service';
import leadIntakeRoutes from '../src/routes/leadIntake.routes';
import { submitLeadInquiry, recoverLeadIntake, LeadIntakeRequest } from '../src/services/leadIntake.service';
import { setLeadIntakeMode, clearLeadIntakeModeCache } from '../src/services/leadIntakeControl.service';
import { recordInquiryEvent, claimInquiryProcessing } from '../src/services/leadInquiry.service';
import { resolveContactRestriction } from '../src/services/contactRestriction.service';
import { triggerAiReplyForNewInquiry } from '../src/services/communication.service';

const app = express();
app.use(express.json());
app.use('/api/crm/lead-intake', leadIntakeRoutes);
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode || 500).json({ message: error.message }));

const orgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const OTHER = String(otherOrgId);
const ids = {
  owner: new mongoose.Types.ObjectId(),
  rep: new mongoose.Types.ObjectId(),
  otherOwner: new mongoose.Types.ObjectId(),
  crmAdmin: new mongoose.Types.ObjectId(),
  crmEmployee: new mongoose.Types.ObjectId(),
  superAdmin: new mongoose.Types.ObjectId(),
};
const admin = { userId: String(ids.crmAdmin), name: 'Ada Admin' };
let serial = 0;
const nextPhone = () => `+1801555${String(1000 + (++serial)).slice(-4)}`;
const nextEmail = () => `customer${++serial}@example.com`;

function inquiry(contact: { phone?: string; email?: string; firstName?: string }, extra: Partial<LeadIntakeRequest> = {}): LeadIntakeRequest {
  return {
    organizationId: ORG,
    kind: 'provider_inquiry',
    receivedAt: new Date(),
    channel: 'adf',
    source: 'Third-Party Lead',
    sourceProvider: 'AutoTrader',
    contact: { firstName: contact.firstName || 'Pat', lastName: 'Lee', phone: contact.phone, email: contact.email },
    vehicle: { year: '2021', make: 'Toyota', model: 'Tacoma' },
    comments: 'Is it still available?',
    sourceIds: { providerInquiryKey: `autotrader:${new mongoose.Types.ObjectId()}` },
    ...extra,
  };
}

async function openLead(contact: { phone?: string; email?: string }, extra: Record<string, unknown> = {}) {
  const lead = await Lead.create({
    organizationId: orgId, createdBy: ids.owner, firstName: 'Pat', lastName: 'Lee', phone: contact.phone, email: contact.email,
    source: 'Manual Entry', channel: 'sms', status: 'New', ...extra,
  });
  return lead;
}

const leadsFor = (filter: Record<string, unknown>) => Lead.countDocuments({ organizationId: orgId, ...filter });

async function setMode(mode: 'off' | 'active' | 'paused') {
  await setLeadIntakeMode({ organizationId: ORG, mode, reason: `test ${mode}`, actor: admin });
}

describe('Real-DB: lead intake lifecycle (local MongoDB only)', () => {
  beforeAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (!/test/i.test(dbName) || !/127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      throw new Error(`Refusing to run against ${mongoose.connection.host}/${dbName}`);
    }
    await Promise.all([Lead.createIndexes(), LeadInquiry.init(), LeadIntakeControl.init(), LeadIntakeAudit.init()]);
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Intake Dealer', slug: `intake-${orgId}`, status: 'active', metadata: {} },
      { _id: otherOrgId, name: 'Other Dealer', slug: `intake-${otherOrgId}`, status: 'active', metadata: {} },
    ] as any[]);
    await User.collection.insertMany([
      { _id: ids.owner, name: 'Olivia Owner', email: `intake-owner-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: orgId, isActive: true },
      { _id: ids.rep, name: 'Ryan Rep', email: `intake-rep-${orgId}@example.com`, password: 'x', role: 'employee', organizationId: orgId, isActive: true },
      { _id: ids.otherOwner, name: 'Other Owner', email: `intake-other-${orgId}@example.com`, password: 'x', role: 'admin', organizationRole: 'admin', organizationId: otherOrgId, isActive: true },
      { _id: ids.superAdmin, name: 'Sky Platform', email: `intake-super-${orgId}@example.com`, password: 'x', role: 'super_admin', organizationRole: 'admin', organizationId: orgId, isActive: true },
    ] as any[]);
    await CrmUser.collection.insertMany([
      { _id: ids.crmAdmin, organizationId: orgId, fullName: 'Ada Admin', username: `intake-${ids.crmAdmin}`, email: `intake-crm-admin-${orgId}@example.com`, role: 'admin', isActive: true, password: 'x' },
      { _id: ids.crmEmployee, organizationId: orgId, fullName: 'Erin Employee', username: `intake-${ids.crmEmployee}`, email: `intake-crm-emp-${orgId}@example.com`, role: 'employee', isActive: true, password: 'x' },
    ] as any[]);
  });

  beforeEach(() => {
    clearLeadIntakeModeCache();
    mockSendSms.mockReset();
  });

  afterAll(async () => {
    const dbName = mongoose.connection.db?.databaseName || '';
    if (/test/i.test(dbName) && /127\.0\.0\.1|localhost/.test(String(mongoose.connection.host))) {
      await mongoose.connection.db!.dropDatabase();
    }
  });

  it('does nothing and records nothing while lifecycle intake is off', async () => {
    const before = await LeadInquiry.countDocuments({});
    const result = await submitLeadInquiry(inquiry({ phone: nextPhone(), email: nextEmail() }));
    expect(result).toEqual({ status: 'inactive' });
    expect(await LeadInquiry.countDocuments({})).toBe(before);
  });

  it('only organization admins can change intake, a reason is required, and every change is audited', async () => {
    const employee = generateCrmToken(String(ids.crmEmployee));
    const crmAdmin = generateCrmToken(String(ids.crmAdmin));
    const superAdmin = tokenService.generateAccessToken({ _id: ids.superAdmin, email: `intake-super-${orgId}@example.com`, role: 'super_admin', organizationId: orgId });
    const put = (token: string, body: Record<string, unknown>) =>
      request(app).put('/api/crm/lead-intake/control').set('Authorization', `Bearer ${token}`).send(body);

    expect((await put(employee, { mode: 'active', reason: 'go' })).status).toBe(403);
    expect((await put(superAdmin, { mode: 'active', reason: 'go' })).status).toBe(403);
    expect((await put(crmAdmin, { mode: 'active' })).status).toBe(400);
    expect((await put(crmAdmin, { mode: 'turbo', reason: 'go' })).status).toBe(400);
    const ok = await put(crmAdmin, { mode: 'active', reason: 'Release day' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ mode: 'active', previousMode: 'off', canManage: true });
    const read = await request(app).get('/api/crm/lead-intake/control').set('Authorization', `Bearer ${employee}`);
    expect(read.body.data).toMatchObject({ mode: 'active', canManage: false });
    const audit: any = await LeadIntakeAudit.findOne({ organizationId: orgId, event: 'intake_mode_changed', toMode: 'active' }).lean();
    expect(audit).toMatchObject({ fromMode: 'off', reason: 'Release day', actor: { kind: 'staff', userId: String(ids.crmAdmin) } });
    await expect(LeadIntakeAudit.deleteOne({ _id: audit._id })).rejects.toThrow();
  });

  it('creates a lead when nobody matches and tells the admins once', async () => {
    const phone = nextPhone();
    const email = nextEmail();
    const result: any = await submitLeadInquiry(inquiry({ phone, email }));
    expect(result).toMatchObject({ status: 'associated', created: true, reason: 'no_matching_lead' });
    const lead: any = await Lead.findById(result.leadId).lean();
    expect(lead).toMatchObject({ status: 'New', inquiryCount: 1, sourceProvider: 'AutoTrader', sourceInquiryId: new mongoose.Types.ObjectId(result.inquiryId) });
    expect(lead.intakeSlots).toEqual(expect.arrayContaining([`phone:${phone}|first`, `email:${email}|first`]));
    expect(await Notification.countDocuments({ type: 'new_lead', 'metadata.inquiryId': result.inquiryId })).toBeGreaterThanOrEqual(1);
  });

  it('adds a new inquiry from the same customer to the open lead and tells the assigned rep', async () => {
    const phone = nextPhone();
    const email = nextEmail();
    const lead = await openLead({ phone, email }, { assignedTo: ids.rep, isRead: true });
    const result: any = await submitLeadInquiry(inquiry({ phone, email }, { vehicle: { year: '2019', make: 'Ford', model: 'F-150' } }));
    expect(result).toMatchObject({ status: 'associated', created: false, leadId: String(lead._id), reason: 'single_active_lead' });
    const updated: any = await Lead.findById(lead._id).lean();
    expect(updated).toMatchObject({ inquiryCount: 2, isRead: false, phone, email });
    expect(updated.vehicle?.make).not.toBe('Ford');
    expect(await leadsFor({ phone })).toBe(1);
    const event: any = await LeadInquiry.findById(result.inquiryId).lean();
    expect(event).toMatchObject({ association: { state: 'associated', outcome: 'appended' }, vehicle: { make: 'Ford' } });
    expect(await Notification.countDocuments({ type: 'lead_new_inquiry', userId: ids.rep, 'metadata.inquiryId': result.inquiryId })).toBe(1);
  });

  it('treats a missing email as no conflict', async () => {
    const phone = nextPhone();
    const lead = await openLead({ phone, email: nextEmail() });
    const result: any = await submitLeadInquiry(inquiry({ phone }));
    expect(result).toMatchObject({ status: 'associated', created: false, leadId: String(lead._id) });
  });

  it('creates a separate normal lead when the phone matches but the email is different, without touching the other lead', async () => {
    const phone = nextPhone();
    const existingEmail = nextEmail();
    const lead = await openLead({ phone, email: existingEmail });
    const result: any = await submitLeadInquiry(inquiry({ phone, email: nextEmail() }));
    expect(result).toMatchObject({ status: 'associated', created: true, reason: 'contact_conflict_separate_lead' });
    expect(result.leadId).not.toBe(String(lead._id));
    expect((await Lead.findById(lead._id).lean() as any)).toMatchObject({ email: existingEmail, phone });
    const fresh: any = await Lead.findById(result.leadId).lean();
    expect(fresh.status).toBe('New');
    expect(fresh.intakeSlots).not.toEqual(expect.arrayContaining([`phone:${phone}|first`]));
  });

  it('creates a separate normal lead when the email matches but the phone is different', async () => {
    const email = nextEmail();
    const lead = await openLead({ phone: nextPhone(), email });
    const result: any = await submitLeadInquiry(inquiry({ phone: nextPhone(), email }));
    expect(result).toMatchObject({ status: 'associated', created: true, reason: 'contact_conflict_separate_lead' });
    expect(result.leadId).not.toBe(String(lead._id));
  });

  it('starts a fresh lead after the earlier lead closed and leaves the closed lead untouched', async () => {
    const phone = nextPhone();
    const email = nextEmail();
    const closedAt = new Date(Date.now() - 86400000);
    const old = await openLead({ phone, email }, {
      status: 'Closed', isRead: true, inquiryCount: 1,
      statusHistory: [{ from: 'New', to: 'Closed', changedAt: closedAt, changedBy: ids.owner }],
    });
    const result: any = await submitLeadInquiry(inquiry({ phone, email }));
    expect(result).toMatchObject({ status: 'associated', created: true, reason: 'previous_lead_finished' });
    const untouched: any = await Lead.findById(old._id).lean();
    expect(untouched).toMatchObject({ status: 'Closed', isRead: true, inquiryCount: 1 });
    const fresh: any = await Lead.findById(result.leadId).lean();
    expect(fresh.intakeSlots).toEqual(expect.arrayContaining([`phone:${phone}|after:${old._id}@${closedAt.getTime()}`]));
    const again: any = await submitLeadInquiry(inquiry({ phone, email }));
    expect(again).toMatchObject({ status: 'associated', created: false, leadId: result.leadId });
  });

  it('keeps active financing statuses open', async () => {
    const phone = nextPhone();
    const email = nextEmail();
    const lead = await openLead({ phone, email }, { status: 'In Finance' });
    const result: any = await submitLeadInquiry(inquiry({ phone, email }));
    expect(result).toMatchObject({ status: 'associated', created: false, leadId: String(lead._id) });
  });

  it('sends a customer with two open leads to review and tells the admins, without creating anything', async () => {
    const phone = nextPhone();
    const email = nextEmail();
    await openLead({ phone, email });
    await openLead({ phone, email });
    const before = await leadsFor({ phone });
    const result: any = await submitLeadInquiry(inquiry({ phone, email }));
    expect(result).toMatchObject({ status: 'review', reason: 'multiple_active_leads' });
    expect(await leadsFor({ phone })).toBe(before);
    const event: any = await LeadInquiry.findById(result.inquiryId).lean();
    expect(event).toMatchObject({ association: { state: 'pending_review' }, review: { state: 'pending', kind: 'unassigned' } });
    expect(event.review.candidateLeadIds).toHaveLength(2);
    expect(await Notification.countDocuments({ type: 'lead_inquiry_review', 'metadata.inquiryId': result.inquiryId })).toBeGreaterThanOrEqual(1);
  });

  it('ignores repeated deliveries of the same provider inquiry', async () => {
    const phone = nextPhone();
    const email = nextEmail();
    const key = `autotrader:${new mongoose.Types.ObjectId()}`;
    const first: any = await submitLeadInquiry(inquiry({ phone, email }, { sourceIds: { providerInquiryKey: key } }));
    const notified = await Notification.countDocuments({ type: 'new_lead', 'metadata.inquiryId': first.inquiryId });
    const second: any = await submitLeadInquiry(inquiry({ phone, email }, { sourceIds: { providerInquiryKey: key } }));
    await recoverLeadIntake({ organizationId: ORG });
    expect(second).toMatchObject({ status: 'duplicate', leadId: first.leadId });
    expect(await LeadInquiry.countDocuments({ 'sourceIds.providerInquiryKey': key })).toBe(1);
    expect((await Lead.findById(first.leadId).lean() as any).inquiryCount).toBe(1);
    expect(notified).toBeGreaterThanOrEqual(1);
    expect(await Notification.countDocuments({ type: 'new_lead', 'metadata.inquiryId': first.inquiryId })).toBe(notified);
    const perUser = await Notification.aggregate([{ $match: { type: 'new_lead', 'metadata.inquiryId': first.inquiryId } }, { $group: { _id: '$userId', n: { $sum: 1 } } }]);
    expect(perUser.every((row: any) => row.n === 1)).toBe(true);
  });

  it('handles the same retry arriving at the same moment as one inquiry and one lead', async () => {
    const phone = nextPhone();
    const email = nextEmail();
    const key = `cars:${new mongoose.Types.ObjectId()}`;
    const results = await Promise.all([1, 2, 3].map(() => submitLeadInquiry(inquiry({ phone, email }, { sourceIds: { providerInquiryKey: key } }))));
    expect(await LeadInquiry.countDocuments({ 'sourceIds.providerInquiryKey': key })).toBe(1);
    expect(await leadsFor({ phone })).toBe(1);
    expect(results.filter((result: any) => result.status === 'associated')).toHaveLength(1);
  });

  it('handles several different inquiries from one new customer at the same moment as one lead', async () => {
    const phone = nextPhone();
    const email = nextEmail();
    await Promise.all([1, 2, 3, 4, 5].map(() => submitLeadInquiry(inquiry({ phone, email }))));
    await recoverLeadIntake({ organizationId: ORG });
    expect(await leadsFor({ phone })).toBe(1);
    const lead: any = await Lead.findOne({ organizationId: orgId, phone }).lean();
    expect(lead.inquiryCount).toBe(5);
    expect(await LeadInquiry.countDocuments({ 'contact.normalizedPhone': phone, 'association.state': 'associated' })).toBe(5);
  });

  it('keeps inquiries safe while paused and replays them when intake is resumed', async () => {
    const phone = nextPhone();
    const email = nextEmail();
    await setMode('paused');
    const held: any = await submitLeadInquiry(inquiry({ phone, email }));
    expect(held.status).toBe('held');
    expect(await leadsFor({ phone })).toBe(0);
    expect((await LeadInquiry.findById(held.inquiryId).lean() as any).processing.state).toBe('pending');
    await setMode('active');
    for (let i = 0; i < 50 && !(await leadsFor({ phone })); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    await recoverLeadIntake({ organizationId: ORG });
    expect(await leadsFor({ phone })).toBe(1);
    expect((await LeadInquiry.findById(held.inquiryId).lean() as any).association.state).toBe('associated');
  });

  it('finishes an inquiry whose worker stopped halfway', async () => {
    const phone = nextPhone();
    const { event } = await recordInquiryEvent({ ...inquiry({ phone, email: nextEmail() }), leadDraft: null } as any);
    await claimInquiryProcessing(event._id, 'crashed-worker', { leaseMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stats = await recoverLeadIntake({ organizationId: ORG });
    expect(stats.processed).toBeGreaterThanOrEqual(1);
    expect(await leadsFor({ phone })).toBe(1);
  });

  it('moves an inquiry that keeps failing to review instead of dropping it', async () => {
    const { event } = await recordInquiryEvent(inquiry({ phone: nextPhone(), email: nextEmail() }));
    await LeadInquiry.updateOne({ _id: event._id }, { $set: { 'processing.state': 'failed', 'processing.attempts': 5, 'processing.lastError': 'boom' } });
    const stats = await recoverLeadIntake({ organizationId: ORG });
    expect(stats.movedToReview).toBeGreaterThanOrEqual(1);
    expect((await LeadInquiry.findById(event._id).lean() as any)).toMatchObject({ association: { state: 'pending_review', reason: 'processing_failed' }, review: { state: 'pending' } });
    expect(await LeadIntakeAudit.countDocuments({ inquiryId: event._id, event: 'inquiry_moved_to_review' })).toBe(1);
  });

  it('keeps an unverified chat separate, marks it as a possible match, and never adds verified inquiries to it', async () => {
    const phone = nextPhone();
    const email = nextEmail();
    const real = await openLead({ phone, email });
    const chat: any = await submitLeadInquiry(inquiry({ phone, email }, {
      kind: 'webchat_session', channel: 'webchat', source: 'Website Chat', intakePolicy: 'isolate',
      sourceIds: { webchatSessionId: new mongoose.Types.ObjectId() },
    }));
    expect(chat).toMatchObject({ status: 'associated', created: true, reason: 'unverified_contact_kept_separate' });
    expect((await Lead.findById(chat.leadId).lean() as any).intakeIdentity).toBe('unverified');
    expect((await LeadInquiry.findById(chat.inquiryId).lean() as any).review).toMatchObject({ state: 'pending', kind: 'possible_match' });
    const provider: any = await submitLeadInquiry(inquiry({ phone, email }));
    expect(provider).toMatchObject({ status: 'associated', created: false, leadId: String(real._id) });
  });

  it('sends a customer email reply on a closed lead to review and drops automated replies', async () => {
    const email = nextEmail();
    const closed = await openLead({ phone: nextPhone(), email }, { status: 'Closed', statusHistory: [{ from: 'New', to: 'Closed', changedAt: new Date(), changedBy: ids.owner }] });
    const reply: any = await submitLeadInquiry(inquiry({ email }, {
      kind: 'email_reply', channel: 'email', contextLeadId: closed._id, subject: 'Re: your Tacoma',
      sourceIds: { gmailMessageId: `gmail-${new mongoose.Types.ObjectId()}` },
    }));
    expect(reply).toMatchObject({ status: 'review', reason: 'reply_after_lead_closed' });
    const auto: any = await submitLeadInquiry(inquiry({ email: 'no-reply@example.com' }, {
      kind: 'email_reply', channel: 'email', contextLeadId: closed._id, subject: 'Automatic reply: Out of office',
      sourceIds: { gmailMessageId: `gmail-${new mongoose.Types.ObjectId()}` },
    }));
    expect(auto).toMatchObject({ status: 'dismissed', reason: 'automated_email' });
    expect(await leadsFor({ email })).toBe(1);
  });

  it('never matches a lead in another organization', async () => {
    const phone = nextPhone();
    const email = nextEmail();
    await Lead.create({ organizationId: otherOrgId, createdBy: ids.otherOwner, firstName: 'Pat', lastName: 'Lee', phone, email, source: 'Manual Entry', status: 'New' });
    const result: any = await submitLeadInquiry(inquiry({ phone, email }));
    expect(result).toMatchObject({ status: 'associated', created: true, reason: 'no_matching_lead' });
    expect(await Lead.countDocuments({ organizationId: otherOrgId, phone })).toBe(1);
    expect(OTHER).not.toBe(ORG);
  });

  it('keeps a Do Not Contact customer restricted on the fresh lead', async () => {
    const phone = nextPhone();
    const email = nextEmail();
    await openLead({ phone, email }, { status: 'Do Not Contact', statusHistory: [{ from: 'New', to: 'Do Not Contact', changedAt: new Date(), changedBy: ids.owner }] });
    const result: any = await submitLeadInquiry(inquiry({ phone, email }));
    expect(result).toMatchObject({ status: 'associated', created: true });
    expect(await resolveContactRestriction({ organizationId: ORG, leadId: result.leadId, phone })).toMatchObject({ status: 'restricted' });
  });

  it('S3: a new inquiry with a phone that cannot be texted creates no text conversation, and valid ones are marked as inquiries', async () => {
    const badPhone = '801-555-0142 x12';
    const badLead = await openLead({ phone: badPhone, email: nextEmail() });
    await triggerAiReplyForNewInquiry(ORG, badLead.toObject(), badPhone, 'Is the Tacoma available?');
    expect(await CommunicationMessage.countDocuments({ leadId: badLead._id })).toBe(0);
    const goodPhone = nextPhone();
    const goodLead = await openLead({ phone: goodPhone, email: nextEmail() });
    await triggerAiReplyForNewInquiry(ORG, goodLead.toObject(), goodPhone, 'Is the Tacoma available?');
    const message: any = await CommunicationMessage.findOne({ leadId: goodLead._id }).lean();
    expect(message).toMatchObject({ direction: 'inbound', origin: 'inquiry' });
    expect(await Conversation.countDocuments({ customerPhone: goodPhone })).toBe(1);
    expect(mockSendSms).not.toHaveBeenCalled();
  });
});
