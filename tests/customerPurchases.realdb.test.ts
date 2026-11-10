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
import Customer from '../src/models/Customer.model';
import CrmDeal from '../src/models/CrmDeal.model';
import CustomerPurchase from '../src/models/CustomerPurchase.model';
import CrmAutomation from '../src/models/CrmAutomation.model';
import CrmAutomationRun from '../src/models/CrmAutomationRun.model';
import { createDeal, updateDeal } from '../src/services/crmDeal.service';
import {
  createPurchase,
  deletePurchase,
  importPurchases,
  listCustomerPurchases,
  recordPurchaseFromSoldLead,
  updatePurchase,
} from '../src/services/customerPurchase.service';
import { runDueSteps } from '../src/services/crmAutomationEngine.service';
import { resolveCrmStaff } from '../src/utils/crmStaff';

const orgId = new mongoose.Types.ObjectId();
const org = String(orgId);
const adminId = new mongoose.Types.ObjectId();
const managerId = new mongoose.Types.ObjectId();
const rep1 = new mongoose.Types.ObjectId();
const rep2 = new mongoose.Types.ObjectId();
const customerId = new mongoose.Types.ObjectId();
const twinA = new mongoose.Types.ObjectId();
const twinB = new mongoose.Types.ObjectId();
const actor = { userId: String(adminId), name: 'Avery Admin' };
let seq = 0;

const staffOf = (id: mongoose.Types.ObjectId, role: string, name: string) => resolveCrmStaff(org, { _id: id, role, fullName: name, email: `${name.split(' ')[0].toLowerCase()}-${id}@example.com` });

async function lead(overrides: Record<string, any> = {}) {
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    organizationId: orgId,
    customerId,
    firstName: 'Rosa',
    lastName: 'Diaz',
    phone: `+1801555${String(4500 + seq++).padStart(4, '0')}`,
    status: 'Negotiating',
    source: 'Website Inquiry',
    channel: 'web',
    assignedTo: rep1,
    vehicle: { year: '2021', make: 'Toyota', model: 'RAV4', vin: '2t3p1rfv0mw000001', stock: 'A123' },
    statusHistory: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  await Lead.collection.insertOne(doc as any);
  return doc;
}

async function cleanup() {
  await Promise.all([
    Organization.collection.deleteMany({ _id: orgId }),
    User.collection.deleteMany({ organizationId: orgId }),
    Lead.collection.deleteMany({ organizationId: orgId }),
    Customer.collection.deleteMany({ organizationId: org }),
    CrmDeal.collection.deleteMany({ organizationId: org }),
    CustomerPurchase.collection.deleteMany({ organizationId: org }),
    CrmAutomation.collection.deleteMany({ organizationId: org }),
    CrmAutomationRun.collection.deleteMany({ organizationId: org }),
  ]);
}

describe('Real-DB: customer purchases (local test DB only)', () => {
  beforeAll(async () => {
    if (mongoose.connection.host !== '127.0.0.1' || mongoose.connection.port !== 27018 || !/_test$/.test(mongoose.connection.name)) throw new Error('Local test DB only');
    process.env.CRM_AUTOMATIONS_ENABLED = 'true';
    await cleanup();
    await CustomerPurchase.init();
    await Organization.collection.insertOne({ _id: orgId, name: 'Purchase Motors', slug: `p43-${orgId}`, status: 'active', metadata: {} } as any);
    await User.collection.insertMany([
      { _id: adminId, organizationId: orgId, name: 'Avery Admin', email: `avery-${adminId}@example.com`, role: 'admin', isActive: true },
      { _id: managerId, organizationId: orgId, name: 'Morgan Manager', email: `morgan-${managerId}@example.com`, role: 'employee', organizationRole: 'manager', isActive: true },
      { _id: rep1, organizationId: orgId, name: 'Riley One', email: `riley-${rep1}@example.com`, role: 'employee', isActive: true },
      { _id: rep2, organizationId: orgId, name: 'Sam Two', email: `sam-${rep2}@example.com`, role: 'employee', isActive: true },
    ] as any[]);
    await Customer.collection.insertMany([
      { _id: customerId, organizationId: org, firstName: 'Rosa', lastName: 'Diaz', email: 'rosa@example.com', phone: '+18015554400', normalizedEmail: 'rosa@example.com', normalizedPhone: '+18015554400', source: 'lead', isActive: true, transactions: [], conversations: [], stats: {} },
      { _id: twinA, organizationId: org, firstName: 'Twin', lastName: 'A', email: 'twin-a@example.com', phone: '+18015554401', normalizedEmail: 'twin-a@example.com', normalizedPhone: '+18015554401', source: 'lead', isActive: true, transactions: [], conversations: [], stats: {} },
      { _id: twinB, organizationId: org, firstName: 'Twin', lastName: 'B', email: 'twin-b@example.com', phone: '+18015554402', normalizedEmail: 'twin-b@example.com', normalizedPhone: '+18015554402', normalizedAlternatePhone: '+18015554401', source: 'lead', isActive: true, transactions: [], conversations: [], stats: {} },
    ] as any[]);
  });

  afterAll(async () => {
    await cleanup();
    delete process.env.CRM_AUTOMATIONS_ENABLED;
  });

  it('1. a deal marked Won records the purchase, follows later edits, and is removed if the deal leaves Won', async () => {
    const manager = await staffOf(managerId, 'manager', 'Morgan Manager');
    const target = await lead();
    const deal = await createDeal(org, manager, { leadId: String(target._id), amount: 24500 });
    await updateDeal(org, manager, deal.id, { stage: 'won' });
    let purchases: any[] = await CustomerPurchase.find({ dealId: deal.id }).lean();
    expect(purchases).toHaveLength(1);
    expect(purchases[0]).toMatchObject({ source: 'deal', salePrice: 24500, salespersonName: 'Riley One', vehicle: expect.objectContaining({ label: '2021 Toyota RAV4', vin: '2T3P1RFV0MW000001', stock: 'A123' }) });
    expect(String(purchases[0].customerId)).toBe(String(customerId));
    await updateDeal(org, manager, deal.id, { amount: 23900 });
    expect(((await CustomerPurchase.findOne({ dealId: deal.id }).lean()) as any).salePrice).toBe(23900);
    await updateDeal(org, manager, deal.id, { stage: 'negotiating' });
    expect(await CustomerPurchase.countDocuments({ dealId: deal.id })).toBe(0);
    await updateDeal(org, manager, deal.id, { stage: 'won' });
    purchases = await CustomerPurchase.find({ dealId: deal.id }).lean();
    expect(purchases).toHaveLength(1);
  });

  it('2. a lead marked Sold records one purchase, and a Won deal on that lead takes it over instead of adding a second', async () => {
    const manager = await staffOf(managerId, 'manager', 'Morgan Manager');
    const target = await lead({ status: 'Sold', vehicle: { year: '2019', make: 'Honda', model: 'Civic', stock: 'C77' } });
    await recordPurchaseFromSoldLead(org, target._id, actor);
    await recordPurchaseFromSoldLead(org, target._id, actor);
    const soldOnly: any[] = await CustomerPurchase.find({ leadId: target._id }).lean();
    expect(soldOnly).toHaveLength(1);
    expect(soldOnly[0]).toMatchObject({ source: 'lead_sold', salePrice: null, salespersonName: 'Riley One' });
    const deal = await createDeal(org, manager, { leadId: String(target._id), amount: 18000 });
    await updateDeal(org, manager, deal.id, { stage: 'won' });
    const after: any[] = await CustomerPurchase.find({ leadId: target._id }).lean();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ source: 'deal', salePrice: 18000 });
    expect(String(after[0].dealId)).toBe(deal.id);
    const notSold = await lead({ status: 'Contacted' });
    await recordPurchaseFromSoldLead(org, notSold._id, actor);
    expect(await CustomerPurchase.countDocuments({ leadId: notSold._id })).toBe(0);
  });

  it('3. staff can add, edit and remove purchases; only managers, admins and the person who added one can change it', async () => {
    const rep = await staffOf(rep1, 'employee', 'Riley One');
    const other = await staffOf(rep2, 'employee', 'Sam Two');
    const manager = await staffOf(managerId, 'manager', 'Morgan Manager');
    await expect(createPurchase(org, String(customerId), rep, { vehicle: {}, soldAt: '2026-11-01' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(createPurchase(org, String(customerId), rep, { vehicle: { label: 'Truck' }, soldAt: '2026-13-01' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(createPurchase(org, String(customerId), rep, { vehicle: { label: 'Truck' }, soldAt: '2026-11-01', salePrice: -1 })).rejects.toMatchObject({ statusCode: 400 });
    const added = await createPurchase(org, String(customerId), rep, { vehicle: { label: '2018 Ford F-150', vin: '1ftew1e5xjfa00001' }, soldAt: '2026-11-01', salePrice: '31,500', salespersonId: String(rep1), notes: 'Paid cash' });
    expect(added).toMatchObject({ source: 'manual', salePrice: 31500, salesperson: { id: String(rep1), name: 'Riley One' }, vehicle: expect.objectContaining({ vin: '1FTEW1E5XJFA00001' }) });
    expect(new Date(added.soldAt).toISOString().slice(0, 10)).toBe('2026-11-01');
    await expect(updatePurchase(org, String(customerId), added.id, other, { salePrice: 1 })).rejects.toMatchObject({ statusCode: 403 });
    const edited = await updatePurchase(org, String(customerId), added.id, rep, { salePrice: 30000 });
    expect(edited.salePrice).toBe(30000);
    const byManager = await updatePurchase(org, String(customerId), added.id, manager, { notes: 'Checked by manager' });
    expect(byManager.notes).toBe('Checked by manager');
    const list = await listCustomerPurchases(org, String(customerId));
    expect(list.items.map((item) => item.id)).toContain(added.id);
    expect(list.team.map((member) => member.name)).toEqual(expect.arrayContaining(['Riley One', 'Sam Two']));
    await expect(deletePurchase(org, String(customerId), added.id, other)).rejects.toMatchObject({ statusCode: 403 });
    await deletePurchase(org, String(customerId), added.id, rep);
    expect(await CustomerPurchase.exists({ _id: added.id })).toBeNull();
    await expect(listCustomerPurchases(org, String(new mongoose.Types.ObjectId()))).rejects.toMatchObject({ statusCode: 404 });
  });

  it('4. importing sales matches customers by email or phone, skips what it cannot place, and never adds the same sale twice', async () => {
    const admin = await staffOf(adminId, 'admin', 'Avery Admin');
    const rep = await staffOf(rep1, 'employee', 'Riley One');
    const rows = [
      { row: 2, email: 'ROSA@example.com', vin: '5yjsa1e2xff000001', year: '2015', make: 'Tesla', model: 'Model S', salePrice: '$24,500.00', soldAt: '2025-03-15', salesperson: 'riley one' },
      { row: 3, phone: '(801) 555-4400', stock: 'Z900', make: 'Jeep', model: 'Wrangler', salePrice: '', soldAt: '04/02/2025' },
      { row: 4, email: 'nobody@example.com', vin: 'X1', soldAt: '2025-01-01' },
      { row: 5, phone: '801-555-4401', vin: 'X2', soldAt: '2025-01-01' },
      { row: 6, email: 'rosa@example.com', vin: 'X3', soldAt: 'yesterday' },
      { row: 7, email: 'rosa@example.com', soldAt: '2025-01-01' },
      { row: 8, email: 'rosa@example.com', vin: 'X4', soldAt: '2025-01-01', salePrice: 'lots' },
    ];
    await expect(importPurchases(org, rep, rows)).rejects.toMatchObject({ statusCode: 403 });
    const first = await importPurchases(org, admin, rows);
    expect(first).toMatchObject({ added: 2, duplicates: 0, unmatched: 2, invalid: 3 });
    expect(first.problems.map((problem) => problem.row).sort()).toEqual([4, 5, 6, 7, 8]);
    expect(first.problems.find((problem) => problem.row === 5)?.reason).toBe('The phone and email match more than one customer');
    const tesla: any = await CustomerPurchase.findOne({ organizationId: org, 'vehicle.vin': '5YJSA1E2XFF000001' }).lean();
    expect(tesla).toMatchObject({ source: 'import', salePrice: 24500, salespersonName: 'Riley One', vehicle: expect.objectContaining({ label: '2015 Tesla Model S' }) });
    expect(String(tesla.salespersonId)).toBe(String(rep1));
    expect(tesla.soldAt.toISOString().slice(0, 10)).toBe('2025-03-15');
    const jeep: any = await CustomerPurchase.findOne({ organizationId: org, 'vehicle.stock': 'Z900' }).lean();
    expect(jeep.soldAt.toISOString().slice(0, 10)).toBe('2025-04-02');
    expect(jeep.salePrice).toBeNull();
    const again = await importPurchases(org, admin, rows);
    expect(again).toMatchObject({ added: 0, duplicates: 2 });
    await expect(importPurchases(org, admin, [])).rejects.toMatchObject({ statusCode: 400 });
  });

  it('5. an automation that marks a lead Sold also records the purchase', async () => {
    const target = await lead({ status: 'Contacted' });
    const steps = [{ id: 's1', type: 'update_lead_status', config: { status: 'Sold' } }];
    const auto = await CrmAutomation.create({
      organizationId: org, name: 'Mark sold', locations: { mode: 'all', ids: [] },
      trigger: { source: 'suprah', event: 'appointment_completed', filters: [], repeat: { mode: 'every_time', days: null, per: [] }, sendingHours: 'any_time', stopOnReply: false, cancelFirstOnReply: false, aiContinuesOnReply: false, stopOnFailure: false },
      steps, status: 'active', createdBy: actor, updatedBy: actor,
    });
    await CrmAutomationRun.create({
      organizationId: org, automationId: auto._id, automationName: auto.name, mode: 'live', event: 'appointment_completed', eventKey: `p43:${target._id}`,
      triggerAt: new Date(), contact: { leadId: String(target._id), name: 'Rosa Diaz', firstName: 'Rosa', phone: '', email: '' },
      settings: { sendingHours: 'any_time', stopOnReply: false, cancelFirstOnReply: false, aiContinuesOnReply: false, stopOnFailure: false },
      steps, status: 'waiting', nextRunAt: new Date(Date.now() - 1000),
    });
    await runDueSteps(new Date());
    for (let attempt = 0; attempt < 50 && !(await CustomerPurchase.exists({ leadId: target._id })); attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
    const purchase: any = await CustomerPurchase.findOne({ leadId: target._id }).lean();
    expect(purchase).toMatchObject({ source: 'lead_sold', createdBy: expect.objectContaining({ userId: 'automation' }) });
  });
});
