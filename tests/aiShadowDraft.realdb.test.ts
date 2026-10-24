import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import AiAgentDraft from '../src/models/AiAgentDraft.model';
import AiUsageCounter from '../src/models/AiUsageCounter.model';
import {
  claimShadowDraft,
  recordShadowAttentionSkip,
  reserveShadowGenerationSlot,
  beginShadowGeneration,
  completeShadowDraft,
  failShadowDraft,
  recoverStaleShadowDrafts,
  getShadowDraftUsageToday,
  shadowDraftUsageDay,
} from '../src/services/aiShadowDraft.service';

const TRAINING = { aiAgentName: 'Anna', aiShadowDraftsEnabled: true, aiAgentModes: { sms: 'training', email: 'training', webchat: 'training' } };

describe('Real-DB proof: shadow draft foundation (local dev MongoDB only)', () => {
  const env = { ...process.env };
  let orgA: any;
  let orgB: any;

  const source = (org: any, sourceMessageId: string, channel: 'sms' | 'email' | 'webchat' = 'sms') => ({
    organizationId: org._id,
    channel,
    sourceMessageId,
    sourceMessageModel: (channel === 'webchat' ? 'WebChatMessage' : channel === 'email' ? 'Lead' : 'CommunicationMessage') as any,
    leadId: new mongoose.Types.ObjectId(),
    inquiryReceivedAt: new Date(),
  });

  beforeAll(async () => {
    process.env.AI_AGENT_ENABLED = 'true';
    process.env.AI_SHADOW_DRAFTS_ENABLED = 'true';
    await AiAgentDraft.init();
    await AiUsageCounter.init();
    orgA = await Organization.create({ name: 'Shadow Org A', slug: 'shadow-a-' + Date.now(), status: 'active', metadata: { ...TRAINING } });
    orgB = await Organization.create({ name: 'Shadow Org B', slug: 'shadow-b-' + Date.now(), status: 'active', metadata: { ...TRAINING, timezone: 'Asia/Manila' } });
  });

  afterAll(async () => {
    process.env = env;
    for (const org of [orgA, orgB]) {
      if (!org) continue;
      await AiAgentDraft.deleteMany({ organizationId: String(org._id) });
      await AiUsageCounter.deleteMany({ organizationId: String(org._id) });
      await Organization.deleteOne({ _id: org._id });
    }
  });

  beforeEach(async () => {
    await AiAgentDraft.deleteMany({ organizationId: { $in: [String(orgA._id), String(orgB._id)] } });
    await AiUsageCounter.deleteMany({ organizationId: { $in: [String(orgA._id), String(orgB._id)] } });
    await Organization.updateOne({ _id: orgA._id }, { $set: { metadata: { ...TRAINING } } });
  });

  it('has the unique source index and a 90-day TTL index', async () => {
    const indexes = await AiAgentDraft.collection.indexes();
    const unique = indexes.find((i: any) => i.name === 'ai_draft_source_unique');
    const ttl = indexes.find((i: any) => i.name === 'ai_draft_retention_ttl');
    expect(unique).toMatchObject({ unique: true, key: { organizationId: 1, channel: 1, sourceMessageId: 1 } });
    expect(ttl).toMatchObject({ expireAfterSeconds: 0, key: { expiresAt: 1 } });
    const claim = await claimShadowDraft(source(orgA, 'ttl-check'));
    const draft: any = await AiAgentDraft.findById((claim as any).draftId).lean();
    const days = (new Date(draft.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);
  });

  it('20 concurrent claims of the same inbound message produce exactly one draft', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => claimShadowDraft(source(orgA, 'same-message'))));
    expect(results.filter((r) => r.outcome === 'claimed')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'duplicate')).toHaveLength(19);
    expect(await AiAgentDraft.countDocuments({ organizationId: String(orgA._id), sourceMessageId: 'same-message' })).toBe(1);
  });

  it('150 simultaneous cap reservations give no more than 100, from a counter that did not exist yet', async () => {
    expect(await AiUsageCounter.countDocuments({ organizationId: String(orgA._id), kind: 'shadow_draft' })).toBe(0);
    const results = await Promise.all(Array.from({ length: 150 }, () => reserveShadowGenerationSlot(orgA._id)));
    expect(results.filter((r) => r.reserved)).toHaveLength(100);
    expect(results.filter((r) => !r.reserved)).toHaveLength(50);
    const rows = await AiUsageCounter.find({ organizationId: String(orgA._id), kind: 'shadow_draft' }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(100);
    expect(new Set(results.filter((r) => r.reserved).map((r) => r.count)).size).toBe(100);
  });

  it('keeps organizations isolated: same message id, separate caps, separate days, separate recovery', async () => {
    const a = await claimShadowDraft(source(orgA, 'shared-id'));
    const b = await claimShadowDraft(source(orgB, 'shared-id'));
    expect(a.outcome).toBe('claimed');
    expect(b.outcome).toBe('claimed');
    await Promise.all(Array.from({ length: 100 }, () => reserveShadowGenerationSlot(orgA._id)));
    expect((await reserveShadowGenerationSlot(orgA._id)).reserved).toBe(false);
    const bSlot = await reserveShadowGenerationSlot(orgB._id, 'Asia/Manila');
    expect(bSlot).toMatchObject({ reserved: true, count: 1, day: shadowDraftUsageDay('Asia/Manila') });
    await AiAgentDraft.updateMany({}, { $set: { leaseExpiresAt: new Date(Date.now() - 1000) } }, {}).where({ organizationId: { $in: [String(orgA._id), String(orgB._id)] } });
    const recovered = await recoverStaleShadowDrafts(orgA._id);
    expect(recovered.abandonedClaims).toBe(1);
    const bDraft: any = await AiAgentDraft.findById((b as any).draftId).lean();
    expect(bDraft.status).toBe('claimed');
  });

  it('full lifecycle: claim, reserve one slot, save the private result', async () => {
    const claim: any = await claimShadowDraft(source(orgA, 'life-1'));
    const start = await beginShadowGeneration({ organizationId: orgA._id, draftId: claim.draftId, leaseId: claim.leaseId, channel: 'sms' });
    expect(start).toMatchObject({ started: true, reservedCount: 1 });
    const done = await completeShadowDraft({
      organizationId: orgA._id, draftId: claim.draftId, leaseId: claim.leaseId, channel: 'sms',
      result: { status: 'ready', draftText: 'Hi! Yes, the Civic is here.', kind: 'reply', classifierVerdict: 'SAFE', deterministicOk: true, aiModel: 'gemini-flash-lite-latest', latencyMs: 812, totalTokens: 345, aiCallCount: 2 },
    });
    expect(done).toEqual({ saved: true, status: 'ready' });
    const draft: any = await AiAgentDraft.findById(claim.draftId).lean();
    expect(draft).toMatchObject({ status: 'ready', draftText: 'Hi! Yes, the Civic is here.', attemptCount: 1, totalTokens: 345 });
    expect(draft.leaseId).toBeUndefined();
    expect(await getShadowDraftUsageToday(orgA._id)).toBe(1);
  });

  it('duplicate claims and attention skips never consume the daily cap', async () => {
    await claimShadowDraft(source(orgA, 'dup-1'));
    await claimShadowDraft(source(orgA, 'dup-1'));
    const skip = await recordShadowAttentionSkip(source(orgA, 'attention-1'), 'Customer asked for a person');
    expect(skip.outcome).toBe('recorded');
    const again = await recordShadowAttentionSkip(source(orgA, 'attention-1'), 'Customer asked for a person');
    expect(again.outcome).toBe('duplicate');
    const skipped: any = await AiAgentDraft.findOne({ organizationId: String(orgA._id), sourceMessageId: 'attention-1' }).lean();
    expect(skipped).toMatchObject({ status: 'skipped_attention' });
    expect(skipped.draftText).toBeUndefined();
    expect(await getShadowDraftUsageToday(orgA._id)).toBe(0);
  });

  it('when the cap is reached, the inquiry is kept as skipped_cap and nothing is generated', async () => {
    await Promise.all(Array.from({ length: 100 }, () => reserveShadowGenerationSlot(orgA._id)));
    const claim: any = await claimShadowDraft(source(orgA, 'over-cap'));
    const start = await beginShadowGeneration({ organizationId: orgA._id, draftId: claim.draftId, leaseId: claim.leaseId, channel: 'sms' });
    expect(start).toMatchObject({ started: false, status: 'skipped_cap' });
    const draft: any = await AiAgentDraft.findById(claim.draftId).lean();
    expect(draft.status).toBe('skipped_cap');
    expect(await getShadowDraftUsageToday(orgA._id)).toBe(100);
  });

  it('an admin switching the channel out of Training before generation stops it without using the cap', async () => {
    const claim: any = await claimShadowDraft(source(orgA, 'mode-change-before'));
    await Organization.updateOne({ _id: orgA._id }, { $set: { 'metadata.aiAgentModes.sms': 'live' } });
    const start = await beginShadowGeneration({ organizationId: orgA._id, draftId: claim.draftId, leaseId: claim.leaseId, channel: 'sms' });
    expect(start).toMatchObject({ started: false, status: 'failed', reason: 'mode_not_training' });
    expect(await getShadowDraftUsageToday(orgA._id)).toBe(0);
  });

  it('an admin turning shadow drafts off during generation discards the result instead of saving it', async () => {
    const claim: any = await claimShadowDraft(source(orgA, 'flag-off-during'));
    await beginShadowGeneration({ organizationId: orgA._id, draftId: claim.draftId, leaseId: claim.leaseId, channel: 'sms' });
    await Organization.updateOne({ _id: orgA._id }, { $set: { 'metadata.aiShadowDraftsEnabled': false } });
    const done = await completeShadowDraft({ organizationId: orgA._id, draftId: claim.draftId, leaseId: claim.leaseId, channel: 'sms', result: { status: 'ready', draftText: 'Should not be kept' } });
    expect(done).toEqual({ saved: true, status: 'failed' });
    const draft: any = await AiAgentDraft.findById(claim.draftId).lean();
    expect(draft.status).toBe('failed');
    expect(draft.draftText).toBeUndefined();
  });

  it('a worker that lost its lease cannot overwrite the draft, and failures are recorded', async () => {
    const claim: any = await claimShadowDraft(source(orgA, 'lease-1'));
    await beginShadowGeneration({ organizationId: orgA._id, draftId: claim.draftId, leaseId: claim.leaseId, channel: 'sms' });
    const wrong = await completeShadowDraft({ organizationId: orgA._id, draftId: claim.draftId, leaseId: 'someone-else', channel: 'sms', result: { status: 'ready', draftText: 'x' } });
    expect(wrong).toEqual({ saved: false, status: 'lost_lease' });
    expect(await failShadowDraft({ organizationId: orgA._id, draftId: claim.draftId, leaseId: claim.leaseId, reason: 'Gemini timed out' })).toBe(true);
    const draft: any = await AiAgentDraft.findById(claim.draftId).lean();
    expect(draft).toMatchObject({ status: 'failed', failureReason: 'Gemini timed out' });
  });

  it('crashed work is recovered: expired claims and expired generations become failed, live ones are left alone', async () => {
    const stuckClaim: any = await claimShadowDraft(source(orgA, 'stuck-claim'));
    const stuckGen: any = await claimShadowDraft(source(orgA, 'stuck-gen'));
    await beginShadowGeneration({ organizationId: orgA._id, draftId: stuckGen.draftId, leaseId: stuckGen.leaseId, channel: 'sms' });
    const healthy: any = await claimShadowDraft(source(orgA, 'healthy'));
    await AiAgentDraft.updateMany({ _id: { $in: [stuckClaim.draftId, stuckGen.draftId] } }, { $set: { leaseExpiresAt: new Date(Date.now() - 60_000) } });
    const recovered = await recoverStaleShadowDrafts(orgA._id);
    expect(recovered).toEqual({ abandonedClaims: 1, abandonedGenerations: 1 });
    const rows: any[] = await AiAgentDraft.find({ _id: { $in: [stuckClaim.draftId, stuckGen.draftId, healthy.draftId] } }).lean();
    const byId = Object.fromEntries(rows.map((r) => [String(r._id), r]));
    expect(byId[stuckClaim.draftId].status).toBe('failed');
    expect(byId[stuckGen.draftId].status).toBe('failed');
    expect(byId[healthy.draftId].status).toBe('claimed');
    const late = await completeShadowDraft({ organizationId: orgA._id, draftId: stuckGen.draftId, leaseId: stuckGen.leaseId, channel: 'sms', result: { status: 'ready', draftText: 'late' } });
    expect(late.saved).toBe(false);
  });

  it('is disabled by default: without the global flag nothing is written', async () => {
    delete process.env.AI_SHADOW_DRAFTS_ENABLED;
    const result = await claimShadowDraft(source(orgA, 'default-off'));
    expect(result).toEqual({ outcome: 'ineligible', reason: 'global_flag_off' });
    expect(await AiAgentDraft.countDocuments({ organizationId: String(orgA._id) })).toBe(0);
    process.env.AI_SHADOW_DRAFTS_ENABLED = 'true';
  });

  it('never writes to real communication collections', async () => {
    const before = await Promise.all(['communicationmessages', 'webchatmessages', 'conversations'].map((name) => mongoose.connection.collection(name).countDocuments()));
    const claim: any = await claimShadowDraft(source(orgA, 'isolation-check'));
    await beginShadowGeneration({ organizationId: orgA._id, draftId: claim.draftId, leaseId: claim.leaseId, channel: 'sms' });
    await completeShadowDraft({ organizationId: orgA._id, draftId: claim.draftId, leaseId: claim.leaseId, channel: 'sms', result: { status: 'ready', draftText: 'private' } });
    const after = await Promise.all(['communicationmessages', 'webchatmessages', 'conversations'].map((name) => mongoose.connection.collection(name).countDocuments()));
    expect(after).toEqual(before);
  });
});
