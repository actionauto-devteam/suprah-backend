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

import mongoose from 'mongoose';
import Lead from '../src/models/lead.model';
import Customer from '../src/models/Customer.model';
import { updateLeadDetails } from '../src/controllers/lead.controller';

const orgId = new mongoose.Types.ObjectId();
const ORG = String(orgId);
const staff = { _id: new mongoose.Types.ObjectId(), name: 'Staff', email: 'staff@example.com', role: 'admin' };

function response() {
  const res: any = { statusCode: 200, body: null };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: any) => { res.body = body; return res; };
  return res;
}

async function rename(leadId: unknown, body: Record<string, unknown>) {
  const res = response();
  await updateLeadDetails({ orgId: ORG, params: { id: String(leadId) }, body, user: staff, ip: '127.0.0.1' } as any, res);
  return res;
}

async function setup(customerFirst: string, customerLast = '') {
  const customer = await Customer.create({ organizationId: ORG, firstName: customerFirst, lastName: customerLast, phone: '+18015550142', isActive: true, createdBy: staff._id } as any);
  const lead = await Lead.create({
    organizationId: orgId,
    createdBy: staff._id,
    firstName: 'Unknown',
    lastName: '',
    phone: '+18015550142',
    source: 'SMS',
    channel: 'sms',
    status: 'New',
    comments: '',
    customerId: customer._id,
  } as any);
  return { customer, lead };
}

describe('Real-DB proof: fixing a name on a lead also fixes an Unknown saved contact (local MongoDB only)', () => {
  it('updates the saved contact when it is named Unknown', async () => {
    const { customer, lead } = await setup('Unknown');
    const res = await rename(lead._id, { firstName: 'Maria', lastName: 'Lopez' });
    expect(res.statusCode).toBe(200);
    const saved: any = await Customer.findById(customer._id).lean();
    expect([saved.firstName, saved.lastName]).toEqual(['Maria', 'Lopez']);
  });

  it('never overwrites a saved contact that already has a real name', async () => {
    const { customer, lead } = await setup('Daniel', 'Reyes');
    await rename(lead._id, { firstName: 'Maria', lastName: 'Lopez' });
    const saved: any = await Customer.findById(customer._id).lean();
    expect([saved.firstName, saved.lastName]).toEqual(['Daniel', 'Reyes']);
  });

  it('leaves the saved contact alone when the new name is still Unknown or only other details change', async () => {
    const { customer, lead } = await setup('Unknown');
    await rename(lead._id, { firstName: 'unknown' });
    await rename(lead._id, { address: '12 Test Way' });
    const saved: any = await Customer.findById(customer._id).lean();
    expect(saved.firstName).toBe('Unknown');
  });

  it('does not touch a saved contact of another dealership', async () => {
    const { lead } = await setup('Unknown');
    const other = await Customer.create({ organizationId: String(new mongoose.Types.ObjectId()), firstName: 'Unknown', lastName: '', phone: '+18015550143', isActive: true, createdBy: staff._id } as any);
    await Lead.updateOne({ _id: lead._id }, { $set: { customerId: other._id } });
    await rename(lead._id, { firstName: 'Maria', lastName: 'Lopez' });
    const saved: any = await Customer.findById(other._id).lean();
    expect(saved.firstName).toBe('Unknown');
  });
});
