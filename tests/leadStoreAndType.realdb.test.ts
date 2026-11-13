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

import crypto from 'crypto';
import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import User from '../src/models/User.model';
import Lead from '../src/models/lead.model';
import Vehicle from '../src/models/Vehicle.model';
import CrmLocation from '../src/models/CrmLocation.model';
import CrmLocationAudit from '../src/models/CrmLocationAudit.model';
import LeadIntakeControl from '../src/models/LeadIntakeControl.model';
import LeadInquiry from '../src/models/LeadInquiry.model';
import PriceDropEmailLog from '../src/models/PriceDropEmailLog.model';
import UserActivity from '../src/models/UserActivity.model';
import { CallLog, CommunicationMessage, Conversation } from '../src/models/communication.model';
import { createInquiry, getAllLeads, getLeadLocationCounts, getLeadTypeCounts } from '../src/controllers/lead.controller';
import { handleInboundSms, sendSmsFromUser } from '../src/services/communication.service';
import { resolveVehicleContextForLead } from '../src/services/leadLocation.service';
import { stampLeadCampaign } from '../src/utils/leadActivity';
import { runLeadStoreTypeBackfill } from '../src/services/leadStoreTypeBackfill.service';
import { updateLocation } from '../src/services/crmLocation.service';
import { resolveLeadStore } from '../src/utils/leadStore';

const orgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const intakeOrgId = new mongoose.Types.ObjectId();
const INTAKE_ORG = String(intakeOrgId);
const adminId = new mongoose.Types.ObjectId();
const intakeAdminId = new mongoose.Types.ObjectId();
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000);
const suffix = ORG.slice(-6).toUpperCase();

function fakeRes() {
  const res: any = {};
  res.status = (code: number) => { res.code = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}

async function listed(query: Record<string, string> = {}, org = ORG) {
  const res = fakeRes();
  await getAllLeads({ orgId: org, query: { limit: '100', ...query } } as any, res);
  return (res.body?.data?.leads || []) as any[];
}

const names = (leads: any[]) => leads.map((lead) => lead.firstName).sort();

async function waitFor<T>(read: () => Promise<T | null>, ms = 5000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting');
}

const smsPayload = (from: string, text: string) => ({
  id: `msg-${crypto.randomUUID()}`, text, from: { phone_number: from }, to: [{ phone_number: '+18015550900' }],
});

async function cleanup() {
  const orgs = [orgId, intakeOrgId];
  const orgStrings = [ORG, INTAKE_ORG];
  await Promise.all([
    Organization.collection.deleteMany({ _id: { $in: orgs } }),
    User.collection.deleteMany({ organizationId: { $in: orgs } }),
    Lead.collection.deleteMany({ organizationId: { $in: orgs } }),
    Vehicle.collection.deleteMany({ organizationId: { $in: orgStrings } }),
    CrmLocation.collection.deleteMany({ organizationId: { $in: orgStrings } }),
    CrmLocationAudit.collection.deleteMany({ organizationId: { $in: orgStrings } }),
    LeadIntakeControl.collection.deleteMany({ organizationId: { $in: [...orgs, ...orgStrings] } }),
    LeadInquiry.collection.deleteMany({ organizationId: { $in: [...orgs, ...orgStrings] } }),
    PriceDropEmailLog.collection.deleteMany({ organizationId: { $in: orgStrings } }),
    UserActivity.collection.deleteMany({ organizationId: { $in: [...orgs, ...orgStrings] } }),
    Conversation.collection.deleteMany({ orgId: { $in: [...orgs, ...orgStrings] } }),
    CommunicationMessage.collection.deleteMany({ orgId: { $in: [...orgs, ...orgStrings] } }),
    CallLog.collection.deleteMany({ orgId: { $in: [...orgs, ...orgStrings] } }),
  ]);
}

function location(name: string, keys: string[], org = ORG) {
  const actor = { userId: String(adminId), name: 'Ada Admin', role: 'admin' };
  return { organizationId: org, code: keys[keys.length - 1].replace(/\s+/g, '-'), name, aliases: [], aliasKeys: keys, status: 'active', revision: 1, createdBy: actor, updatedBy: actor, createdAt: new Date(), updatedAt: new Date() };
}

function vehicle(fields: Record<string, unknown>) {
  return { organizationId: ORG, make: 'Toyota', modelName: 'Camry', year: 2022, price: 20000, createdAt: new Date(), updatedAt: new Date(), ...fields };
}

describe('Real-DB: Lehi/Orem store filter and Inbound/Outbound/Campaign lead type (local test DB only)', () => {
  beforeAll(async () => {
    if (mongoose.connection.host !== '127.0.0.1' || mongoose.connection.port !== 27018 || !/_test$/.test(mongoose.connection.name)) throw new Error('Local test DB only');
    await cleanup();
    await Promise.all([Lead.createIndexes(), Conversation.init(), CallLog.init(), LeadIntakeControl.init()]);
    await Organization.collection.insertMany([
      { _id: orgId, name: 'Store Type Motors', slug: `st-${orgId}`, status: 'active', metadata: { aiAgentModes: { sms: 'off', email: 'off', webchat: 'off' } } },
      { _id: intakeOrgId, name: 'Store Type Intake Motors', slug: `sti-${intakeOrgId}`, status: 'active', metadata: { aiAgentModes: { sms: 'off', email: 'off', webchat: 'off' } } },
    ] as any[]);
    await User.collection.insertMany([
      { _id: adminId, organizationId: orgId, name: 'Ada Admin', email: `st-admin-${orgId}@example.com`, role: 'admin', isActive: true },
      { _id: intakeAdminId, organizationId: intakeOrgId, name: 'Ivy Admin', email: `st-admin-${intakeOrgId}@example.com`, role: 'admin', isActive: true },
    ] as any[]);
    await LeadIntakeControl.collection.insertOne({ organizationId: intakeOrgId, mode: 'active', version: 1, createdAt: new Date(), updatedAt: new Date() } as any);
    await CrmLocation.collection.insertMany([
      location('Action Auto - Lehi', ['action auto lehi', 'aa lehi']),
      location('Action Auto - Orem', ['action auto orem', 'aa orem']),
    ] as any[]);
    await Vehicle.collection.insertMany([
      vehicle({ vin: `P49STOCKOREM${suffix}`, stockNumber: `O${suffix}`, dealerCity: 'OREM', modelName: 'Corolla' }),
      vehicle({ vin: `P49CAMRYLEHI${suffix}`, stockNumber: `L1${suffix}`, dealerCity: 'LEHI' }),
      vehicle({ vin: `P49CAMRYOREM${suffix}`, stockNumber: `O2${suffix}`, dealerCity: 'OREM' }),
      vehicle({ vin: `P49TACOMALEHI${suffix}`, stockNumber: `L3${suffix}`, dealerCity: 'LEHI', make: 'Toyota', modelName: 'Tacoma', year: 2021 }),
    ] as any[]);
  });

  beforeEach(() => {
    mockSms.mockReset().mockResolvedValue({ id: `sms-${Date.now()}` });
  });

  afterAll(async () => {
    await cleanup();
  });

  it('finds the store by stock number and does not guess when both stores have the same car', async () => {
    const byStock = await resolveVehicleContextForLead(ORG, { stock: `o${suffix}`, year: '2022', make: 'Toyota', model: 'Camry' });
    expect(byStock?.location).toBe('OREM');
    const both = await resolveVehicleContextForLead(ORG, { year: '2022', make: 'Toyota', model: 'Camry' });
    expect(both?.vehicleId).toBeTruthy();
    expect(both?.location).toBeUndefined();
    const oneStore = await resolveVehicleContextForLead(ORG, { year: '2021', make: 'Toyota', model: 'Tacoma' });
    expect(oneStore?.location).toBe('LEHI');
  });

  it('groups feed labels and CRM names under one store in the filter, the counts and the row label', async () => {
    const base = { organizationId: orgId, createdBy: adminId, source: 'Third-Party Lead', channel: 'email', status: 'New', isRead: true, createdAt: minutesAgo(60), updatedAt: minutesAgo(60) };
    await Lead.collection.insertMany([
      { ...base, firstName: 'FeedLehi', location: 'LEHI' },
      { ...base, firstName: 'ChatLehi', location: 'Action Auto - Lehi' },
      { ...base, firstName: 'NumberOrem', location: 'Orem' },
      { ...base, firstName: 'NoStore' },
    ] as any[]);

    expect(names(await listed({ location: 'Action Auto - Lehi' }))).toEqual(['ChatLehi', 'FeedLehi']);
    expect(names(await listed({ location: 'LEHI' }))).toEqual(['ChatLehi', 'FeedLehi']);
    expect(names(await listed({ location: 'Action Auto - Orem' }))).toEqual(['NumberOrem']);
    expect(names(await listed({ location: 'Unknown Location' }))).toEqual(['NoStore']);

    const res = fakeRes();
    await getLeadLocationCounts({ orgId: ORG } as any, res);
    expect(res.body.data.counts).toEqual({ 'Action Auto - Lehi': 2, 'Action Auto - Orem': 1, 'Unknown Location': 1 });

    const rows = await listed({ search: 'FeedLehi' });
    expect(rows[0].storeName).toBe('Action Auto - Lehi');
    await Lead.collection.deleteMany({ organizationId: orgId });
  });

  it('marks staff-added leads as outbound unless an inbound source was picked', async () => {
    const add = async (firstName: string, phone: string, source?: string) => {
      const res = fakeRes();
      await createInquiry({ orgId: ORG, user: { _id: adminId, name: 'Ada Admin' }, body: { firstName, phone, ...(source ? { source } : {}) }, ip: '127.0.0.1' } as any, res);
      return res;
    };
    await add('Walkin', '+18015557001');
    await add('Caller', '+18015557002', 'Inbound Call');
    const walkin: any = await Lead.findOne({ organizationId: orgId, firstName: 'Walkin' }).lean();
    const caller: any = await Lead.findOne({ organizationId: orgId, firstName: 'Caller' }).lean();
    expect(walkin).toMatchObject({ firstContactBy: 'team', firstContactVia: 'added_by_team' });
    expect(caller).toMatchObject({ firstContactBy: 'customer', firstContactVia: null });
    expect(names(await listed({ leadType: 'outbound:added_by_team' }))).toEqual(['Walkin']);
    expect(names(await listed({ leadType: 'inbound' }))).toEqual(['Caller']);
  });

  it('marks a lead outbound when our team texted the number first and the customer replied', async () => {
    await sendSmsFromUser({ orgId, user: { userId: String(adminId), name: 'Ada Admin' }, toPhone: '+18015557101', body: 'Hi, still looking for a truck?', destinationPolicy: 'manual' });
    expect(await Lead.countDocuments({ organizationId: orgId, phone: '+18015557101' })).toBe(0);
    await handleInboundSms(smsPayload('+18015557101', 'Yes I am!'), orgId);
    const repliedLead: any = await waitFor(() => Lead.findOne({ organizationId: orgId, phone: '+18015557101' }).lean());
    expect(repliedLead).toMatchObject({ source: 'Inbound SMS', firstContactBy: 'team', firstContactVia: 'team_text' });

    await handleInboundSms(smsPayload('+18015557102', 'Do you have Camrys?'), orgId);
    const customerFirst: any = await waitFor(() => Lead.findOne({ organizationId: orgId, phone: '+18015557102' }).lean());
    expect(customerFirst).toMatchObject({ firstContactBy: 'customer', firstContactVia: null });

    const textedFirst = names(await listed({ leadType: 'outbound:team_text' }));
    expect(textedFirst).toContain(repliedLead.firstName);
    expect(textedFirst).toHaveLength(1);
  });

  it('does the same when lead intake is turned on', async () => {
    await sendSmsFromUser({ orgId: intakeOrgId, user: { userId: String(intakeAdminId), name: 'Ivy Admin' }, toPhone: '+18015557201', body: 'Hi from Ivy', destinationPolicy: 'manual' });
    await handleInboundSms(smsPayload('+18015557201', 'Hello Ivy'), intakeOrgId);
    const teamFirst: any = await waitFor(() => Lead.findOne({ organizationId: intakeOrgId, phone: '+18015557201' }).lean());
    expect(teamFirst).toMatchObject({ firstContactBy: 'team', firstContactVia: 'team_text' });

    await handleInboundSms(smsPayload('+18015557202', 'Is the Camry available?'), intakeOrgId);
    const customerFirst: any = await waitFor(() => Lead.findOne({ organizationId: intakeOrgId, phone: '+18015557202' }).lean());
    expect(customerFirst).toMatchObject({ firstContactBy: 'customer' });
  });

  it('lists campaign leads with Responded / No response and filters them by the date they were sent', async () => {
    const base = { organizationId: orgId, createdBy: adminId, source: 'Third-Party Lead', channel: 'email', status: 'New', isRead: true, createdAt: minutesAgo(10 * 1440), updatedAt: minutesAgo(10 * 1440) };
    const inserted = await Lead.collection.insertMany([
      { ...base, firstName: 'Replied', followUp: { lastCustomerActivityAt: minutesAgo(30) } },
      { ...base, firstName: 'Silent', followUp: { lastCustomerActivityAt: minutesAgo(9 * 1440) } },
      { ...base, firstName: 'OldDrop', followUp: { lastCustomerActivityAt: minutesAgo(9 * 1440) } },
    ] as any[]);
    const [replied, silent, oldDrop] = Object.values(inserted.insertedIds);
    await stampLeadCampaign(replied, 'price_drop', minutesAgo(120));
    await stampLeadCampaign(silent, 'price_drop', minutesAgo(120));
    await stampLeadCampaign(silent, 'reengagement', minutesAgo(60));
    await stampLeadCampaign(oldDrop, 'price_drop', minutesAgo(40 * 1440));
    await stampLeadCampaign(oldDrop, 'price_drop', minutesAgo(50 * 1440));

    const priceDrops = await listed({ leadType: 'campaign:price_drop' });
    expect(names(priceDrops)).toEqual(['OldDrop', 'Replied', 'Silent']);
    const byName = Object.fromEntries(priceDrops.map((lead) => [lead.firstName, lead.campaign]));
    expect(byName.Replied).toMatchObject({ kind: 'price_drop', responded: true });
    expect(byName.Silent).toMatchObject({ kind: 'price_drop', responded: false });
    expect(new Date(byName.OldDrop.sentAt).getTime()).toBeGreaterThan(minutesAgo(41 * 1440).getTime());

    const localDay = (offsetDays: number) => {
      const day = new Date(Date.now() + offsetDays * 86400000);
      return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    };
    const today = localDay(1);
    const weekAgo = localDay(-7);
    expect(names(await listed({ leadType: 'campaign:price_drop', dateFrom: weekAgo, dateTo: today }))).toEqual(['Replied', 'Silent']);
    expect(names(await listed({ leadType: 'campaign', dateFrom: weekAgo, dateTo: today }))).toEqual(['Replied', 'Silent']);
    expect(names(await listed({ leadType: 'campaign:reengagement' }))).toEqual(['Silent']);

    const res = fakeRes();
    await getLeadTypeCounts({ orgId: ORG } as any, res);
    expect(res.body.data.counts).toMatchObject({ 'campaign:price_drop': 3, 'campaign:reengagement': 1, campaign: 3 });
    await Lead.collection.deleteMany({ _id: { $in: [replied, silent, oldDrop] } });
  });

  it('uses Denver days for the date filter, so a late-evening Denver lead stays on its Denver day', async () => {
    const base = { organizationId: orgId, createdBy: adminId, source: 'Third-Party Lead', channel: 'email', status: 'New', isRead: true };
    const inserted = await Lead.collection.insertMany([
      { ...base, firstName: 'DenverMorning', createdAt: new Date('2026-10-02T14:00:00.000Z'), updatedAt: new Date('2026-10-02T14:00:00.000Z') },
      { ...base, firstName: 'DenverLateEvening', createdAt: new Date('2026-10-03T05:30:00.000Z'), updatedAt: new Date('2026-10-03T05:30:00.000Z') },
      { ...base, firstName: 'DenverNextDay', createdAt: new Date('2026-10-03T06:30:00.000Z'), updatedAt: new Date('2026-10-03T06:30:00.000Z') },
    ] as any[]);
    expect(names(await listed({ dateFrom: '2026-10-02', dateTo: '2026-10-02' }))).toEqual(['DenverLateEvening', 'DenverMorning']);
    expect(names(await listed({ dateFrom: '2026-10-03', dateTo: '2026-10-03' }))).toEqual(['DenverNextDay']);
    await Lead.collection.deleteMany({ _id: { $in: Object.values(inserted.insertedIds) } });
  });

  it('fills store, lead type and campaign dates for older leads only when asked, and only once', async () => {
    await Lead.collection.deleteMany({ organizationId: orgId });
    const convoId = new mongoose.Types.ObjectId();
    const base = { organizationId: orgId, createdBy: adminId, status: 'New', isRead: true, createdAt: minutesAgo(5 * 1440), updatedAt: minutesAgo(5 * 1440) };
    const inserted = await Lead.collection.insertMany([
      { ...base, firstName: 'OldManual', source: 'Manual Entry', channel: 'sms' },
      { ...base, firstName: 'OldTexted', source: 'Inbound SMS', channel: 'sms', phone: '+18015557301' },
      { ...base, firstName: 'OldKsl', source: 'Third-Party Lead', channel: 'email', vehicle: { year: '2022', make: 'Toyota', model: 'Corolla', stock: `O${suffix}` } },
    ] as any[]);
    const [, oldTexted, oldKsl] = Object.values(inserted.insertedIds);
    await Conversation.collection.insertOne({ _id: convoId, orgId, customerPhone: '+18015557301', leadId: oldTexted, createdAt: minutesAgo(6 * 1440), updatedAt: minutesAgo(5 * 1440) } as any);
    await CommunicationMessage.collection.insertMany([
      { orgId, conversationId: convoId, leadId: oldTexted, direction: 'outbound', body: 'Hi there', from: '+18015550900', to: '+18015557301', status: 'sent', createdAt: minutesAgo(6 * 1440), updatedAt: minutesAgo(6 * 1440) },
      { orgId, conversationId: convoId, leadId: oldTexted, direction: 'inbound', body: 'Hey', from: '+18015557301', to: '+18015550900', status: 'received', createdAt: minutesAgo(5 * 1440), updatedAt: minutesAgo(5 * 1440) },
    ] as any[]);
    await PriceDropEmailLog.collection.insertOne({ organizationId: ORG, vehicleId: new mongoose.Types.ObjectId(), leadId: oldKsl, vehicleLabel: '2022 Toyota Corolla', leadEmail: 'oldksl@example.com', previousPrice: 21000, newPrice: 20000, priceChangedAt: minutesAgo(2 * 1440), status: 'sent', sentAt: minutesAgo(2 * 1440), createdAt: minutesAgo(2 * 1440), updatedAt: minutesAgo(2 * 1440) } as any);

    const preview = await runLeadStoreTypeBackfill({ organizationId: ORG });
    expect(preview).toMatchObject({ apply: false, scanned: 3, updated: 3, locationFilled: 1, leadTypeFilled: 3, campaignStamped: 1 });
    expect(preview.locationByStore).toEqual({ OREM: 1 });
    expect(preview.leadTypeByKind).toEqual({ added_by_team: 1, team_text: 1, customer: 1 });
    expect(await Lead.countDocuments({ organizationId: orgId, firstContactBy: { $in: ['customer', 'team'] } })).toBe(0);

    const applied = await runLeadStoreTypeBackfill({ organizationId: ORG, apply: true });
    expect(applied).toMatchObject({ apply: true, updated: 3 });
    const rows: any[] = await Lead.find({ organizationId: orgId }).lean();
    const byName = Object.fromEntries(rows.map((row) => [row.firstName, row]));
    expect(byName.OldManual).toMatchObject({ firstContactBy: 'team', firstContactVia: 'added_by_team' });
    expect(byName.OldTexted).toMatchObject({ firstContactBy: 'team', firstContactVia: 'team_text' });
    expect(byName.OldKsl).toMatchObject({ firstContactBy: 'customer', location: 'OREM' });
    expect(byName.OldKsl.campaignSentAt.priceDrop).toBeTruthy();
    expect(byName.OldManual.campaignSentAt?.priceDrop || null).toBeNull();

    const again = await runLeadStoreTypeBackfill({ organizationId: ORG, apply: true });
    expect(again).toMatchObject({ updated: 0, locationFilled: 0, leadTypeFilled: 0, campaignStamped: 0 });
  });

  it('uses the stock number start set in Locations: L = Lehi, M = Orem, even when the inventory says another store', async () => {
    const admin = { _id: adminId, role: 'admin', fullName: 'Ada Admin' };
    const lehi: any = await CrmLocation.findOne({ organizationId: ORG, name: 'Action Auto - Lehi' }).lean();
    const orem: any = await CrmLocation.findOne({ organizationId: ORG, name: 'Action Auto - Orem' }).lean();
    await updateLocation({ organizationId: ORG, user: admin, id: String(lehi._id), location: { stockPrefixes: ['l'] }, expectedRevision: lehi.revision });
    await expect(updateLocation({ organizationId: ORG, user: admin, id: String(orem._id), location: { stockPrefixes: ['L'] }, expectedRevision: orem.revision }))
      .rejects.toMatchObject({ statusCode: 409 });
    await updateLocation({ organizationId: ORG, user: admin, id: String(orem._id), location: { stockPrefixes: ['M'] }, expectedRevision: orem.revision });
    expect((await CrmLocation.findById(lehi._id).lean() as any).stockPrefixes).toEqual(['L']);

    await Vehicle.collection.insertOne(vehicle({ vin: `P49MOVED${suffix}`, stockNumber: `M5${suffix}`, dealerCity: 'LEHI', modelName: 'Sienna' }) as any);
    expect((await resolveLeadStore(ORG, { vin: `P49MOVED${suffix}` }))?.location).toBe('Action Auto - Orem');
    expect((await resolveLeadStore(ORG, { stock: 'l9999' }))?.location).toBe('Action Auto - Lehi');
    expect((await resolveLeadStore(ORG, { stock: 'Z123' }))).toBeNull();

    const res = fakeRes();
    await createInquiry({ orgId: ORG, user: { _id: adminId, name: 'Ada Admin' }, body: { firstName: 'PrefixWalkin', phone: '+18015557401', vehicle: { year: '2020', make: 'Honda', model: 'Civic', stock: 'M4410' } }, ip: '127.0.0.1' } as any, res);
    const walkin: any = await Lead.findOne({ organizationId: orgId, firstName: 'PrefixWalkin' }).lean();
    expect(walkin.location).toBe('Action Auto - Orem');

    const base = { organizationId: orgId, createdBy: adminId, source: 'Third-Party Lead', channel: 'email', status: 'New', isRead: true, firstContactBy: 'customer', createdAt: minutesAgo(600), updatedAt: minutesAgo(600) };
    await Lead.collection.insertMany([
      { ...base, firstName: 'WrongStore', location: 'LEHI', vehicle: { year: '2019', make: 'Ford', model: 'Escape', stock: 'M8080' } },
      { ...base, firstName: 'SoldCar', vehicle: { year: '2018', make: 'Kia', model: 'Soul', stock: 'L7070' } },
      { ...base, firstName: 'RightStore', location: 'Orem', vehicle: { year: '2018', make: 'Kia', model: 'Rio', stock: 'M6060' } },
    ] as any[]);
    const preview = await runLeadStoreTypeBackfill({ organizationId: ORG });
    expect(preview).toMatchObject({ locationCorrected: 1, locationFilled: 1 });
    await runLeadStoreTypeBackfill({ organizationId: ORG, apply: true });
    const rows: any[] = await Lead.find({ organizationId: orgId, firstName: { $in: ['WrongStore', 'SoldCar', 'RightStore'] } }).lean();
    const byName = Object.fromEntries(rows.map((row) => [row.firstName, row.location]));
    expect(byName).toEqual({ WrongStore: 'Action Auto - Orem', SoldCar: 'Action Auto - Lehi', RightStore: 'Orem' });
    expect(await runLeadStoreTypeBackfill({ organizationId: ORG })).toMatchObject({ locationCorrected: 0, locationFilled: 0 });
  });
});
