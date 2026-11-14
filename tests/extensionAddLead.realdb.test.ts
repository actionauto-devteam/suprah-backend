const emitted: Array<{ room: string; event: string }> = [];
jest.mock('../src/utils/socketEmitter', () => ({
  emitToOrg: jest.fn(),
  emitToUser: jest.fn(),
  emitToCrmUser: jest.fn(),
  streamLogToAdmins: jest.fn(),
  getSocketIO: () => ({ to: (room: string) => ({ emit: (event: string) => emitted.push({ room, event }) }) }),
}));
jest.mock('../src/utils/safeNotification', () => ({
  notifyOrgAdmins: jest.fn().mockResolvedValue(undefined),
  notifyUsers: jest.fn().mockResolvedValue(undefined),
  safeCreateNotification: jest.fn().mockResolvedValue(undefined),
  safeBroadcastNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/services/activity.service', () => ({
  __esModule: true,
  default: { createActivity: jest.fn().mockResolvedValue(undefined) },
}));

import mongoose from 'mongoose';
import Lead from '../src/models/lead.model';
import { notifyOrgAdmins } from '../src/utils/safeNotification';
import activityService from '../src/services/activity.service';
import { createExtensionLead, lookupLeadsByName, lookupLeadsByPhone, nameLookupConditions } from '../src/services/crmExtension.service';

const orgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const staffUserId = new mongoose.Types.ObjectId();
const adder = { _id: new mongoose.Types.ObjectId(), fullName: 'Robin Tester', email: 'p53-adder@local.test', role: 'employee' };
const stranger = { _id: new mongoose.Types.ObjectId(), fullName: 'Sam Unlinked', email: 'p53-nobody@local.test', role: 'employee' };
const vehicleId = new mongoose.Types.ObjectId();
const SITE = 'https://actionauto.autodealerscloud.com';

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error: any) {
    return { status: error?.statusCode ?? error?.status, message: String(error?.message || '') };
  }
  return null;
}

describe('Real-DB: add a customer to Suprah CRM from the Chrome extension (local test DB only)', () => {
  beforeAll(async () => {
    if (mongoose.connection.host !== '127.0.0.1' || mongoose.connection.port !== 27018 || !/_test$/.test(mongoose.connection.name)) throw new Error('Local test DB only');
    const db = mongoose.connection;
    await Lead.collection.deleteMany({ organizationId: orgId });
    await db.collection('users').insertOne({ _id: staffUserId, email: adder.email, name: 'Robin Tester', organizationId: orgId, role: 'employee', isActive: true } as any);
    const actor = { userId: String(staffUserId), name: 'Robin Tester', role: 'admin' };
    const now = new Date();
    await db.collection('crmlocations').insertMany([
      { organizationId: ORG, code: 'lehi', name: 'Lehi', aliasKeys: ['lehi'], stockPrefixes: ['L'], status: 'active', revision: 1, createdBy: actor, createdAt: now, updatedAt: now },
      { organizationId: ORG, code: 'orem', name: 'Orem', aliasKeys: ['orem'], stockPrefixes: ['M'], status: 'active', revision: 1, createdBy: actor, createdAt: now, updatedAt: now },
    ] as any[]);
    await db.collection('vehicles').insertOne({ _id: vehicleId, organizationId: ORG, vin: '1HGCY1F28SA017325', stockNumber: 'L23108', dealerCity: 'Orem', year: 2025, make: 'Honda', modelName: 'Accord', createdAt: now, updatedAt: now } as any);
  });

  afterAll(async () => {
    const db = mongoose.connection;
    await Lead.collection.deleteMany({ organizationId: orgId });
    await db.collection('users').deleteMany({ _id: staffUserId });
    await db.collection('crmlocations').deleteMany({ organizationId: ORG });
    await db.collection('vehicles').deleteMany({ _id: vehicleId });
  });

  beforeEach(() => {
    emitted.length = 0;
    (notifyOrgAdmins as jest.Mock).mockClear();
    (activityService.createActivity as jest.Mock).mockClear();
  });

  it('adds the customer, assigns them to the employee and uses the store from the car', async () => {
    const result: any = await createExtensionLead(ORG, adder, {
      firstName: '  Madelyn ',
      lastName: 'Wahlen',
      phone: '208-555-0119',
      vehicle: { year: '2025', make: 'Honda', model: 'Accord', vin: '1hgcy1f28sa017325' },
      note: 'Met her at the lot.',
      site: SITE,
    });
    expect(result.created).toBe(true);
    const lead: any = await Lead.findById(result.leadId).lean();
    expect(lead).toMatchObject({
      firstName: 'Madelyn',
      lastName: 'Wahlen',
      phone: '(208) 555-0119',
      normalizedPhone: '+12085550119',
      source: 'Manual Entry',
      firstContactBy: 'team',
      firstContactVia: 'added_by_team',
      channel: 'sms',
      status: 'New',
      location: 'Lehi',
      comments: '',
    });
    expect(String(lead.createdBy)).toBe(String(adder._id));
    expect(String(lead.assignedTo)).toBe(String(staffUserId));
    expect(lead.assignmentUnseenBy).toBeNull();
    expect(lead.assignmentHistory).toHaveLength(1);
    expect(String(lead.assignmentHistory[0].to)).toBe(String(staffUserId));
    expect(String(lead.vehicleId)).toBe(String(vehicleId));
    expect(lead.vehicle).toMatchObject({ year: '2025', make: 'Honda', model: 'Accord', vin: '1HGCY1F28SA017325' });
    expect(lead.notes).toHaveLength(1);
    expect(lead.notes[0]).toMatchObject({ text: 'Met her at the lot.\n\nAdded from the Chrome extension on actionauto.autodealerscloud.com.', authorName: 'Robin Tester', authorType: 'user' });
    expect(lead.aiFirstReplyTriggeredAt ?? null).toBeNull();
    expect(await mongoose.connection.collection('communicationmessages').countDocuments({ orgId })).toBe(0);
    expect(result.lookup.total).toBe(1);
    expect(result.lookup.matches[0]).toMatchObject({ id: result.leadId, name: 'Madelyn Wahlen', assignedTo: 'Robin Tester', location: 'Lehi', vehicle: '2025 Honda Accord', noteCount: 1 });
    expect(notifyOrgAdmins).toHaveBeenCalledTimes(1);
    const [notifyOrg, type, , message, metadata, excluded] = (notifyOrgAdmins as jest.Mock).mock.calls[0];
    expect([notifyOrg, type, excluded]).toEqual([ORG, 'new_lead', String(staffUserId)]);
    expect(message).toContain('Madelyn Wahlen via the Chrome extension');
    expect(metadata).toMatchObject({ leadId: result.leadId, source: 'Manual Entry' });
    expect(activityService.createActivity).toHaveBeenCalledWith(expect.objectContaining({ title: 'Lead added from the Chrome extension', metadata: expect.objectContaining({ site: 'actionauto.autodealerscloud.com' }) }));
    expect(emitted).toEqual([{ room: expect.stringContaining(ORG), event: 'lead:new' }]);
  });

  it('shows the existing lead instead of adding the same phone number twice', async () => {
    const before = await Lead.countDocuments({ organizationId: orgId });
    const result: any = await createExtensionLead(ORG, adder, { firstName: 'Madelyn', phone: '(208) 555-0119' });
    expect(result.created).toBe(false);
    expect(result.lookup.matches[0].name).toBe('Madelyn Wahlen');
    expect(result.leadId).toBe(result.lookup.matches[0].id);
    expect(await Lead.countDocuments({ organizationId: orgId })).toBe(before);
    expect(notifyOrgAdmins).not.toHaveBeenCalled();
  });

  it('uses the stock number start for the store when only a stock number is given', async () => {
    const result: any = await createExtensionLead(ORG, adder, { firstName: 'Oscar', lastName: 'Molina', phone: '385-555-0131', vehicle: { stock: 'm22810' } });
    const lead: any = await Lead.findById(result.leadId).lean();
    expect(lead.location).toBe('Orem');
    expect(lead.vehicle.stock).toBe('M22810');
    expect(lead.vehicleId ?? null).toBeNull();
  });

  it('adds an email-only customer and finds them again by email', async () => {
    const first: any = await createExtensionLead(ORG, adder, { firstName: 'Alex', lastName: 'Flores', email: ' Alex.Flores@Example.com ', site: 'not a url' });
    expect(first.created).toBe(true);
    const lead: any = await Lead.findById(first.leadId).lean();
    expect(lead).toMatchObject({ email: 'alex.flores@example.com', channel: 'email' });
    expect(lead.phone ?? '').toBe('');
    expect(lead.notes[0].text).toBe('Added from the Chrome extension.');
    expect(first.lookup.query.kind).toBe('email');
    const again: any = await createExtensionLead(ORG, adder, { firstName: 'Alex', email: 'alex.flores@example.com' });
    expect(again.created).toBe(false);
    expect(again.leadId).toBe(first.leadId);
  });

  it('leaves the lead unassigned when the employee has no matching Suprah user', async () => {
    const result: any = await createExtensionLead(ORG, stranger, { firstName: 'Brandon', phone: '385-555-0159' });
    const lead: any = await Lead.findById(result.leadId).lean();
    expect(lead.assignedTo ?? null).toBeNull();
    expect(lead.assignmentHistory).toHaveLength(0);
    expect(lead.notes[0].authorName).toBe('Sam Unlinked');
    expect(result.lookup.matches[0].assignedTo).toBe('');
  });

  it('refuses incomplete or wrong details with a plain message', async () => {
    const before = await Lead.countDocuments({ organizationId: orgId });
    expect(await errorOf(createExtensionLead(ORG, adder, { firstName: '   ', phone: '801-555-0170' }))).toEqual({ status: 400, message: "Enter the customer's first name." });
    expect(await errorOf(createExtensionLead(ORG, adder, { firstName: 'Kim' }))).toEqual({ status: 400, message: 'Add a phone number or an email address.' });
    expect(await errorOf(createExtensionLead(ORG, adder, { firstName: 'Kim', phone: '555-01' }))).toEqual({ status: 400, message: "That isn't a complete phone number." });
    expect(await errorOf(createExtensionLead(ORG, adder, { firstName: 'Kim', email: 'kim@' }))).toEqual({ status: 400, message: "That email address doesn't look right." });
    expect(await errorOf(createExtensionLead(ORG, adder, { firstName: 'Kim', phone: '801-555-0170', vehicle: { vin: '1HGCY1F28SA01732O' } }))).toEqual({ status: 400, message: 'The VIN must be 17 letters and numbers, without I, O or Q.' });
    expect(await errorOf(createExtensionLead(ORG, adder, { firstName: 'Kim', phone: '801-555-0170', vehicle: { year: '23' } }))).toEqual({ status: 400, message: 'The year must be 4 digits, like 2023.' });
    expect(await errorOf(createExtensionLead(ORG, adder, { firstName: 'Kim', phone: '801-555-0170', vehicle: { stock: 'L23 108' } }))).toEqual({ status: 400, message: 'The stock number can only have letters, numbers and dashes.' });
    expect(await errorOf(createExtensionLead(ORG, adder, { firstName: 'Kim', phone: '801-555-0170', note: 'x'.repeat(2001) }))).toEqual({ status: 400, message: 'The note can be up to 2,000 characters.' });
    expect(await errorOf(createExtensionLead(ORG, adder, { firstName: { name: 'Kim' } as any, phone: '801-555-0170' }))).toEqual({ status: 400, message: 'First name must be text.' });
    expect(await errorOf(createExtensionLead('not-an-org', adder, { firstName: 'Kim', phone: '801-555-0170' }))).toEqual({ status: 403, message: 'Your account is not linked to a dealership' });
    expect(await Lead.countDocuments({ organizationId: orgId })).toBe(before);
  });

  it('finds leads by name, in either order, with their phone or email', async () => {
    const full: any = await lookupLeadsByName(ORG, 'Madelyn Wahlen');
    expect(full.query).toEqual({ kind: 'name', display: 'Madelyn Wahlen' });
    expect(full.total).toBe(1);
    expect(full.matches[0]).toMatchObject({ name: 'Madelyn Wahlen', contact: '(208) 555-0119', assignedTo: 'Robin Tester' });
    expect((await lookupLeadsByName(ORG, 'wahlen madelyn')).total).toBe(1);
    expect((await lookupLeadsByName(ORG, 'MADELYN')).total).toBe(1);
    expect((await lookupLeadsByName(ORG, 'Wahl')).total).toBe(1);
    const emailOnly: any = await lookupLeadsByName(ORG, 'Alex Flores');
    expect(emailOnly.matches[0].contact).toBe('alex.flores@example.com');
    expect((await lookupLeadsByName(ORG, 'Nobody Here')).total).toBe(0);
    expect((await lookupLeadsByName(String(new mongoose.Types.ObjectId()), 'Madelyn Wahlen')).total).toBe(0);
  });

  it('treats a typed name as plain text, never as a pattern', async () => {
    for (const bad of ['Ma.*', '.*', 'O(scar', 'a', '12 Main', 'Madelyn Wahlen Jr Sr Esq', 'x'.repeat(61)]) {
      expect(await errorOf(lookupLeadsByName(ORG, bad))).toEqual({ status: 400, message: 'Search by first and last name, using letters only.' });
    }
    expect((nameLookupConditions("O'Neil")[0] as any).firstName.test("O'Neil-Smith")).toBe(true);
    expect(nameLookupConditions('Mary-Ann').length).toBe(2);
  });

  it('shows the phone or email on phone lookups too', async () => {
    const byPhone: any = await lookupLeadsByPhone(ORG, '208-555-0119');
    expect(byPhone.matches[0].contact).toBe('(208) 555-0119');
  });
});
