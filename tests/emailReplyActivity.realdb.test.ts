import mongoose from 'mongoose';

const mockEmit = jest.fn();
const mockTo = jest.fn(() => ({ emit: mockEmit }));
jest.mock('../src/utils/socketEmitter', () => ({ getSocketIO: () => ({ to: mockTo }), emitToOrg: jest.fn() }));
jest.mock('../src/services/cache.service', () => ({ cacheService: { del: jest.fn().mockResolvedValue(undefined), get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) } }));

import Lead from '../src/models/lead.model';
import { notifyCustomerEmailReply } from '../src/services/orgGmail.service';

const stamp = Date.now();
const orgId = new mongoose.Types.ObjectId();
const otherOrgId = new mongoose.Types.ObjectId();
const userId = new mongoose.Types.ObjectId();
const thread = `reply-thread-${stamp}`;
const twoDaysAgo = new Date(Date.now() - 2 * 86400000);

describe('Customer email replies show up live on the lead (real database)', () => {
  let lead: any;
  let foreign: any;

  beforeAll(async () => {
    if (mongoose.connection.readyState !== 1) await mongoose.connection.asPromise();
    lead = await Lead.create({ organizationId: orgId, createdBy: userId, firstName: 'Email', lastName: `Replier${stamp}`, email: `replier-${stamp}@example.com`, channel: 'email', source: 'Manual Entry', status: 'Contacted', threadId: thread, isRead: true, createdAt: twoDaysAgo, followUp: { lastCustomerActivityAt: twoDaysAgo } });
    foreign = await Lead.create({ organizationId: otherOrgId, createdBy: userId, firstName: 'Other', lastName: `Dealer${stamp}`, email: `other-${stamp}@example.com`, channel: 'email', source: 'Manual Entry', status: 'New', threadId: thread, isRead: true, followUp: { lastCustomerActivityAt: twoDaysAgo } });
  });

  beforeEach(() => jest.clearAllMocks());

  afterAll(async () => {
    await Lead.deleteMany({ _id: { $in: [lead._id, foreign._id] } });
  });

  it('marks the lead unread, moves its latest activity to the reply time and tells every open Leads page', async () => {
    const replyAt = Date.now() - 60000;
    expect(await notifyCustomerEmailReply(String(orgId), { threadId: thread, internalDate: String(replyAt) })).toBe(true);
    const updated: any = await Lead.findById(lead._id).lean();
    expect(updated.isRead).toBe(false);
    expect(new Date(updated.followUp.lastCustomerActivityAt).getTime()).toBe(replyAt);
    expect(mockTo).toHaveBeenCalledWith(`org:${orgId}:crm-staff`);
    expect(mockEmit).toHaveBeenCalledWith('email:message:new', { leadId: String(lead._id), threadId: thread });
    expect(mockEmit).toHaveBeenCalledWith('lead:update', { leadId: String(lead._id) });
  });

  it('never moves the activity time backwards for an older reply seen again', async () => {
    const before: any = await Lead.findById(lead._id).lean();
    await notifyCustomerEmailReply(String(orgId), { threadId: thread, internalDate: String(twoDaysAgo.getTime() + 1000) });
    const after: any = await Lead.findById(lead._id).lean();
    expect(new Date(after.followUp.lastCustomerActivityAt).getTime()).toBe(new Date(before.followUp.lastCustomerActivityAt).getTime());
  });

  it('ignores threads that belong to no lead and never touches another dealership', async () => {
    expect(await notifyCustomerEmailReply(String(orgId), { threadId: `unknown-${stamp}`, internalDate: String(Date.now()) })).toBe(false);
    expect(await notifyCustomerEmailReply(String(orgId), { internalDate: String(Date.now()) })).toBe(false);
    expect(mockEmit).not.toHaveBeenCalled();
    const other: any = await Lead.findById(foreign._id).lean();
    expect(other.isRead).toBe(true);
    expect(new Date(other.followUp.lastCustomerActivityAt).getTime()).toBe(twoDaysAgo.getTime());
  });
});
