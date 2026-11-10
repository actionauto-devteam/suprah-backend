const mockSendSms = jest.fn();
const mockNotifyUsers = jest.fn();
const mockNotifyOrgAdmins = jest.fn();

jest.mock('../src/services/telnyx.service', () => {
  const actual = jest.requireActual('../src/services/telnyx.service');
  return { ...actual, COMPANY_NUMBER: '+18015550900', sendSms: (...args: unknown[]) => mockSendSms(...args) };
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
  notifyOrgAdmins: (...args: unknown[]) => mockNotifyOrgAdmins(...args),
  notifyUsers: (...args: unknown[]) => mockNotifyUsers(...args),
  safeCreateNotification: jest.fn().mockResolvedValue(undefined),
}));

import mongoose from 'mongoose';
import config from '../src/config';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import CrmUser from '../src/models/CrmUser.model';
import Lead from '../src/models/lead.model';
import Customer from '../src/models/Customer.model';
import Appointment from '../src/models/Appointment.model';
import AiAgentTask from '../src/models/AiAgentTask.model';
import CrmLeadGroup from '../src/models/CrmLeadGroup.model';
import CrmDeal from '../src/models/CrmDeal.model';
import CustomerFeedback from '../src/models/CustomerFeedback.model';
import CustomerSupportRequest from '../src/models/CustomerSupportRequest.model';
import CrmAutomation from '../src/models/CrmAutomation.model';
import CrmAutomationRun from '../src/models/CrmAutomationRun.model';
import DealershipPhoneNumber from '../src/models/DealershipPhoneNumber.model';
import { CallLog, CommunicationMessage, Conversation } from '../src/models/communication.model';
import { createFeedbackRequest, discardFeedbackRequest, getPublicFeedback, listCustomerFeedback, submitPublicFeedback } from '../src/services/customerFeedback.service';
import { createSupportRequest, listSupportRequests, updateSupportRequest } from '../src/services/customerSupportRequest.service';
import { addDealOffer, createDeal, deleteDeal, listDeals, searchDealLeads, updateDeal } from '../src/services/crmDeal.service';
import { createAutomation, getAutomationOptions } from '../src/services/crmAutomation.service';
import { runDueSteps } from '../src/services/crmAutomationEngine.service';
import { resolveCrmStaff } from '../src/utils/crmStaff';
import { sendReviewRequestText } from '../src/services/communication.service';

const DAY = 24 * 60 * 60 * 1000;
const orgId = new mongoose.Types.ObjectId();
const org = String(orgId);
const otherOrgId = new mongoose.Types.ObjectId();
const adminId = new mongoose.Types.ObjectId();
const managerId = new mongoose.Types.ObjectId();
const rep1 = new mongoose.Types.ObjectId();
const rep2 = new mongoose.Types.ObjectId();
const rep3 = new mongoose.Types.ObjectId();
const crmRep2 = new mongoose.Types.ObjectId();
const customerId = new mongoose.Types.ObjectId();
const otherCustomerId = new mongoose.Types.ObjectId();
const actor = { userId: String(adminId), name: 'Avery Admin' };
let phoneSeq = 100;
const nextPhone = () => `+1801555${String(4200 + phoneSeq++).padStart(4, '0')}`;

async function lead(overrides: Record<string, any> = {}) {
  const phone = overrides.phone || nextPhone();
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    organizationId: orgId,
    firstName: 'Rosa',
    lastName: 'Diaz',
    phone,
    normalizedPhone: phone,
    email: `${phone.slice(-4)}@example.com`,
    channel: 'web',
    source: 'Website Inquiry',
    status: 'Contacted',
    vehicle: { year: '2021', make: 'Toyota', model: 'RAV4', vin: '2T3P1RFV0MW000001', stock: 'A123' },
    statusHistory: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  await Lead.collection.insertOne(doc as any);
  return doc;
}

const crmUserOf = (id: mongoose.Types.ObjectId, role: string, name: string, email: string) => ({ _id: id, role, fullName: name, email });

async function runSteps(steps: any[], opts: { event?: string; eventKey?: string; leadId?: string | null; appointmentId?: string | null; mode?: 'live' | 'test'; phone?: string; name?: string } = {}) {
  const mode = opts.mode || 'live';
  const auto = await CrmAutomation.create({
    organizationId: org,
    name: 'Phase 42 test',
    locations: { mode: 'all', ids: [] },
    trigger: { source: 'suprah', event: opts.event || 'call_ended', filters: [], repeat: { mode: 'every_time', days: null, per: [] }, sendingHours: 'any_time', stopOnReply: false, cancelFirstOnReply: false, aiContinuesOnReply: false, stopOnFailure: false },
    steps,
    status: mode === 'test' ? 'test' : 'active',
    createdBy: actor,
    updatedBy: actor,
  });
  const run = await CrmAutomationRun.create({
    organizationId: org,
    automationId: auto._id,
    automationName: auto.name,
    mode,
    event: opts.event || 'call_ended',
    eventKey: opts.eventKey || `${opts.event || 'call_ended'}:${new mongoose.Types.ObjectId()}`,
    triggerAt: new Date(),
    appointmentId: opts.appointmentId || null,
    contact: { leadId: opts.leadId ?? null, name: opts.name || 'Rosa Diaz', firstName: 'Rosa', phone: opts.phone || '', email: '' },
    settings: { sendingHours: 'any_time', stopOnReply: false, cancelFirstOnReply: false, aiContinuesOnReply: false, stopOnFailure: false },
    steps,
    status: 'waiting',
    nextRunAt: new Date(Date.now() - 1000),
  });
  await runDueSteps(new Date());
  return CrmAutomationRun.findById(run._id).lean() as Promise<any>;
}

async function cleanup() {
  await Promise.all([
    Organization.collection.deleteMany({ _id: { $in: [orgId, otherOrgId] } }),
    User.collection.deleteMany({ organizationId: { $in: [orgId, otherOrgId] } }),
    CrmUser.collection.deleteMany({ organizationId: { $in: [orgId, otherOrgId] } }),
    Lead.collection.deleteMany({ organizationId: { $in: [orgId, otherOrgId] } }),
    Customer.collection.deleteMany({ organizationId: { $in: [org, String(otherOrgId)] } }),
    Appointment.collection.deleteMany({ organizationId: org }),
    AiAgentTask.collection.deleteMany({ organizationId: org }),
    CrmLeadGroup.collection.deleteMany({ organizationId: { $in: [orgId, otherOrgId] } }),
    CrmDeal.collection.deleteMany({ organizationId: { $in: [org, String(otherOrgId)] } }),
    CustomerFeedback.collection.deleteMany({ organizationId: org }),
    CustomerSupportRequest.collection.deleteMany({ organizationId: { $in: [org, String(otherOrgId)] } }),
    CrmAutomation.collection.deleteMany({ organizationId: org }),
    CrmAutomationRun.collection.deleteMany({ organizationId: org }),
    DealershipPhoneNumber.collection.deleteMany({ organizationId: orgId }),
    CallLog.collection.deleteMany({ orgId: { $in: [org, orgId] } }),
    Conversation.collection.deleteMany({ orgId: { $in: [org, orgId] } }),
    CommunicationMessage.collection.deleteMany({ orgId: { $in: [org, orgId] } }),
  ]);
}

describe('Real-DB proof: Phase 42 feedback, support, deals and assign steps (local test DB only)', () => {
  let previousFrontend: string;

  beforeAll(async () => {
    if (mongoose.connection.host !== '127.0.0.1' || mongoose.connection.port !== 27018 || !/_test$/.test(mongoose.connection.name)) throw new Error('Local test DB only');
    process.env.CRM_AUTOMATIONS_ENABLED = 'true';
    previousFrontend = (config as any).frontendUrl;
    (config as any).frontendUrl = 'https://suprah.test/';
    await cleanup();
    await Promise.all([CustomerFeedback.init(), CrmDeal.init(), CustomerSupportRequest.init()]);
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Phase 42 Motors', slug: `p42-${orgId}`, status: 'active', metadata: { reviewLink: 'https://g.page/r/p42-review' } },
      { _id: otherOrgId, name: 'Other Motors', slug: `p42-other-${otherOrgId}`, status: 'active' },
    ] as any[]);
    await User.collection.insertMany([
      { _id: adminId, organizationId: orgId, name: 'Avery Admin', email: `admin-${adminId}@example.com`, role: 'admin', isActive: true },
      { _id: managerId, organizationId: orgId, name: 'Morgan Manager', email: `manager-${managerId}@example.com`, role: 'employee', organizationRole: 'manager', isActive: true },
      { _id: rep1, organizationId: orgId, name: 'Riley One', email: `rep1-${rep1}@example.com`, role: 'employee', isActive: true },
      { _id: rep2, organizationId: orgId, name: 'Sam Two', email: `rep2-${rep2}@example.com`, role: 'employee', isActive: true },
      { _id: rep3, organizationId: orgId, name: 'Gone Three', email: `rep3-${rep3}@example.com`, role: 'employee', isActive: false },
    ] as any[]);
    await CrmUser.collection.insertOne({ _id: crmRep2, organizationId: orgId, fullName: 'Sam Two', username: `sam-${crmRep2}`, email: `rep2-${rep2}@example.com`, password: 'x', role: 'employee', isActive: true } as any);
    await Customer.collection.insertMany([
      { _id: customerId, organizationId: org, firstName: 'Rosa', lastName: 'Diaz', email: 'rosa@example.com', phone: '+18015554000', source: 'lead', isActive: true, transactions: [], conversations: [], stats: {} },
      { _id: otherCustomerId, organizationId: String(otherOrgId), firstName: 'Olly', lastName: 'Other', email: 'olly@example.com', phone: '+18015554001', source: 'lead', isActive: true, transactions: [], conversations: [], stats: {} },
    ] as any[]);
    await DealershipPhoneNumber.collection.insertOne({ organizationId: orgId, number: '+18015550951', label: 'Main line', kind: 'location', location: 'Orem', department: '', createdBy: adminId, updatedBy: adminId, createdAt: new Date(), updatedAt: new Date() } as any);
  });

  beforeEach(() => {
    mockSendSms.mockReset().mockResolvedValue({ id: `sms-${Date.now()}` });
    mockNotifyUsers.mockReset().mockResolvedValue(undefined);
    mockNotifyOrgAdmins.mockReset().mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await cleanup();
    (config as any).frontendUrl = previousFrontend;
    delete process.env.CRM_AUTOMATIONS_ENABLED;
  });

  it('1. a feedback link saves the rating on the customer, and 1-2 stars creates one task for managers only once', async () => {
    const linked = await lead({ customerId, phone: '+18015554000' });
    const request = await createFeedbackRequest({ organizationId: org, leadId: linked._id, channel: 'sms', source: 'appointment', name: 'Rosa Diaz', phone: linked.phone, reviewLink: 'https://g.page/r/p42-review' });
    expect(request?.url).toMatch(/^https:\/\/suprah\.test\/feedback\/[A-Za-z0-9_-]{20,}$/);
    const token = request!.url.split('/').pop()!;
    const stored: any = await CustomerFeedback.findById(request!.id).lean();
    expect(stored.tokenHash).not.toBe(token);
    expect(String(stored.customerId)).toBe(String(customerId));

    const view = await getPublicFeedback(token);
    expect(view).toMatchObject({ dealershipName: 'Phase 42 Motors', firstName: 'Rosa', reviewLink: 'https://g.page/r/p42-review', rating: null, expired: false });
    expect(JSON.stringify(view)).not.toContain(linked.phone);

    const happy = await submitPublicFeedback(token, { rating: 5, comment: 'Great service' });
    expect(happy).toMatchObject({ rating: 5, reviewLink: 'https://g.page/r/p42-review' });
    expect(await AiAgentTask.countDocuments({ organizationId: org })).toBe(0);

    const unhappy = await submitPublicFeedback(token, { rating: 2, comment: 'Waited too long' });
    expect(unhappy.reviewLink).toBe('https://g.page/r/p42-review');
    const tasks: any[] = await AiAgentTask.find({ organizationId: org }).lean();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].question).toContain('2 stars');
    expect(tasks[0].question).toContain('Waited too long');
    expect(mockNotifyOrgAdmins).toHaveBeenCalledTimes(1);
    expect(mockNotifyOrgAdmins.mock.calls[0][4]).toMatchObject({ route: `/crm/customers/${customerId}` });

    await submitPublicFeedback(token, { rating: 1, comment: 'Still upset' });
    expect(await AiAgentTask.countDocuments({ organizationId: org })).toBe(1);
    expect(mockNotifyOrgAdmins).toHaveBeenCalledTimes(1);

    const list = await listCustomerFeedback(org, String(customerId));
    expect(list).toMatchObject({ average: 1, answered: 1, requested: 1 });
    expect(list.items[0]).toMatchObject({ status: 'answered', rating: 1, comment: 'Still upset', lowRating: true });
  });

  it('2. feedback links reject bad input, expired links and unknown tokens, and an unused request can be thrown away', async () => {
    const request = await createFeedbackRequest({ organizationId: org, channel: 'email', source: 'appointment', name: 'Nia' });
    const token = request!.url.split('/').pop()!;
    await expect(submitPublicFeedback(token, { rating: 7 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(submitPublicFeedback(token, { rating: 4, comment: 'x'.repeat(2001) })).rejects.toMatchObject({ statusCode: 400 });
    await expect(getPublicFeedback('not-a-real-token-123456')).rejects.toMatchObject({ statusCode: 404 });
    await expect(getPublicFeedback('../etc')).rejects.toMatchObject({ statusCode: 404 });
    await CustomerFeedback.updateOne({ _id: request!.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await getPublicFeedback(token)).expired).toBe(true);
    await expect(submitPublicFeedback(token, { rating: 4 })).rejects.toMatchObject({ statusCode: 410 });

    const unused = await createFeedbackRequest({ organizationId: org, channel: 'sms', source: 'automation' });
    await discardFeedbackRequest(unused!.id);
    expect(await CustomerFeedback.exists({ _id: unused!.id })).toBeNull();
  });

  it('3. the automation review invitation texts the feedback link, and a blocked text leaves no request behind', async () => {
    const open = await lead({ firstName: 'Fay' });
    const sent = await runSteps([{ id: 'r1', type: 'send_review_invitation', config: { timing: { when: 'on', amount: null, unit: null }, assignTo: null } }], { event: 'appointment_completed', leadId: String(open._id), phone: open.phone, name: 'Fay Diaz' });
    expect(sent.log[0]).toMatchObject({ type: 'send_review_invitation', status: 'sent' });
    expect(sent.log[0].detail).toMatch(/https:\/\/suprah\.test\/feedback\/[A-Za-z0-9_-]+/);
    expect(await CustomerFeedback.countDocuments({ automationRunId: String(sent._id), status: 'requested' })).toBe(1);

    const dnc = await lead({ firstName: 'Dee', status: 'Do Not Contact', statusHistory: [{ from: 'New', to: 'Do Not Contact', changedAt: new Date(Date.now() - DAY) }] });
    const blocked = await runSteps([{ id: 'r2', type: 'send_review_invitation', config: { timing: { when: 'on', amount: null, unit: null }, assignTo: null } }], { event: 'appointment_completed', leadId: String(dnc._id), phone: dnc.phone });
    expect(blocked.log[0].status).toBe('skipped');
    expect(await CustomerFeedback.countDocuments({ automationRunId: String(blocked._id) })).toBe(0);

    const preview = await runSteps([{ id: 'r3', type: 'send_review_invitation', config: { timing: { when: 'on', amount: null, unit: null }, assignTo: null } }], { event: 'appointment_completed', leadId: String(open._id), phone: open.phone, mode: 'test' });
    expect(preview.log[0]).toMatchObject({ status: 'test' });
    expect(preview.log[0].detail).toContain('https://suprah.test/feedback/(link)');
    expect(await CustomerFeedback.countDocuments({ automationRunId: String(preview._id) })).toBe(0);
  });

  it('3b. the review text after a completed appointment carries the feedback link and keeps the request only when it was sent', async () => {
    const booked = await lead({ firstName: 'Ava', customerId });
    const appointment = { _id: new mongoose.Types.ObjectId(), organizationId: org, leadId: booked._id, customerBooking: { firstName: 'Ava', lastName: 'Diaz', phone: booked.phone, email: 'ava@example.com' } };
    expect(await sendReviewRequestText(appointment)).toBe(true);
    expect(mockSendSms).toHaveBeenCalledTimes(1);
    const body = JSON.stringify(mockSendSms.mock.calls[0]);
    expect(body).toMatch(/https:\/\/suprah\.test\/feedback\/[A-Za-z0-9_-]+/);
    expect(body).not.toContain('g.page');
    const saved: any = await CustomerFeedback.findOne({ appointmentId: appointment._id }).lean();
    expect(saved).toMatchObject({ source: 'appointment', channel: 'sms', status: 'requested', reviewLink: 'https://g.page/r/p42-review' });
    expect(String(saved.customerId)).toBe(String(customerId));

    mockSendSms.mockReset().mockRejectedValue(new Error('carrier down'));
    const failing = { ...appointment, _id: new mongoose.Types.ObjectId() };
    await expect(sendReviewRequestText(failing)).rejects.toBeTruthy();
    expect(await CustomerFeedback.exists({ appointmentId: failing._id })).toBeNull();
  });

  it('4. support requests track type, status, assignee and notes, notify the assignee, and stay inside the organization', async () => {
    const staff = await resolveCrmStaff(org, crmUserOf(adminId, 'admin', 'Avery Admin', `admin-${adminId}@example.com`));
    await expect(createSupportRequest(org, String(customerId), staff, { details: 'Key fob' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(createSupportRequest(org, String(customerId), staff, { type: 'warranty', details: '  ' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(createSupportRequest(org, String(customerId), staff, { type: 'warranty', details: 'Noise', assignedTo: String(rep3) })).rejects.toMatchObject({ statusCode: 400 });
    await expect(createSupportRequest(org, String(otherCustomerId), staff, { type: 'warranty', details: 'Noise' })).rejects.toMatchObject({ statusCode: 404 });

    const created = await createSupportRequest(org, String(customerId), staff, { type: 'vehicle_problem', details: 'Check engine light came on', assignedTo: String(rep1) });
    expect(created).toMatchObject({ status: 'open', typeLabel: 'Vehicle problem', assignedName: 'Riley One' });
    expect(mockNotifyUsers).toHaveBeenCalledWith([String(rep1)], org, 'crm_task_assigned', 'Support request assigned to you', expect.stringContaining('Rosa Diaz'), expect.objectContaining({ route: `/crm/customers/${customerId}?tab=support` }));

    const moved = await updateSupportRequest(org, String(customerId), created.id, staff, { status: 'waiting_on_customer', assignedTo: String(rep2), note: 'Asked for a photo of the dash' });
    expect(moved).toMatchObject({ status: 'waiting_on_customer', assignedName: 'Sam Two' });
    expect(moved.history.map((entry: any) => entry.action)).toEqual(['created', 'assigned', 'status', 'assigned', 'note']);
    const resolved = await updateSupportRequest(org, String(customerId), created.id, staff, { status: 'resolved' });
    expect(resolved.resolvedAt).not.toBeNull();
    await expect(updateSupportRequest(org, String(customerId), created.id, staff, { status: 'closed' })).rejects.toMatchObject({ statusCode: 400 });

    const list = await listSupportRequests(org, String(customerId));
    expect(list.items).toHaveLength(1);
    expect(list.team.map((member) => member.name)).toEqual(expect.arrayContaining(['Riley One', 'Sam Two']));
    expect(list.team.map((member) => member.name)).not.toContain('Gone Three');
    await expect(updateSupportRequest(String(otherOrgId), String(customerId), created.id, staff, { status: 'open' })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('5. deals hide amounts from everyone except managers, admins and the owner, and only they can change them', async () => {
    const linked = await lead({ customerId, assignedTo: rep1 });
    const manager = await resolveCrmStaff(org, crmUserOf(managerId, 'manager', 'Morgan Manager', `manager-${managerId}@example.com`));
    const owner = await resolveCrmStaff(org, crmUserOf(rep1, 'employee', 'Riley One', `rep1-${rep1}@example.com`));
    const other = await resolveCrmStaff(org, crmUserOf(crmRep2, 'employee', 'Sam Two', `rep2-${rep2}@example.com`));
    expect(other.userId).toBe(String(rep2));

    const deal = await createDeal(org, manager, { leadId: String(linked._id), amount: 24500 });
    expect(deal).toMatchObject({ title: 'Rosa Diaz - 2021 Toyota RAV4', assignedTo: String(rep1), amount: 24500, amountsVisible: true, customerId: String(customerId) });
    expect(deal.vehicle).toMatchObject({ vin: '2T3P1RFV0MW000001', stock: 'A123' });

    const offered = await addDealOffer(org, owner, deal.id, { amount: 23000, from: 'customer', note: 'Wants floor mats' });
    expect(offered.offers[0]).toMatchObject({ amount: 23000, from: 'customer', note: 'Wants floor mats' });

    const hidden = (await listDeals(org, other, {})).items.find((item) => item.id === deal.id)!;
    expect(hidden).toMatchObject({ amountsVisible: false, canEdit: false, amount: null });
    expect(hidden.offers[0]).toMatchObject({ amount: null, note: '' });
    expect(JSON.stringify(hidden)).not.toContain('24500');
    expect(JSON.stringify(hidden)).not.toContain('23000');
    await expect(updateDeal(org, other, deal.id, { stage: 'working' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(addDealOffer(org, other, deal.id, { amount: 1, from: 'customer' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(updateDeal(org, owner, deal.id, { assignedTo: String(rep2) })).rejects.toMatchObject({ statusCode: 403 });
    await expect(deleteDeal(org, owner, deal.id)).rejects.toMatchObject({ statusCode: 403 });

    const ownDeal = await createDeal(org, other, { leadId: String(linked._id), title: 'Second look', amount: 100 });
    expect(ownDeal).toMatchObject({ assignedTo: String(rep2), amountsVisible: true, amount: 100 });
    expect((await listDeals(org, other, { mine: 'true' })).items.map((item) => item.id)).toEqual([ownDeal.id]);
    const unlinked = { userId: null, actorId: String(new mongoose.Types.ObjectId()), name: 'No Link', role: 'employee' as const };
    await CrmDeal.create({ organizationId: org, leadId: linked._id, title: 'Unowned', stage: 'new', history: [], createdBy: { userId: 'x', name: 'x', kind: 'staff' } });
    expect((await listDeals(org, unlinked, { mine: 'true' })).items).toEqual([]);
    await CrmDeal.deleteOne({ title: 'Unowned', organizationId: org });
    expect((await listDeals(org, manager, { customerId: String(customerId) })).items).toHaveLength(2);
    expect((await listDeals(String(otherOrgId), manager, {})).items).toHaveLength(0);
    await deleteDeal(org, manager, ownDeal.id);
    expect(await CrmDeal.exists({ _id: ownDeal.id })).toBeNull();
  });

  it('6. Won can mark the lead Sold, never for a Do Not Contact lead, and Lost needs a reason', async () => {
    const manager = await resolveCrmStaff(org, crmUserOf(managerId, 'manager', 'Morgan Manager', `manager-${managerId}@example.com`));
    const open = await lead({ firstName: 'Wes', status: 'Negotiating' });
    const deal = await createDeal(org, manager, { leadId: String(open._id) });
    await expect(updateDeal(org, manager, deal.id, { stage: 'lost' })).rejects.toMatchObject({ statusCode: 400 });
    const won = await updateDeal(org, manager, deal.id, { stage: 'won', markLeadSold: true });
    expect(won.leadSold).toBe('changed');
    expect(won.deal.stage).toBe('won');
    const sold: any = await Lead.findById(open._id).lean();
    expect(sold.status).toBe('Sold');
    expect(sold.statusHistory.at(-1)).toMatchObject({ from: 'Negotiating', to: 'Sold' });

    const dnc = await lead({ firstName: 'Dana', status: 'Do Not Contact' });
    const dncDeal = await createDeal(org, manager, { leadId: String(dnc._id) });
    const dncWon = await updateDeal(org, manager, dncDeal.id, { stage: 'won', markLeadSold: true });
    expect(dncWon.leadSold).toBe('do_not_contact');
    expect(((await Lead.findById(dnc._id).lean()) as any).status).toBe('Do Not Contact');

    const lost = await updateDeal(org, manager, dncDeal.id, { stage: 'lost', lostReason: 'Bought elsewhere' });
    expect(lost.deal).toMatchObject({ stage: 'lost', lostReason: 'Bought elsewhere', wonAt: null });
    await expect(createDeal(org, manager, { leadId: String(open._id), stage: 'won' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(createDeal(org, manager, { leadId: String(open._id), amount: -5 })).rejects.toMatchObject({ statusCode: 400 });

    const found = await searchDealLeads(org, 'Wes Diaz');
    expect(found.map((item) => item.id)).toContain(String(open._id));
    expect(await searchDealLeads(org, 'W')).toEqual([]);
  });

  it('7. the builder accepts the new steps only with a real Lead Group and a valid stage, and lists groups and stages', async () => {
    const group = await CrmLeadGroup.create({ organizationId: orgId, name: 'Sales floor', memberIds: [rep1, rep2], createdBy: crmRep2 });
    const otherGroup = await CrmLeadGroup.create({ organizationId: otherOrgId, name: 'Elsewhere', memberIds: [], createdBy: crmRep2 });
    const base = { name: 'Part three', trigger: { source: 'suprah', event: 'call_ended' } };
    await expect(createAutomation(org, actor, { ...base, steps: [{ type: 'assign_lead_group', config: {} }] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(createAutomation(org, actor, { ...base, steps: [{ type: 'assign_lead_group', config: { groupId: String(otherGroup._id) } }] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(createAutomation(org, actor, { ...base, steps: [{ type: 'create_deal', config: { stage: 'won' } }] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(createAutomation(org, actor, { ...base, steps: [{ type: 'move_deal', config: {} }] })).rejects.toMatchObject({ statusCode: 400 });
    const saved = await createAutomation(org, actor, {
      ...base,
      steps: [
        { type: 'assign_lead_group', config: { groupId: String(group._id) } },
        { type: 'assign_dynamic', config: { ignored: true } },
        { type: 'create_deal', config: {} },
        { type: 'move_deal', config: { stage: 'won' } },
      ],
    });
    expect(saved.steps.map((step: any) => [step.type, step.config])).toEqual([
      ['assign_lead_group', { groupId: String(group._id) }],
      ['assign_dynamic', {}],
      ['create_deal', { stage: 'new' }],
      ['move_deal', { stage: 'won' }],
    ]);
    const options: any = await getAutomationOptions(org);
    expect(options.leadGroups).toEqual([{ id: String(group._id), name: 'Sales floor', members: 2 }]);
    expect(options.dealStages.map((stage: any) => stage.value)).toEqual(['new', 'working', 'offer_sent', 'negotiating', 'won', 'lost']);
    expect(options.actions.filter((action: any) => ['assign_lead_group', 'assign_dynamic', 'create_deal', 'move_deal'].includes(action.key)).every((action: any) => action.connected)).toBe(true);
  });

  it('8. Assign to a Lead Group takes turns among active members, notifies the group, and Test Mode changes nothing', async () => {
    await CrmLeadGroup.collection.deleteMany({ organizationId: orgId });
    const group = await CrmLeadGroup.create({ organizationId: orgId, name: 'Closers', memberIds: [rep1, rep3, rep2], createdBy: crmRep2 });
    const step = { id: 'g1', type: 'assign_lead_group', config: { groupId: String(group._id) } };
    const leads = [await lead({ firstName: 'A1' }), await lead({ firstName: 'A2' }), await lead({ firstName: 'A3' })];
    const runs = [];
    for (const item of leads) runs.push(await runSteps([step], { leadId: String(item._id) }));
    const assigned = await Promise.all(leads.map(async (item) => String(((await Lead.findById(item._id).lean()) as any).assignedTo)));
    expect(assigned).toEqual([String(rep1), String(rep2), String(rep1)]);
    expect(runs[0].log[0]).toMatchObject({ status: 'done' });
    expect(runs[0].log[0].detail).toContain('Riley One from "Closers". Notified 2 people');
    expect(mockNotifyUsers).toHaveBeenCalledTimes(3);
    expect(mockNotifyUsers.mock.calls[0][0]).toEqual([String(rep1), String(rep2)]);
    expect(mockNotifyUsers.mock.calls[0][2]).toBe('lead_assigned');

    const preview = await lead({ firstName: 'T1' });
    const before = ((await CrmLeadGroup.findById(group._id).lean()) as any).roundRobinCursor;
    const tested = await runSteps([step], { leadId: String(preview._id), mode: 'test' });
    expect(tested.log[0]).toMatchObject({ status: 'test' });
    expect(tested.log[0].detail).toContain('Would assign the lead to Sam Two');
    expect(((await CrmLeadGroup.findById(group._id).lean()) as any).roundRobinCursor).toBe(before);
    expect(((await Lead.findById(preview._id).lean()) as any).assignedTo).toBeUndefined();

    await CrmLeadGroup.updateOne({ _id: group._id }, { $set: { isActive: false } });
    const off = await runSteps([step], { leadId: String(preview._id) });
    expect(off.log[0]).toMatchObject({ status: 'skipped', detail: 'The Lead Group was deleted or turned off' });
  });

  it('9. Assign to who handled it uses who answered the call, who booked the appointment, or who last texted, and changes nothing when nobody did', async () => {
    const step = { id: 'd1', type: 'assign_dynamic', config: {} };
    const callLead = await lead({ firstName: 'Cal' });
    const answered = await CallLog.create({ orgId: org, direction: 'inbound', from: callLead.phone, to: '+18015550951', status: 'completed', startedAt: new Date(), endedAt: new Date(), answeredBy: { userId: String(crmRep2), name: 'Sam Two' } });
    const byCall = await runSteps([step], { event: 'call_ended', eventKey: `call_ended:${answered._id}`, leadId: String(callLead._id) });
    expect(byCall.log[0].detail).toContain('Sam Two, who answered the call');
    expect(String(((await Lead.findById(callLead._id).lean()) as any).assignedTo)).toBe(String(rep2));

    const missed = await CallLog.create({ orgId: org, direction: 'inbound', from: callLead.phone, to: '+18015550951', status: 'missed', startedAt: new Date(), endedAt: new Date() });
    const noAnswer = await runSteps([step], { event: 'call_missed', eventKey: `call_missed:${missed._id}`, leadId: String(callLead._id) });
    expect(noAnswer.log[0]).toMatchObject({ status: 'skipped' });
    expect(String(((await Lead.findById(callLead._id).lean()) as any).assignedTo)).toBe(String(rep2));

    const bookLead = await lead({ firstName: 'Bo' });
    const staffBooked = new mongoose.Types.ObjectId();
    const websiteBooked = new mongoose.Types.ObjectId();
    await Appointment.collection.insertMany([
      { _id: staffBooked, organizationId: org, title: 'Test drive', startTime: new Date(Date.now() + DAY), endTime: new Date(Date.now() + DAY + 3600000), status: 'scheduled', entryType: 'appointment', createdBy: rep1, createdByModel: 'User', leadId: bookLead._id },
      { _id: websiteBooked, organizationId: org, title: 'Test drive', startTime: new Date(Date.now() + DAY), endTime: new Date(Date.now() + DAY + 3600000), status: 'scheduled', entryType: 'appointment', createdBy: adminId, createdByModel: 'User', leadId: bookLead._id },
    ] as any[]);
    const byBooking = await runSteps([step], { event: 'appointment_booked', appointmentId: String(staffBooked), leadId: String(bookLead._id) });
    expect(byBooking.log[0].detail).toContain('Riley One, who booked the appointment');
    const byWebsite = await runSteps([step], { event: 'appointment_booked', appointmentId: String(websiteBooked), leadId: String(bookLead._id) });
    expect(byWebsite.log[0]).toMatchObject({ status: 'skipped' });
    expect(byWebsite.log[0].detail).toContain('not by a team member');

    const textLead = await lead({ firstName: 'Tex' });
    const conversationId = new mongoose.Types.ObjectId();
    await Conversation.collection.insertOne({ _id: conversationId, orgId, customerPhone: textLead.phone, leadId: textLead._id, lastMessageAt: new Date(), messageCount: 2, createdAt: new Date(), updatedAt: new Date() } as any);
    await CommunicationMessage.collection.insertMany([
      { orgId, conversationId, leadId: textLead._id, direction: 'outbound', body: 'Hi', from: '+18015550951', to: textLead.phone, status: 'delivered', sentBy: { userId: String(rep1), name: 'Riley One' }, createdAt: new Date(Date.now() - 60000), updatedAt: new Date() },
      { orgId, conversationId, leadId: textLead._id, direction: 'outbound', body: 'Auto', from: '+18015550951', to: textLead.phone, status: 'delivered', sentBy: { userId: 'system', name: 'Automation - X' }, createdAt: new Date(), updatedAt: new Date() },
    ] as any[]);
    const byText = await runSteps([step], { event: 'text_received', leadId: String(textLead._id), phone: textLead.phone });
    expect(byText.log[0].detail).toContain('Riley One, who last texted the customer');
    const quiet = await lead({ firstName: 'Quiet' });
    const nobody = await runSteps([step], { event: 'lead_created', leadId: String(quiet._id), phone: quiet.phone });
    expect(nobody.log[0]).toMatchObject({ status: 'skipped' });
    expect(((await Lead.findById(quiet._id).lean()) as any).assignedTo).toBeUndefined();
    const preview = await runSteps([step], { event: 'text_received', leadId: String(textLead._id), phone: textLead.phone, mode: 'test' });
    expect(preview.log[0]).toMatchObject({ status: 'test', detail: 'Would assign the lead to Riley One, who last texted the customer' });
  });

  it('10. Create a Deal and Move the Deal steps work on the lead, skip when they should, and Test Mode creates nothing', async () => {
    const target = await lead({ firstName: 'Del', assignedTo: rep2 });
    const created = await runSteps([{ id: 'c1', type: 'create_deal', config: { stage: 'working' } }], { leadId: String(target._id) });
    expect(created.log[0]).toMatchObject({ status: 'done', detail: 'Created a deal in Working' });
    const deal: any = await CrmDeal.findOne({ leadId: target._id }).lean();
    expect(deal).toMatchObject({ stage: 'working', assignedName: 'Sam Two', createdBy: expect.objectContaining({ kind: 'automation' }) });
    const again = await runSteps([{ id: 'c2', type: 'create_deal', config: { stage: 'new' } }], { leadId: String(target._id) });
    expect(again.log[0]).toMatchObject({ status: 'skipped', detail: 'This lead already has an open deal' });
    const moved = await runSteps([{ id: 'm1', type: 'move_deal', config: { stage: 'negotiating' } }], { leadId: String(target._id) });
    expect(moved.log[0]).toMatchObject({ status: 'done', detail: 'Moved the deal from Working to Negotiating' });
    const preview = await runSteps([{ id: 'm2', type: 'move_deal', config: { stage: 'lost' } }], { leadId: String(target._id), mode: 'test' });
    expect(preview.log[0]).toMatchObject({ status: 'test' });
    expect(((await CrmDeal.findById(deal._id).lean()) as any).stage).toBe('negotiating');
    const lostByAutomation = await runSteps([{ id: 'm3', type: 'move_deal', config: { stage: 'lost' } }], { leadId: String(target._id) });
    expect(lostByAutomation.log[0].status).toBe('done');
    expect(((await Lead.findById(target._id).lean()) as any).status).toBe('Contacted');

    const empty = await lead({ firstName: 'Nod' });
    const nothing = await runSteps([{ id: 'm4', type: 'move_deal', config: { stage: 'won' } }], { leadId: String(empty._id) });
    expect(nothing.log[0]).toMatchObject({ status: 'skipped', detail: 'This lead has no open deal to move' });
    const testCreate = await runSteps([{ id: 'c3', type: 'create_deal', config: { stage: 'new' } }], { leadId: String(empty._id), mode: 'test' });
    expect(testCreate.log[0]).toMatchObject({ status: 'test', detail: 'Would create a deal in New' });
    expect(await CrmDeal.countDocuments({ leadId: empty._id })).toBe(0);
  });
});
