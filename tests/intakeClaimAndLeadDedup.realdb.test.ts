import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import Lead from '../src/models/lead.model';
import IntakeClaim from '../src/models/IntakeClaim.model';

describe('Real-DB proof: IntakeClaim and Lead messageId unique indexes actually block duplicates', () => {
  let testOrg: any;

  beforeAll(async () => {
    jest.setTimeout(30000);
    await Lead.init();
    await IntakeClaim.init();

    testOrg = await Organization.create({
      name: 'Dedup Index Test Org',
      slug: 'dedup-index-test-' + Date.now(),
      status: 'active',
    });
  });

  afterAll(async () => {
    if (testOrg) {
      await IntakeClaim.deleteMany({ organizationId: testOrg._id });
      await Lead.deleteMany({ organizationId: testOrg._id });
      await Organization.deleteOne({ _id: testOrg._id });
    }
  });

  it('IntakeClaim unique {organizationId, kind, claimKey} index rejects a raw duplicate insert', async () => {
    const claimKey = 'realdb-claim-' + Date.now();
    await IntakeClaim.create({
      organizationId: testOrg._id,
      kind: 'webchat_session',
      claimKey,
      expiresAt: new Date(Date.now() + 60000),
    });

    await expect(
      IntakeClaim.create({
        organizationId: testOrg._id,
        kind: 'webchat_session',
        claimKey,
        expiresAt: new Date(Date.now() + 60000),
      }),
    ).rejects.toMatchObject({ code: 11000 });

    const count = await IntakeClaim.countDocuments({ organizationId: testOrg._id, kind: 'webchat_session', claimKey });
    expect(count).toBe(1);
  });

  it('IntakeClaim findOneAndUpdate upsert lets exactly one of two concurrent claims win the same key', async () => {
    const claimKey = 'realdb-race-' + Date.now();

    const attempt = () =>
      IntakeClaim.findOneAndUpdate(
        { organizationId: testOrg._id, kind: 'test_drive_booking', claimKey },
        {
          $setOnInsert: {
            organizationId: testOrg._id,
            kind: 'test_drive_booking',
            claimKey,
            expiresAt: new Date(Date.now() + 60000),
          },
        },
        { new: true, upsert: true, includeResultMetadata: true },
      );

    const [first, second] = await Promise.all([attempt(), attempt()]);
    const updatedExistingFlags = [first.lastErrorObject?.updatedExisting, second.lastErrorObject?.updatedExisting];

    expect(updatedExistingFlags.filter((v) => v === false)).toHaveLength(1);
    expect(updatedExistingFlags.filter((v) => v === true)).toHaveLength(1);

    const count = await IntakeClaim.countDocuments({ organizationId: testOrg._id, kind: 'test_drive_booking', claimKey });
    expect(count).toBe(1);
  });

  it('Lead unique {organizationId, messageId} index rejects a raw duplicate insert', async () => {
    const messageId = 'realdb-msg-' + Date.now();
    await Lead.create({
      organizationId: testOrg._id,
      createdBy: new mongoose.Types.ObjectId(),
      firstName: 'Jordan',
      lastName: 'Lee',
      messageId,
      channel: 'email',
      source: 'Gmail Sync',
    });

    await expect(
      Lead.create({
        organizationId: testOrg._id,
        createdBy: new mongoose.Types.ObjectId(),
        firstName: 'Duplicate',
        lastName: 'Attempt',
        messageId,
        channel: 'email',
        source: 'Gmail Sync',
      }),
    ).rejects.toMatchObject({ code: 11000 });

    const count = await Lead.countDocuments({ organizationId: testOrg._id, messageId });
    expect(count).toBe(1);
  });

  it('Lead findOneAndUpdate upsert on {organizationId, messageId} lets only one of two concurrent syncs win the same message', async () => {
    const messageId = 'realdb-msg-race-' + Date.now();
    const systemUserId = new mongoose.Types.ObjectId();

    const attempt = () =>
      Lead.findOneAndUpdate(
        { organizationId: testOrg._id, messageId },
        {
          $setOnInsert: {
            organizationId: testOrg._id,
            createdBy: systemUserId,
            firstName: 'Race',
            lastName: 'Winner',
            messageId,
            threadId: 'realdb-thread-race',
            channel: 'email',
            source: 'Gmail Sync',
          },
        },
        { new: true, upsert: true, includeResultMetadata: true, setDefaultsOnInsert: true },
      );

    const [first, second] = await Promise.all([attempt(), attempt()]);
    const updatedExistingFlags = [first.lastErrorObject?.updatedExisting, second.lastErrorObject?.updatedExisting];

    expect(updatedExistingFlags.filter((v) => v === false)).toHaveLength(1);
    expect(updatedExistingFlags.filter((v) => v === true)).toHaveLength(1);

    const count = await Lead.countDocuments({ organizationId: testOrg._id, messageId });
    expect(count).toBe(1);
  });

  it('Two different messageIds for the same org are NOT blocked by the unique index (sanity check)', async () => {
    const base = 'realdb-distinct-' + Date.now();
    await Lead.create({
      organizationId: testOrg._id,
      createdBy: new mongoose.Types.ObjectId(),
      firstName: 'A',
      lastName: 'One',
      messageId: base + '-a',
      channel: 'email',
      source: 'Gmail Sync',
    });
    await Lead.create({
      organizationId: testOrg._id,
      createdBy: new mongoose.Types.ObjectId(),
      firstName: 'B',
      lastName: 'Two',
      messageId: base + '-b',
      channel: 'email',
      source: 'Gmail Sync',
    });

    const count = await Lead.countDocuments({ organizationId: testOrg._id, messageId: { $in: [base + '-a', base + '-b'] } });
    expect(count).toBe(2);
  });
});
