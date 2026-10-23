import mongoose from 'mongoose';
import Lead from '../src/models/lead.model';
import LeadInquiry from '../src/models/LeadInquiry.model';
import LeadIntakeLock from '../src/models/LeadIntakeLock.model';
import { findLeadAssociation } from '../src/services/leadLifecycle.service';
import {
  claimInquiryProcessing,
  completeInquiryAssociation,
  findLeadCreatedForInquiry,
  recordInquiryEvent,
} from '../src/services/leadInquiry.service';
import {
  acquireLeadIntakeLock,
  leadIntakeLockKeys,
  releaseLeadIntakeLock,
  renewLeadIntakeLock,
} from '../src/services/leadIntakeLock.service';

const org = new mongoose.Types.ObjectId();
const otherOrg = new mongoose.Types.ObjectId();
const createdBy = new mongoose.Types.ObjectId();
const PHONE = '+13855550150';
const previousLeadId = new mongoose.Types.ObjectId();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const event = (gmailMessageId: string) =>
  recordInquiryEvent({
    organizationId: String(org),
    kind: 'provider_inquiry',
    receivedAt: new Date(),
    contact: { phone: PHONE },
    sourceIds: { gmailMessageId },
  });

async function createLeadForDecision(eventId: unknown, slots: string[], organizationId = org) {
  return Lead.collection.insertOne({
    organizationId,
    createdBy,
    firstName: 'Pat',
    status: 'New',
    phone: PHONE,
    normalizedPhone: PHONE,
    normalizedEmail: null,
    sourceInquiryId: eventId,
    intakeSlots: slots,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe('Real-DB L1: a slow worker cannot commit an outdated decision', () => {
  beforeAll(async () => {
    jest.setTimeout(60000);
    await Promise.all([Lead.createIndexes(), LeadInquiry.createIndexes(), LeadIntakeLock.createIndexes()]);
    await Lead.collection.insertOne({
      _id: previousLeadId,
      organizationId: org,
      createdBy,
      firstName: 'Pat',
      status: 'Closed',
      phone: PHONE,
      normalizedPhone: PHONE,
      normalizedEmail: null,
      statusHistory: [{ from: 'New', to: 'Closed', changedAt: new Date('2026-10-05T10:00:00Z') }],
    });
  });

  afterAll(async () => {
    await Lead.deleteMany({ organizationId: { $in: [org, otherOrg] } });
    await LeadInquiry.deleteMany({ organizationId: { $in: [org, otherOrg] } });
    await LeadIntakeLock.deleteMany({ organizationId: { $in: [org, otherOrg] } });
  });

  it('blocks the stale create, rejects its late commit, and recovers by appending to the winner', async () => {
    const keys = leadIntakeLockKeys({ phone: PHONE });
    const eventA = (await event('gm-race-a')).event;
    const eventB = (await event('gm-race-b')).event;

    const lockA = await acquireLeadIntakeLock(String(org), keys, { owner: 'worker-a', leaseMs: 60 });
    expect(await claimInquiryProcessing(eventA._id, 'worker-a', { leaseMs: 80 })).toBeTruthy();
    const decisionA = await findLeadAssociation({ organizationId: String(org), phone: PHONE });
    expect(decisionA).toMatchObject({ action: 'create', previousLeadIds: [String(previousLeadId)] });

    await sleep(120);

    const lockB = await acquireLeadIntakeLock(String(org), keys, { owner: 'worker-b', waitMs: 0 });
    expect(lockB?.owner).toBe('worker-b');
    expect(await claimInquiryProcessing(eventB._id, 'worker-b')).toBeTruthy();
    const decisionB = await findLeadAssociation({ organizationId: String(org), phone: PHONE });
    expect(decisionB.action).toBe('create');
    expect(decisionB.intakeSlots).toEqual(decisionA.intakeSlots);
    const leadB = await createLeadForDecision(eventB._id, decisionB.intakeSlots!);
    expect(
      await completeInquiryAssociation(eventB._id, 'worker-b', {
        state: 'associated',
        leadId: leadB.insertedId,
        outcome: 'created_lead',
        reason: decisionB.reason,
      }),
    ).toBeTruthy();
    await releaseLeadIntakeLock(lockB!);

    expect(await renewLeadIntakeLock(lockA!)).toBe(false);
    await expect(createLeadForDecision(eventA._id, decisionA.intakeSlots!)).rejects.toMatchObject({ code: 11000 });
    expect(
      await completeInquiryAssociation(eventA._id, 'worker-a', {
        state: 'associated',
        leadId: previousLeadId,
        outcome: 'created_lead',
        reason: 'stale',
      }),
    ).toBeNull();
    await releaseLeadIntakeLock(lockA!);

    expect(await claimInquiryProcessing(eventA._id, 'worker-a-retry')).toBeTruthy();
    expect(await findLeadCreatedForInquiry(String(org), eventA._id)).toBeNull();
    const retry = await findLeadAssociation({ organizationId: String(org), phone: PHONE });
    expect(retry).toMatchObject({ action: 'append', leadId: String(leadB.insertedId) });
    const appended = await completeInquiryAssociation(eventA._id, 'worker-a-retry', {
      state: 'associated',
      leadId: retry.leadId,
      outcome: 'appended',
      reason: retry.reason,
    });
    expect(appended?.association).toMatchObject({ state: 'associated', outcome: 'appended' });

    const open: any[] = await Lead.find({ organizationId: org, normalizedPhone: PHONE, status: { $ne: 'Closed' } }).lean();
    expect(open).toHaveLength(1);
    const previous: any = await Lead.findById(previousLeadId).lean();
    expect(previous.status).toBe('Closed');
  });

  it('allows a fresh lead again once the winner is finished, and never blocks manual or older leads', async () => {
    const winner: any = await Lead.findOne({ organizationId: org, normalizedPhone: PHONE, status: 'New' }).lean();
    await Lead.collection.updateOne(
      { _id: winner._id },
      { $set: { status: 'Sold', statusHistory: [{ from: 'New', to: 'Sold', changedAt: new Date('2026-10-20T10:00:00Z') }] } },
    );
    const next = (await event('gm-race-c')).event;
    const decision = await findLeadAssociation({ organizationId: String(org), phone: PHONE });
    expect(decision.action).toBe('create');
    expect(decision.intakeSlots).toEqual([`phone:${PHONE}|after:${winner._id}@${new Date('2026-10-20T10:00:00Z').getTime()}`]);
    await expect(createLeadForDecision(next._id, decision.intakeSlots!)).resolves.toBeTruthy();

    await expect(
      Lead.collection.insertOne({ organizationId: org, createdBy, firstName: 'Manual create anyway', status: 'New', phone: PHONE }),
    ).resolves.toBeTruthy();
    await expect(createLeadForDecision(new mongoose.Types.ObjectId(), decision.intakeSlots!, otherOrg)).resolves.toBeTruthy();
  });
});
