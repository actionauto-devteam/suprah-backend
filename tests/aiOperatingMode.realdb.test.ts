import mongoose from 'mongoose';
import Organization from '../src/models/Organization.model';
import Lead from '../src/models/lead.model';
import WebChatSession from '../src/models/WebChatSession.model';
import WebChatMessage from '../src/models/WebChatMessage.model';
import AiModeChangeLog from '../src/models/AiModeChangeLog.model';
import AiUsageCounter from '../src/models/AiUsageCounter.model';
import VehicleReengagementLog from '../src/models/VehicleReengagementLog.model';
import {
  resolveAiChannelModes,
  decideAiDelivery,
  recordAiUsage,
  getAiUsageToday,
} from '../src/services/aiOperatingMode.service';
import { updateAiModes, LIVE_CONFIRMATION_PHRASE } from '../src/controllers/aiOperatingMode.controller';
import { sendWebchatUnavailableAck } from '../src/controllers/webchat.controller';
import { WEBCHAT_ACK_ACTOR_ID } from '../src/utils/webchatAck';

async function callUpdate(orgId: string, body: any) {
  const json = jest.fn();
  const next = jest.fn();
  updateAiModes(
    { orgId, crmUser: { _id: new mongoose.Types.ObjectId(), role: 'admin', fullName: 'Real DB Admin' }, body } as any,
    { json, status: jest.fn(() => ({ json })) } as any,
    next,
  );
  for (let i = 0; i < 40 && !json.mock.calls.length && !next.mock.calls.length; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { json, next };
}

describe('Real-DB proof: AI operating modes (local dev MongoDB only)', () => {
  const env = { ...process.env };
  let org: any;
  const createdBy = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    process.env.AI_AGENT_ENABLED = 'true';
    process.env.DEMO_LAB_ENABLED = 'true';
    org = await Organization.create({
      name: 'Phase 1 AI Mode Real-DB Org',
      slug: 'phase1-ai-mode-realdb-' + Date.now(),
      status: 'active',
      metadata: { aiAgentEnabled: true, aiAgentName: 'Alex' },
    });
    await VehicleReengagementLog.init();
    await AiUsageCounter.init();
  });

  afterAll(async () => {
    process.env = env;
    if (org) {
      const orgId = String(org._id);
      await Lead.deleteMany({ organizationId: org._id });
      await WebChatMessage.deleteMany({ organizationId: orgId });
      await WebChatSession.deleteMany({ organizationId: orgId });
      await AiModeChangeLog.deleteMany({ organizationId: orgId });
      await AiUsageCounter.deleteMany({ organizationId: orgId });
      await VehicleReengagementLog.deleteMany({ organizationId: orgId });
      await Organization.deleteOne({ _id: org._id });
    }
  });

  it('a legacy org with AI on resolves to Live on every channel until it is explicitly configured', async () => {
    await expect(resolveAiChannelModes(org._id)).resolves.toEqual({ sms: 'live', email: 'live', webchat: 'live', source: 'legacy' });
  });

  it('configuring Training persists per-channel modes in the Mixed metadata, turns the rollback mirror off, and audits each channel', async () => {
    const { next } = await callUpdate(String(org._id), { modes: { sms: 'training', email: 'training', webchat: 'training' } });
    expect(next).not.toHaveBeenCalled();
    const saved: any = await Organization.findById(org._id).select('metadata').lean();
    expect(saved.metadata.aiAgentModes).toEqual({ sms: 'training', email: 'training', webchat: 'training' });
    expect(saved.metadata.aiAgentEnabled).toBe(false);
    expect(saved.metadata.aiAgentName).toBe('Alex');
    await expect(resolveAiChannelModes(org._id)).resolves.toEqual({ sms: 'training', email: 'training', webchat: 'training', source: 'configured' });
    const rows = await AiModeChangeLog.find({ organizationId: String(org._id) }).lean();
    expect(rows.map((row) => row.channel).sort()).toEqual(['email', 'sms', 'webchat']);
    expect(rows.every((row) => row.fromMode === 'live' && row.toMode === 'training' && row.fromSource === 'legacy')).toBe(true);
  });

  it('turning one channel Live requires confirmation, then flips only that channel and the mirror', async () => {
    const refused = await callUpdate(String(org._id), { modes: { webchat: 'live' }, reason: 'Testing confirm gate' });
    expect(refused.next.mock.calls[0][0].statusCode).toBe(400);
    const stillTraining: any = await Organization.findById(org._id).select('metadata').lean();
    expect(stillTraining.metadata.aiAgentModes.webchat).toBe('training');

    const { next } = await callUpdate(String(org._id), {
      modes: { webchat: 'live' }, confirmLive: LIVE_CONFIRMATION_PHRASE, reason: 'Real-DB check of the live gate',
    });
    expect(next).not.toHaveBeenCalled();
    const saved: any = await Organization.findById(org._id).select('metadata').lean();
    expect(saved.metadata.aiAgentModes).toEqual({ sms: 'training', email: 'training', webchat: 'live' });
    expect(saved.metadata.aiAgentEnabled).toBe(true);

    await callUpdate(String(org._id), { modes: { webchat: 'training' } });
    const back: any = await Organization.findById(org._id).select('metadata').lean();
    expect(back.metadata.aiAgentModes.webchat).toBe('training');
    expect(back.metadata.aiAgentEnabled).toBe(false);
  });

  it('only a genuine Demo Lab lead is simulated in Training; a real lead with the same-looking number is not', async () => {
    const demoLead = await Lead.create({ organizationId: org._id, createdBy, firstName: 'Demo', source: 'Demo', phone: '+18015550133' });
    const realLead = await Lead.create({ organizationId: org._id, createdBy, firstName: 'Real', source: 'Website Inquiry', phone: '+18015550134' });
    await expect(decideAiDelivery({ organizationId: org._id, channel: 'sms', workflow: 'sms_reply', toPhone: '+18015550133', leadId: demoLead._id }))
      .resolves.toMatchObject({ action: 'send', simulated: true });
    await expect(decideAiDelivery({ organizationId: org._id, channel: 'sms', workflow: 'sms_reply', toPhone: '+18015550134', leadId: realLead._id }))
      .resolves.toMatchObject({ action: 'skip' });
    await expect(decideAiDelivery({ organizationId: org._id, channel: 'email', workflow: 'email_reply', leadId: demoLead._id }))
      .resolves.toMatchObject({ action: 'skip' });
  });

  it('usage tracking counts concurrent attention checks exactly, in one daily row', async () => {
    await Promise.all(Array.from({ length: 10 }, () => recordAiUsage(org._id, 'attention_screen')));
    await expect(getAiUsageToday(org._id)).resolves.toEqual({ attention_screen: 10 });
    expect(await AiUsageCounter.countDocuments({ organizationId: String(org._id) })).toBe(1);
  });

  it('five simultaneous visitor messages produce exactly one webchat acknowledgement', async () => {
    const lead = await Lead.create({ organizationId: org._id, createdBy, firstName: 'Visitor', source: 'Website Chat' });
    const session = await WebChatSession.create({
      organizationId: String(org._id), leadId: lead._id, tokenHash: 'hash-' + Date.now(), visitorName: 'Visitor',
    });
    const results = await Promise.all(Array.from({ length: 5 }, () => sendWebchatUnavailableAck(session)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const acks = await WebChatMessage.find({ sessionId: session._id }).lean();
    expect(acks).toHaveLength(1);
    expect(acks[0].sentBy?.userId).toBe(WEBCHAT_ACK_ACTOR_ID);
    expect(acks[0].body).toBe(
      "Thanks for reaching out to Phase 1 AI Mode Real-DB Org! We've received your message, and a member of our team will get back to you as soon as possible.",
    );
    await expect(sendWebchatUnavailableAck(session)).resolves.toBe(false);
  });

  it('a skipped_ai_not_live re-engagement row is stored and permanently blocks a later send for the same vehicle and lead', async () => {
    const base = {
      organizationId: String(org._id), vehicleId: new mongoose.Types.ObjectId(), leadId: new mongoose.Types.ObjectId(),
      vehicleLabel: '2022 Honda Civic', leadName: 'Test', leadPhone: '+13853365062',
    };
    await VehicleReengagementLog.create({ ...base, status: 'skipped_ai_not_live', failureReason: 'Suprah AI is not live' });
    await expect(VehicleReengagementLog.create({ ...base, status: 'sent' })).rejects.toMatchObject({ code: 11000 });
  });
});
