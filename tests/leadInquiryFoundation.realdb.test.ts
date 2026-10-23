import mongoose from 'mongoose';
import LeadInquiry from '../src/models/LeadInquiry.model';
import Lead from '../src/models/lead.model';
import {
  claimInquiryProcessing,
  claimInquirySideEffect,
  completeInquiryAssociation,
  detectInquiryDuplicate,
  failInquiryProcessing,
  findLeadCreatedForInquiry,
  findLegacyLeadSourceDuplicate,
  findRecentContentDuplicate,
  finishInquirySideEffect,
  markExpiredExternalSideEffectsUnknown,
  recordInquiryEvent,
} from '../src/services/leadInquiry.service';
import { buildInquiryContentKey, buildInquiryFingerprint, buildProviderInquiryKey } from '../src/utils/inquiryKeys';

const orgA = new mongoose.Types.ObjectId();
const orgB = new mongoose.Types.ObjectId();
const receivedAt = new Date('2026-10-22T15:28:00Z');

const inquiry = (organizationId: mongoose.Types.ObjectId, sourceIds: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  organizationId: String(organizationId),
  kind: 'provider_inquiry' as const,
  receivedAt,
  source: 'Third-Party Lead',
  sourceProvider: 'CarFax',
  contact: { firstName: 'Pat', lastName: 'Lee', phone: '385-503-5869', email: 'pat@example.com' },
  vehicle: { year: '2022', make: 'Honda', model: 'Civic' },
  comments: 'Is it available?',
  sourceIds,
  ...extra,
});

describe('Real-DB L1: lead inquiry records, indexes and recovery', () => {
  beforeAll(async () => {
    jest.setTimeout(60000);
    await Lead.collection.insertMany([
      { organizationId: orgA, firstName: 'Legacy', status: 'Closed', phone: '3855035869', createdAt: new Date('2026-10-01T10:00:00Z') },
      { organizationId: orgA, firstName: 'Legacy Gmail', status: 'New', messageId: 'legacy-gmail-1', threadId: 'thread-legacy' },
      { organizationId: orgA, firstName: 'Legacy ADF', status: 'Contacted', ingestionFingerprint: 'adf:legacy-fingerprint' },
      { organizationId: orgB, firstName: 'Other org', status: 'New', messageId: 'legacy-gmail-1' },
    ]);
    await Promise.all([Lead.createIndexes(), LeadInquiry.createIndexes()]);
  });

  afterAll(async () => {
    await LeadInquiry.deleteMany({ organizationId: { $in: [orgA, orgB] } });
    await Lead.deleteMany({ organizationId: { $in: [orgA, orgB] } });
  });

  it('builds every new index on existing-style data without touching existing records', async () => {
    const leadIndexes = await Lead.collection.indexes();
    const sourceIndex = leadIndexes.find((index) => index.name === 'lead_org_source_inquiry_unique');
    expect(sourceIndex).toMatchObject({ unique: true, partialFilterExpression: { sourceInquiryId: { $type: 'objectId' } } });
    const slotIndex = leadIndexes.find((index) => index.name === 'lead_org_intake_slot_unique');
    expect(slotIndex).toMatchObject({ unique: true, partialFilterExpression: { intakeSlots: { $type: 'string' } } });
    const inquiryIndexNames = (await LeadInquiry.collection.indexes()).map((index) => index.name);
    expect(inquiryIndexNames).toEqual(
      expect.arrayContaining([
        'lead_inquiry_org_gmail_message_unique',
        'lead_inquiry_org_provider_inquiry_unique',
        'lead_inquiry_org_sms_message_unique',
        'lead_inquiry_org_call_control_unique',
        'lead_inquiry_org_webchat_session_unique',
        'lead_inquiry_org_fingerprint_unique',
        'lead_inquiry_org_content_recent',
      ]),
    );
    const legacy: any = await Lead.findOne({ organizationId: orgA, firstName: 'Legacy' }).lean();
    expect(legacy.sourceInquiryId).toBeUndefined();
    expect(legacy.inquiryCount).toBeUndefined();
    expect(legacy.lastInquiryAt).toBeUndefined();
  });

  it('allows many records without optional source ids', async () => {
    const results = await Promise.all([1, 2, 3].map(() => recordInquiryEvent(inquiry(orgA))));
    expect(results.every((result) => result.created)).toBe(true);
    expect(new Set(results.map((result) => String(result.event._id))).size).toBe(3);
  });

  it('treats a repeated Gmail message id as the same inquiry, only inside one organization', async () => {
    const first = await recordInquiryEvent(inquiry(orgA, { gmailMessageId: 'gm-100' }));
    const repeat = await recordInquiryEvent(inquiry(orgA, { gmailMessageId: 'gm-100' }));
    const otherOrg = await recordInquiryEvent(inquiry(orgB, { gmailMessageId: 'gm-100' }));
    expect(first.created).toBe(true);
    expect(repeat).toMatchObject({ created: false });
    expect(String(repeat.event._id)).toBe(String(first.event._id));
    expect(otherOrg.created).toBe(true);
  });

  it('scopes provider inquiry ids by provider and organization', async () => {
    const carfax = buildProviderInquiryKey('CarFax', 'ID-7');
    const autotrader = buildProviderInquiryKey('AutoTrader', 'ID-7');
    const first = await recordInquiryEvent(inquiry(orgA, { providerInquiryKey: carfax }));
    const repeat = await recordInquiryEvent(inquiry(orgA, { providerInquiryKey: carfax }));
    const otherProvider = await recordInquiryEvent(inquiry(orgA, { providerInquiryKey: autotrader }));
    const otherOrg = await recordInquiryEvent(inquiry(orgB, { providerInquiryKey: carfax }));
    expect([first.created, repeat.created, otherProvider.created, otherOrg.created]).toEqual([true, false, true, true]);
  });

  it('blocks a repeated strong fingerprint and a repeated text message id', async () => {
    const a = await recordInquiryEvent(inquiry(orgA, {}, { fingerprint: 'inquiry:abc' }));
    const b = await recordInquiryEvent(inquiry(orgA, {}, { fingerprint: 'inquiry:abc' }));
    const sms1 = await recordInquiryEvent(inquiry(orgA, { smsProviderMessageId: 'tx-1' }, { kind: 'sms' }));
    const sms2 = await recordInquiryEvent(inquiry(orgA, { smsProviderMessageId: 'tx-1' }, { kind: 'sms' }));
    expect([a.created, b.created, sms1.created, sms2.created]).toEqual([true, false, true, false]);
  });

  it('creates exactly one record when the same inquiry arrives several times at once', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => recordInquiryEvent(inquiry(orgA, { gmailMessageId: 'gm-concurrent' }))),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => String(result.event._id))).size).toBe(1);
    expect(await LeadInquiry.countDocuments({ organizationId: orgA, 'sourceIds.gmailMessageId': 'gm-concurrent' })).toBe(1);
  });

  it('keeps several genuine inquiries from one customer as separate records', async () => {
    const first = await recordInquiryEvent(inquiry(orgA, { gmailMessageId: 'gm-toyota' }, { vehicle: { make: 'Toyota' } }));
    const second = await recordInquiryEvent(inquiry(orgA, { gmailMessageId: 'gm-honda' }, { vehicle: { make: 'Honda' } }));
    expect(first.created && second.created).toBe(true);
    expect(String(first.event._id)).not.toBe(String(second.event._id));
  });

  it('finds duplicates of older leads that have no inquiry records', async () => {
    expect(await findLegacyLeadSourceDuplicate(String(orgA), { gmailMessageId: 'legacy-gmail-1' })).toBeTruthy();
    expect(await findLegacyLeadSourceDuplicate(String(orgA), { ingestionFingerprint: 'adf:legacy-fingerprint' })).toBeTruthy();
    expect(await findLegacyLeadSourceDuplicate(String(orgA), { gmailMessageId: 'never-seen' })).toBeNull();
    const orgBMatch: any = await findLegacyLeadSourceDuplicate(String(orgB), { gmailMessageId: 'legacy-gmail-1' });
    const orgBLead: any = await Lead.findOne({ organizationId: orgB }).lean();
    expect(String(orgBMatch._id)).toBe(String(orgBLead._id));
  });

  it('finds identical content only inside the short duplicate window', async () => {
    const contentKey = buildInquiryContentKey({ provider: 'CarFax', email: 'window@example.com', vehicle: { make: 'Honda' }, comments: 'Hi' });
    const first = await recordInquiryEvent(inquiry(orgA, {}, { contentKey }));
    const second = await recordInquiryEvent(inquiry(orgA, {}, { contentKey }));
    expect(String((await findRecentContentDuplicate(String(orgA), contentKey, { excludeId: second.event._id }))?._id)).toBe(
      String(first.event._id),
    );
    await LeadInquiry.collection.updateMany(
      { _id: { $in: [first.event._id, second.event._id] } },
      { $set: { createdAt: new Date(Date.now() - 16 * 60 * 1000) } },
    );
    expect(await findRecentContentDuplicate(String(orgA), contentKey)).toBeNull();
  });

  it('lets only one worker claim an inquiry and only the lease owner commit it', async () => {
    const { event } = await recordInquiryEvent(inquiry(orgA, { gmailMessageId: 'gm-claim' }));
    const claims = await Promise.all(['w1', 'w2', 'w3'].map((owner) => claimInquiryProcessing(event._id, owner)));
    const winners = claims.filter(Boolean);
    expect(winners).toHaveLength(1);
    const winner = winners[0]!.processing.leaseOwner as string;
    const loser = ['w1', 'w2', 'w3'].find((owner) => owner !== winner)!;
    expect(await completeInquiryAssociation(event._id, loser, { state: 'pending_review', reason: 'test' })).toBeNull();
    const done = await completeInquiryAssociation(event._id, winner, { state: 'pending_review', reason: 'multiple_active_leads' });
    expect(done?.association.state).toBe('pending_review');
    expect(done?.processing.state).toBe('completed');
    expect(await claimInquiryProcessing(event._id, 'w4')).toBeNull();
  });

  it('recovers an inquiry whose worker crashed after creating the lead, without a second lead', async () => {
    const { event } = await recordInquiryEvent(inquiry(orgA, { gmailMessageId: 'gm-crash' }));
    const claimed = await claimInquiryProcessing(event._id, 'crashing-worker', { leaseMs: 50 });
    expect(claimed).toBeTruthy();
    const created = await Lead.collection.insertOne({ organizationId: orgA, firstName: 'Pat', status: 'New', sourceInquiryId: event._id });
    await expect(
      Lead.collection.insertOne({ organizationId: orgA, firstName: 'Pat again', status: 'New', sourceInquiryId: event._id }),
    ).rejects.toMatchObject({ code: 11000 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await completeInquiryAssociation(event._id, 'crashing-worker', { state: 'pending_review', reason: 'late' })).toBeNull();
    const recovery = await claimInquiryProcessing(event._id, 'recovery-worker');
    expect(recovery?.processing.attempts).toBe(2);
    const existing: any = await findLeadCreatedForInquiry(String(orgA), event._id);
    expect(String(existing._id)).toBe(String(created.insertedId));
    const done = await completeInquiryAssociation(event._id, 'recovery-worker', {
      state: 'associated',
      leadId: existing._id,
      outcome: 'created_lead',
      reason: 'recovered_existing_lead',
    });
    expect(done?.association).toMatchObject({ state: 'associated', outcome: 'created_lead' });
    expect(await Lead.countDocuments({ organizationId: orgA, sourceInquiryId: event._id })).toBe(1);
    expect(await findLeadCreatedForInquiry(String(orgB), event._id)).toBeNull();
  });

  it('retries a failed inquiry only after its backoff and stops after the attempt limit', async () => {
    const { event } = await recordInquiryEvent(inquiry(orgA, { gmailMessageId: 'gm-retry' }));
    await claimInquiryProcessing(event._id, 'w1');
    const failed = await failInquiryProcessing(event._id, 'w1', new Error('database hiccup'), { retryBaseMs: 60_000 });
    expect(failed?.processing).toMatchObject({ state: 'failed', lastError: 'database hiccup' });
    expect(await claimInquiryProcessing(event._id, 'w2')).toBeNull();
    const later = new Date(Date.now() + 2 * 60_000);
    expect(await claimInquiryProcessing(event._id, 'w2', { now: later, maxAttempts: 2 })).toBeTruthy();
    await failInquiryProcessing(event._id, 'w2', 'again', { now: later });
    expect(await claimInquiryProcessing(event._id, 'w3', { now: new Date(Date.now() + 10 * 60_000), maxAttempts: 2 })).toBeNull();
  });

  it('claims side effects once and never re-sends an external one whose result is unknown', async () => {
    const { event } = await recordInquiryEvent(inquiry(orgA, { gmailMessageId: 'gm-effects' }));
    await claimInquiryProcessing(event._id, 'w1');
    const lead = await Lead.collection.insertOne({ organizationId: orgA, firstName: 'Effects', status: 'New' });
    await completeInquiryAssociation(event._id, 'w1', { state: 'associated', leadId: lead.insertedId, outcome: 'created_lead', reason: 'test' });

    const claims = await Promise.all(['a', 'b'].map((owner) => claimInquirySideEffect(event._id, 'notification', owner)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const owner = claims.find(Boolean)!.sideEffects.notification.claimOwner as string;
    expect(await finishInquirySideEffect(event._id, 'notification', 'intruder', { state: 'done' })).toBeNull();
    const notified = await finishInquirySideEffect(event._id, 'notification', owner, { state: 'done', externalRef: 'notif-1' });
    expect(notified?.sideEffects.notification).toMatchObject({ state: 'done', externalRef: 'notif-1' });
    expect(await claimInquirySideEffect(event._id, 'notification', 'c')).toBeNull();

    await claimInquirySideEffect(event._id, 'alexReply', 'sender', { leaseMs: 30 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await claimInquirySideEffect(event._id, 'alexReply', 'second-sender')).toBeNull();
    const unknown = await markExpiredExternalSideEffectsUnknown(event._id, 'alexReply');
    expect(unknown?.sideEffects.alexReply.state).toBe('unknown');
    expect(await claimInquirySideEffect(event._id, 'alexReply', 'third-sender')).toBeNull();

    await claimInquirySideEffect(event._id, 'conversationRecord', 'writer', { leaseMs: 30 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await markExpiredExternalSideEffectsUnknown(event._id, 'conversationRecord')).toBeNull();
    expect(await claimInquirySideEffect(event._id, 'conversationRecord', 'recovery-writer')).toBeTruthy();
  });

  it('does not run side effects before the inquiry has a lead', async () => {
    const { event } = await recordInquiryEvent(inquiry(orgA, { gmailMessageId: 'gm-unassociated' }));
    expect(await claimInquirySideEffect(event._id, 'notification', 'early')).toBeNull();
  });

  it('applies the 15-minute window only to inquiries without reliable event identity', async () => {
    const contentKey = buildInquiryContentKey({ provider: 'CarFax', email: 'policy@example.com', vehicle: { make: 'Honda' }, comments: 'Same text' });
    const first = await recordInquiryEvent(inquiry(orgA, { gmailMessageId: 'gm-policy-1' }, { contentKey }));
    const emailCopy = await recordInquiryEvent(inquiry(orgA, { gmailMessageId: 'gm-policy-2' }, { contentKey }));
    const withProviderId = await recordInquiryEvent(inquiry(orgA, { providerInquiryKey: 'carfax:policy-3' }, { contentKey }));
    const text = await recordInquiryEvent(inquiry(orgA, { smsProviderMessageId: 'tx-policy-4' }, { contentKey, kind: 'sms' }));

    const copyCheck = await detectInquiryDuplicate({
      organizationId: String(orgA),
      eventId: emailCopy.event._id,
      sourceIds: { gmailMessageId: 'gm-policy-2' },
      contentKey,
    });
    expect(copyCheck).toMatchObject({ duplicate: true, kind: 'content_window', identity: 'transport', inquiryId: String(first.event._id) });
    expect(
      await detectInquiryDuplicate({
        organizationId: String(orgA),
        eventId: withProviderId.event._id,
        sourceIds: { providerInquiryKey: 'carfax:policy-3' },
        contentKey,
      }),
    ).toEqual({ duplicate: false, identity: 'event' });
    expect(
      await detectInquiryDuplicate({ organizationId: String(orgA), eventId: text.event._id, sourceIds: { smsProviderMessageId: 'tx-policy-4' }, contentKey }),
    ).toEqual({ duplicate: false, identity: 'event' });

    await claimInquiryProcessing(emailCopy.event._id, 'dedupe-worker');
    const dismissed = await completeInquiryAssociation(emailCopy.event._id, 'dedupe-worker', {
      state: 'resolved',
      outcome: 'dismissed',
      reason: 'duplicate_content_window',
      duplicateOf: first.event._id,
    });
    expect(dismissed?.association).toMatchObject({ state: 'resolved', outcome: 'dismissed', leadId: null });
    expect(String(dismissed?.association.duplicateOf)).toBe(String(first.event._id));

    await LeadInquiry.collection.updateMany(
      { _id: { $in: [first.event._id, emailCopy.event._id, withProviderId.event._id, text.event._id] } },
      { $set: { createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) } },
    );
    const daysLater = await recordInquiryEvent(inquiry(orgA, { gmailMessageId: 'gm-policy-5' }, { contentKey }));
    expect(daysLater.created).toBe(true);
    expect(
      await detectInquiryDuplicate({ organizationId: String(orgA), eventId: daysLater.event._id, sourceIds: { gmailMessageId: 'gm-policy-5' }, contentKey }),
    ).toEqual({ duplicate: false, identity: 'transport' });
  });

  it('reports a repeated source event and an older lead with the same source as duplicates', async () => {
    const { event } = await recordInquiryEvent(inquiry(orgA, { gmailMessageId: 'gm-policy-6' }));
    expect(
      await detectInquiryDuplicate({ organizationId: String(orgA), sourceIds: { gmailMessageId: 'gm-policy-6' } }),
    ).toMatchObject({ duplicate: true, kind: 'source_event', inquiryId: String(event._id) });
    expect(
      await detectInquiryDuplicate({ organizationId: String(orgA), sourceIds: { gmailMessageId: 'legacy-gmail-1' } }),
    ).toMatchObject({ duplicate: true, kind: 'legacy_lead' });
    expect(
      await detectInquiryDuplicate({ organizationId: String(orgA), legacyIngestionFingerprint: 'adf:legacy-fingerprint' }),
    ).toMatchObject({ duplicate: true, kind: 'legacy_lead' });
  });

  it('accepts identical content weeks apart when the request date has no time of day', async () => {
    const shared = { provider: 'CarFax', email: 'dateonly@example.com', vehicle: { make: 'Honda' }, comments: 'Hi' };
    const fingerprint = buildInquiryFingerprint({ ...shared, requestDate: '2026-10-22' });
    expect(fingerprint).toBeNull();
    const first = await recordInquiryEvent(inquiry(orgA, {}, { fingerprint, contentKey: buildInquiryContentKey(shared) }));
    const second = await recordInquiryEvent(inquiry(orgA, {}, { fingerprint, contentKey: buildInquiryContentKey(shared) }));
    expect(first.created && second.created).toBe(true);
  });

  it('lets the sender record an uncertain external result, which is then never re-sent', async () => {
    const { event } = await recordInquiryEvent(inquiry(orgA, { gmailMessageId: 'gm-unknown' }));
    await claimInquiryProcessing(event._id, 'w1');
    const lead = await Lead.collection.insertOne({ organizationId: orgA, firstName: 'Unknown', status: 'New' });
    await completeInquiryAssociation(event._id, 'w1', { state: 'associated', leadId: lead.insertedId, outcome: 'created_lead', reason: 'test' });
    await claimInquirySideEffect(event._id, 'alexReply', 'sender');
    const unknown = await finishInquirySideEffect(event._id, 'alexReply', 'sender', {
      state: 'unknown',
      externalRef: 'comm-message-1',
      error: 'provider timed out after accepting',
    });
    expect(unknown?.sideEffects.alexReply).toMatchObject({ state: 'unknown', externalRef: 'comm-message-1', doneAt: null });
    expect(await claimInquirySideEffect(event._id, 'alexReply', 'retry')).toBeNull();
    await claimInquirySideEffect(event._id, 'notification', 'notifier');
    await expect(finishInquirySideEffect(event._id, 'notification', 'notifier', { state: 'unknown' })).rejects.toThrow();
  });
});
