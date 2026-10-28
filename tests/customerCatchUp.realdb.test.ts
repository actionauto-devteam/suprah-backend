import request from 'supertest';
import mongoose from 'mongoose';
import app from '../src/server';
import Lead from '../src/models/lead.model';
import Customer from '../src/models/Customer.model';
import User from '../src/models/User.model';
import Organization from '../src/models/Organization.model';
import tokenService from '../src/services/token.service';
import { retryPendingLeadCustomers } from '../src/services/customerIdentity.service';
import { catchUpLeadCustomersInBackground, resetCustomerCatchUpCursor } from '../src/services/customerCatchUp.service';
import { CUSTOMER_IDENTITY_INDEXES } from '../src/constants/customerIdentityIndexes';
import * as identityIndexes from '../src/services/customerIdentityIndexes.service';

const stamp = Date.now();
const mail = (name: string) => `${name}.${stamp}@example.com`;

describe('Customer Records catch up old leads automatically (real database)', () => {
  let org: any;
  let otherOrg: any;
  let admin: any;
  let employee: any;
  let adminToken: string;
  let employeeToken: string;
  const ids: Record<string, any> = {};

  const legacyCustomer = async (doc: Record<string, unknown>) => (await Customer.collection.insertOne({
    organizationId: String(org._id), createdBy: admin._id, source: 'lead', isActive: true, transactions: [], conversations: [],
    createdAt: new Date('2026-09-22T15:00:00Z'), updatedAt: new Date('2026-09-22T15:00:00Z'), ...doc,
  })).insertedId;
  const oldLead = async (doc: Record<string, unknown>, organizationId: unknown = org._id) => (await Lead.collection.insertOne({
    organizationId, createdBy: admin._id, status: 'New', channel: 'adf', source: 'Third-Party Lead',
    createdAt: new Date('2026-10-05T15:00:00Z'), updatedAt: new Date('2026-10-05T15:00:00Z'), ...doc,
  })).insertedId;
  const status = (token = adminToken) => request(app).get('/api/crm/customer-records/catch-up').set('Authorization', `Bearer ${token}`);
  const runUntilDone = async (options: { leadBatchSize?: number; customerBatchSize?: number }) => {
    let ticks = 0;
    let quiet = 0;
    while (quiet < 2 && ticks < 50) {
      await retryPendingLeadCustomers();
      const result = await catchUpLeadCustomersInBackground(options);
      ticks++;
      quiet = result.prepared || result.processed ? 0 : quiet + 1;
    }
    return ticks;
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState !== 1) await mongoose.connection.asPromise();
    const db = mongoose.connection.db!;
    for (const index of CUSTOMER_IDENTITY_INDEXES) {
      await db.collection(index.collection).createIndex(index.key, {
        name: index.name,
        ...(index.unique ? { unique: true } : {}),
        ...(index.partialFilterExpression ? { partialFilterExpression: index.partialFilterExpression } : {}),
      });
    }
    resetCustomerCatchUpCursor();
    org = await Organization.create({ name: 'Catch-up Org', slug: `catchup-${stamp}`, status: 'active' });
    otherOrg = await Organization.create({ name: 'Catch-up Other Org', slug: `catchup-other-${stamp}`, status: 'active' });
    admin = await User.create({
      email: `catchup-admin-${stamp}@example.com`, password: 'Password123!', name: 'Catch-up Admin', role: 'admin',
      organizationId: org._id, organizationRole: 'admin', emailVerified: true, onboardingCompleted: true, isActive: true,
    });
    employee = await User.create({
      email: `catchup-employee-${stamp}@example.com`, password: 'Password123!', name: 'Catch-up Employee', role: 'employee',
      organizationId: org._id, emailVerified: true, onboardingCompleted: true, isActive: true,
    });
    adminToken = tokenService.generateAccessToken(admin);
    employeeToken = tokenService.generateAccessToken(employee);

    ids.mark = await legacyCustomer({ firstName: 'Mark', lastName: 'Legacy', email: mail('mark'), phone: '+18015550181' });
    ids.twinA = await legacyCustomer({ firstName: 'Twin', lastName: 'A', email: mail('twin.a'), phone: '+18015550182' });
    ids.twinB = await legacyCustomer({ firstName: 'Twin', lastName: 'B', email: mail('twin.b'), phone: '+18015550182' });
    ids.otherOrgCustomer = (await Customer.collection.insertOne({
      organizationId: String(otherOrg._id), createdBy: admin._id, firstName: 'Olive', lastName: 'Other', email: mail('olive'), source: 'lead', isActive: true,
    })).insertedId;

    ids.oldMark = await oldLead({ firstName: 'Mark', lastName: 'Legacy', email: mail('Mark').replace('example.com', 'Example.com') });
    ids.nora1 = await oldLead({ firstName: 'Nora', lastName: 'New', email: mail('nora'), phone: '+18015550183', vehicle: { year: '2022', make: 'Toyota', model: 'Tacoma' } });
    ids.nora2 = await oldLead({ firstName: 'Nora', lastName: 'New', email: mail('nora'), vehicle: { year: '2021', make: 'Ford', model: 'F-150' } });
    ids.noContact = await oldLead({ firstName: 'No', lastName: 'Contact' });
    ids.demo = await oldLead({ firstName: 'Demo', lastName: 'Lead', phone: '+18015550184', source: 'Demo', channel: 'sms' });
    ids.ambiguous = await oldLead({ firstName: 'Twin', lastName: 'Caller', phone: '+18015550182', channel: 'sms', source: 'Inbound SMS' });
    ids.noReply = await oldLead({ firstName: 'Cars', lastName: 'Notice', email: 'noreply@cars-provider.example', channel: 'email', source: 'Email Inquiry' });
    ids.noReplyAgain = await oldLead({ firstName: 'Cars', lastName: 'Notice', email: 'noreply@cars-provider.example', channel: 'email', source: 'Email Inquiry' });
    ids.providerWithPhone = await oldLead({ firstName: 'Paula', lastName: 'Provider', email: 'leads@dealerscloud.com', phone: '+18015550185', channel: 'email', source: 'Email Inquiry' });
    ids.retry = await oldLead({ firstName: 'Riley', lastName: 'Retry', email: mail('riley'), customerLink: { status: 'retry', reason: 'synchronization_failed', nextRetryAt: new Date(Date.now() - 1000) } });
    ids.alreadyLinked = await oldLead({ firstName: 'Mark', lastName: 'Legacy', phone: '+18015550181', customerId: ids.mark, customerLink: { status: 'linked', reason: 'exact_normalized_contact' } });
    ids.foreign = await oldLead({ firstName: 'Olive', lastName: 'Other', email: mail('olive') }, otherOrg._id);
    ids.noOrg = await oldLead({ firstName: 'Lost', lastName: 'Org', email: mail('lost') }, null);
  });

  afterAll(async () => {
    const db = mongoose.connection.db!;
    await Lead.deleteMany({ organizationId: { $in: [org._id, otherOrg._id] } });
    await Lead.deleteMany({ _id: ids.noOrg });
    await Customer.deleteMany({ organizationId: { $in: [String(org._id), String(otherOrg._id)] } });
    await db.collection('customeridentitylocks').deleteMany({ organizationId: { $in: [String(org._id), String(otherOrg._id)] } });
    await User.deleteMany({ _id: { $in: [admin._id, employee._id] } });
    await Organization.deleteMany({ _id: { $in: [org._id, otherOrg._id] } });
  });

  it('admins see how many leads are still waiting; employees see nothing; there is no manual button any more', async () => {
    expect((await status().expect(200)).body.data).toEqual({ canView: true, ready: true, remaining: 10 });
    expect((await status(employeeToken).expect(200)).body.data).toEqual({ canView: false, ready: true, remaining: 0 });
    await request(app).post('/api/crm/customer-records/catch-up').set('Authorization', `Bearer ${adminToken}`).send({ apply: true }).expect(404);
  });

  it('waits and changes nothing while the database still has the old email index', async () => {
    const spy = jest.spyOn(identityIndexes, 'verifyCustomerIdentityIndexes').mockResolvedValue({ ready: false, required: [], obsolete: ['organizationId_1_email_1'] } as any);
    try {
      expect(await catchUpLeadCustomersInBackground()).toEqual({ ready: false, prepared: 0, processed: 0 });
      expect((await status().expect(200)).body.data).toMatchObject({ ready: false, remaining: 10 });
      expect(await Customer.countDocuments({ organizationId: String(org._id), identityVersion: 1 })).toBe(0);
      expect(((await Lead.findById(ids.oldMark).lean()) as any).customerLink).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('after the index is removed, it finishes on its own in small batches', async () => {
    const customersBefore = await Customer.countDocuments({ organizationId: String(org._id) });
    const ticks = await runUntilDone({ leadBatchSize: 3, customerBatchSize: 2 });
    expect(ticks).toBeGreaterThan(3);
    expect((await status().expect(200)).body.data).toEqual({ canView: true, ready: true, remaining: 0 });

    const legacy: any = await Customer.findById(ids.mark).lean();
    expect(legacy).toMatchObject({ identityVersion: 1, normalizedEmail: mail('mark'), normalizedPhone: '+18015550181', firstName: 'Mark', email: mail('mark') });
    const twinA: any = await Customer.findById(ids.twinA).lean();
    expect(twinA).toMatchObject({ identityVersion: 1, normalizedPhone: '+18015550182' });
    expect(twinA.updatedAt.toISOString()).toBe('2026-09-22T15:00:00.000Z');

    const oldMark: any = await Lead.findById(ids.oldMark).lean();
    expect(oldMark.customerLink.status).toBe('linked');
    expect(String(oldMark.customerId)).toBe(String(ids.mark));
    const nora1: any = await Lead.findById(ids.nora1).lean();
    const nora2: any = await Lead.findById(ids.nora2).lean();
    expect(String(nora1.customerId)).toBe(String(nora2.customerId));
    expect(await Customer.findById(nora1.customerId).lean()).toMatchObject({ firstName: 'Nora', email: mail('nora') });
    expect(((await Lead.findById(ids.retry).lean()) as any).customerLink.status).toBe('linked');
    expect(((await Lead.findById(ids.noContact).lean()) as any).customerLink.status).toBe('unresolved');
    expect(((await Lead.findById(ids.demo).lean()) as any).customerLink.reason).toBe('demo_excluded');
    expect(((await Lead.findById(ids.ambiguous).lean()) as any).customerLink.status).toBe('ambiguous');

    const created = await Customer.countDocuments({ organizationId: String(org._id) }) - customersBefore;
    expect(created).toBe(3);
  });

  it('never turns a lead provider or no-reply address into one shared customer', async () => {
    const noReply: any = await Lead.findById(ids.noReply).lean();
    const noReplyAgain: any = await Lead.findById(ids.noReplyAgain).lean();
    expect(noReply.identityEmailExcluded).toBe(true);
    expect(noReply.customerId).toBeUndefined();
    expect(noReplyAgain.customerId).toBeUndefined();
    expect(await Customer.countDocuments({ normalizedEmail: 'noreply@cars-provider.example' })).toBe(0);
    expect(await Customer.countDocuments({ normalizedEmail: 'leads@dealerscloud.com' })).toBe(0);
    const provider: any = await Lead.findById(ids.providerWithPhone).lean();
    expect(provider.customerLink.status).toBe('linked');
    const paula: any = await Customer.findById(provider.customerId).lean();
    expect(paula).toMatchObject({ firstName: 'Paula', phone: '+18015550185' });
    expect(paula.email).toBeUndefined();
  });

  it('handles every dealership, skips leads without a dealership, and running again changes nothing', async () => {
    expect(((await Lead.findById(ids.foreign).lean()) as any).customerLink.status).toBe('linked');
    expect(((await Lead.findById(ids.noOrg).lean()) as any).customerLink).toBeUndefined();
    const before = await Customer.countDocuments({});
    const again = await catchUpLeadCustomersInBackground();
    expect(again).toMatchObject({ ready: true, processed: 0 });
    expect(await Customer.countDocuments({})).toBe(before);
  });

  it('Customer Records now shows the leads on each customer', async () => {
    const markProfile = await request(app).get(`/api/crm/customer-records/${ids.mark}`).set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(markProfile.body.data.summary.leads.total).toBe(2);
    const list = await request(app).get(`/api/crm/customer-records?search=${encodeURIComponent(mail('nora'))}`).set('Authorization', `Bearer ${adminToken}`).expect(200);
    expect(list.body.data.customers).toHaveLength(1);
    expect(list.body.data.customers[0].leads.total).toBe(2);
  });
});
