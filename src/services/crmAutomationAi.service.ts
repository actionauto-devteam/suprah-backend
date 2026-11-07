import mongoose from 'mongoose';
import Lead from '../models/lead.model';
import { CommunicationMessage, Conversation } from '../models/communication.model';
import { CrmAutomationRunLog, ICrmAutomationRun } from '../models/CrmAutomationRun.model';
import {
  checkConversationPauseForLead,
  isSmsOptedOut,
  normalizePhone,
  resolveDealerName,
  sendStaffAttributedSms,
  shouldDeferAutomatedFollowUp,
} from './communication.service';
import { classifyAlexReplySafety, generateProactiveFollowUp, resolveAiAgentSettings } from './aiAgent.service';
import { decideAiDelivery } from './aiOperatingMode.service';
import { checkContactForSend, contactRestrictionMessage, isContactRestrictedError } from './contactRestriction.service';
import { describeVehicleInterest } from './vehicleInterest.service';
import { buildVehicleContextNote, resolvePinnedVehicleContext } from './vehicleInquiryContext.service';
import { validateOutboundMessage } from '../utils/aiOutboundSafety';
import { AiReplySuppressedError } from '../utils/aiReplySuppressed';
import { isSmsDestinationError, resolveSmsDestination } from '../utils/smsDestination';

type StepResult = { status: CrmAutomationRunLog['status']; detail: string };

async function smsTranscript(organizationId: any, phone: string) {
  const conversation: any = await Conversation.findOne({ orgId: organizationId, customerPhone: phone }).select('_id').lean();
  if (!conversation) return [];
  const messages = await CommunicationMessage.find({ conversationId: conversation._id }).sort({ createdAt: -1 }).limit(12).lean();
  return messages.reverse().map((message: any) => {
    if (message.direction === 'inbound') return { from: 'customer' as const, body: message.body };
    if (message.sentBy?.userId === 'ai-agent') return { from: 'ai' as const, body: message.body };
    return { from: 'staff' as const, staffName: message.sentBy?.name, body: message.body };
  });
}

export async function runAiFollowUpStep(run: ICrmAutomationRun, instructions: string): Promise<StepResult> {
  const leadId = run.contact.leadId;
  if (!leadId || !mongoose.isValidObjectId(leadId)) return { status: 'skipped', detail: 'No lead for the AI follow-up' };
  const lead: any = await Lead.findOne({ _id: leadId, organizationId: run.organizationId })
    .select('organizationId firstName lastName phone email vehicle customerId status')
    .lean();
  if (!lead) return { status: 'skipped', detail: 'The lead was not found' };
  const phone = String(lead.phone || run.contact.phone || '');
  if (!phone) return { status: 'skipped', detail: 'No phone number' };
  const destination = resolveSmsDestination(phone, 'automated');
  if (!destination.ok) return { status: 'skipped', detail: destination.message };
  const orgId = lead.organizationId;
  if (await isSmsOptedOut(orgId, phone)) return { status: 'skipped', detail: 'The customer replied STOP' };
  const settings = await resolveAiAgentSettings(String(orgId));
  const restriction = await checkContactForSend(
    { organizationId: orgId, phone, email: lead.email, leadId: lead._id, customerId: lead.customerId },
    { channel: 'sms', purpose: 'ai_follow_up', actor: { kind: 'ai', userId: 'ai-agent', name: settings.agentName } },
  );
  if (restriction.status !== 'allowed') return { status: 'skipped', detail: contactRestrictionMessage(restriction) || 'This contact cannot get texts right now' };
  const delivery = await decideAiDelivery({ organizationId: orgId, channel: 'sms', workflow: 'sms_followup', toPhone: phone, leadId: lead._id });
  if (delivery.action !== 'send') return { status: 'skipped', detail: 'The AI agent is not Live for texts, so it did not write a follow-up' };
  const pause = await checkConversationPauseForLead({ organizationId: orgId, phone: normalizePhone(phone), leadId: lead._id });
  if (shouldDeferAutomatedFollowUp(pause)) return { status: 'skipped', detail: pause.reason || 'The AI agent is paused on this conversation' };
  if (run.mode === 'test') return { status: 'test', detail: `Would have ${settings.agentName} write and text a follow-up to ${phone}` };

  try {
    const [dealerName, vehicleInterest, transcript, vehicleContext] = await Promise.all([
      resolveDealerName(orgId),
      describeVehicleInterest(lead, orgId),
      smsTranscript(orgId, normalizePhone(phone)),
      resolvePinnedVehicleContext({ organizationId: orgId, lead, phone }),
    ]);
    const generation = await generateProactiveFollowUp({
      agentName: settings.agentName,
      dealerName,
      customerFirstName: lead.firstName,
      leadVehicleInterest: vehicleInterest,
      transcript,
      channel: 'sms',
      followUpNumber: 1,
      vehicleContextNote: buildVehicleContextNote(vehicleContext),
      automated: true,
      staffInstructions: instructions,
    });
    if (!generation.text) return { status: 'failed', detail: generation.error || 'The AI agent could not write the follow-up' };
    const deterministic = validateOutboundMessage(generation.text);
    const verdict = deterministic.ok ? await classifyAlexReplySafety(generation.text) : 'UNSAFE';
    if (!deterministic.ok || verdict !== 'SAFE') {
      return { status: 'skipped', detail: `The safety check held the follow-up back: ${deterministic.reasons.join(', ') || verdict}` };
    }
    const sent = await sendStaffAttributedSms({
      orgId,
      toPhone: phone,
      body: generation.text,
      leadId: lead._id,
      actor: { userId: 'ai-agent', name: settings.agentName },
      aiWorkflow: 'sms_followup',
    });
    if (!sent) return { status: 'skipped', detail: 'The customer replied STOP' };
    await Lead.updateOne({ _id: lead._id }, { $set: { 'followUp.lastAutomatedOutreachAt': new Date() } }, { timestamps: false });
    return { status: 'sent', detail: generation.text };
  } catch (err: any) {
    if (err instanceof AiReplySuppressedError) return { status: 'skipped', detail: String(err.message || 'The AI agent is not allowed to text right now') };
    if (isContactRestrictedError(err) || isSmsDestinationError(err)) return { status: 'skipped', detail: String(err.message || 'This contact cannot get texts') };
    return { status: 'failed', detail: String(err?.message || err).slice(0, 300) };
  }
}
