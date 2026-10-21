import mongoose from 'mongoose';
import OrgLeadConfig from '../models/OrgLeadConfig.model';
import Organization from '../models/Organization.model';
import {
  resolveAiAgentSettings,
  generateAlexEmailReply,
  classifyAlexEmailReplySafety,
  AiAgentTranscriptEntry,
} from './aiAgent.service';
import { resolvePinnedVehicleContext, buildVehicleContextNote, formatVehicleLabel } from './vehicleInquiryContext.service';
import { buildContextualFallback } from '../utils/aiFallbackMessage';
import {
  beginAiAttentionCheck,
  finishAiAttentionCheck,
  screenAiHumanAttention,
  claimAiGeneration,
} from './aiHumanAttention.service';
import { createAiAgentTaskAndNotify } from '../utils/aiAgentTask';
import { addLeadNoteAndNotify, shouldSuppressHandoffNoteNotification } from '../utils/leadNote';
import { sendLeadReplyEmail, fetchGmailThreadMessages } from '../controllers/lead.controller';
import { resolveCurrentVehicleAndPrice } from './aiReplyContext.service';
import { queueShadowDraft, queueShadowAttentionSkip, ShadowDraftSource } from './aiShadowDraft.service';
import { resolveAiChannelMode, decideAiDelivery, assertAiDispatchAllowed, isAttentionScreeningMode } from './aiOperatingMode.service';
import { AiReplySuppressedError } from '../utils/aiReplySuppressed';
import { validateOutboundEmailMessage } from '../utils/aiOutboundSafety';
export { validateOutboundEmailMessage } from '../utils/aiOutboundSafety';
import logger from '../utils/logger';

const AI_AGENT_ACTOR_ID = 'ai-agent';


async function buildEmailTranscript(lead: any): Promise<AiAgentTranscriptEntry[]> {
  const messages = await fetchGmailThreadMessages(String(lead.organizationId), lead.threadId, lead.messageId);
  return messages.slice(-12).map((m: any) => ({
    from: m.direction === 'inbound' ? 'customer' : 'ai',
    body: m.body,
  })) as AiAgentTranscriptEntry[];
}

export async function triggerAiEmailReplyForNewInquiry(orgId: any, lead: any, inquiryText: string): Promise<void> {
  const text = String(inquiryText || '').trim();
  const hasUsablePhone = Boolean(String(lead?.phone || '').replace(/\D/g, '').length >= 7);
  if (!text || !lead?._id || !lead?.email || hasUsablePhone) return;

  let check: any = null;
  let claimedForGen: any = null;

  try {
    const LeadModel = mongoose.model('Lead');
    const claimed = await LeadModel.findOneAndUpdate(
      { _id: lead._id, organizationId: orgId, aiFirstReplyTriggeredAt: null },
      { $set: { aiFirstReplyTriggeredAt: new Date() } },
    );
    if (!claimed) return;

    const { agentName } = await resolveAiAgentSettings(String(orgId));
    const { mode: emailMode } = await resolveAiChannelMode(orgId, 'email');
    if (!isAttentionScreeningMode(emailMode)) return;

    const messageId = new mongoose.Types.ObjectId();
    check = await beginAiAttentionCheck({
      organizationId: String(orgId),
      channel: 'email',
      targetId: String(lead._id),
      messageId: String(messageId),
    });

    const shadowSource: ShadowDraftSource = {
      organizationId: orgId,
      channel: 'email',
      sourceMessageId: String(lead._id),
      sourceMessageModel: 'Lead',
      leadId: lead._id,
      inquiryReceivedAt: lead.createdAt ? new Date(lead.createdAt) : new Date(),
    };

    if (!(await screenAiHumanAttention({ ...check, leadId: String(lead._id), body: text, agentName }))) {
      if (emailMode === 'training') queueShadowAttentionSkip(shadowSource);
      return;
    }

    const delivery = await decideAiDelivery({ organizationId: orgId, channel: 'email', workflow: 'email_reply', leadId: lead._id });
    if (delivery.action !== 'send') {
      await finishAiAttentionCheck(check);
      if (delivery.mode === 'training') queueShadowDraft({ ...shadowSource, lead, inquiryText: text });
      return;
    }

    claimedForGen = await claimAiGeneration(check);
    if (!claimedForGen) return;

    try {
      const [org, priceContext, transcript, vehicleContext] = await Promise.all([
        Organization.findById(orgId).select('name').lean(),
        resolveCurrentVehicleAndPrice(lead),
        buildEmailTranscript(lead),
        resolvePinnedVehicleContext({ organizationId: orgId, lead, email: lead.email }),
      ]);
      const dealerName = (org as any)?.name || 'Your Dealership';
      const vehicleInterest = lead.vehicle
        ? [lead.vehicle.year, lead.vehicle.make, lead.vehicle.model].filter(Boolean).join(' ')
        : undefined;

      const generation = await generateAlexEmailReply({
        agentName,
        dealerName,
        customerFirstName: lead.firstName,
        leadVehicleInterest: vehicleInterest,
        transcript,
        isFirstReply: true,
        confirmedPrice: priceContext?.price,
        confirmedPreviousPrice: priceContext?.previousPrice,
        vehicleContextNote: buildVehicleContextNote(vehicleContext),
      });

      const customerName = [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() || 'A customer';

      const sendFallback = async (reason: string) => {
        const fallbackConfig = await OrgLeadConfig.findOne({ organizationId: orgId, isActive: true }).select('gmailAddress').lean();
        const fallback = buildContextualFallback({
          transcript: transcript.length ? transcript : [{ from: 'customer', body: text }],
          vehicleLabel: formatVehicleLabel(lead.vehicle) || undefined,
        });
        await sendLeadReplyEmail(lead, fallback.text, AI_AGENT_ACTOR_ID, String(orgId), [], (fallbackConfig as any)?.gmailAddress, {
          beforeDispatch: emailDispatchGuard(orgId, lead._id),
        });
        const taskResult = await createAiAgentTaskAndNotify({
          organizationId: String(orgId),
          leadId: String(lead._id),
          channel: 'email',
          question: reason,
          agentName,
          customerName,
          assignedTo: lead.assignedTo ? String(lead.assignedTo) : null,
        }).catch(() => null);
        try {
          const mentionedUserIds = lead.assignedTo ? [String(lead.assignedTo)] : [];
          let mentionedGroupIds: string[] = [];
          if (!lead.assignedTo) {
            const orgMeta = await Organization.findById(orgId).select('metadata').lean();
            const fallbackGroupId = (orgMeta?.metadata as any)?.aiHandoffFallbackGroupId;
            if (fallbackGroupId) mentionedGroupIds = [String(fallbackGroupId)];
          }
          await addLeadNoteAndNotify({
            organizationId: String(orgId),
            leadId: String(lead._id),
            text: reason,
            authorType: 'ai',
            authorName: agentName,
            mentionedUserIds,
            mentionedGroupIds,
            suppressNotification: shouldSuppressHandoffNoteNotification(lead.assignedTo, Boolean((taskResult as any)?.notified)),
          });
        } catch (err) {
          logger.error({ err, leadId: lead._id }, '[AiEmailReply] fallback handoff note failed');
        }
      };

      if (!generation.text) {
        logger.warn({ leadId: lead._id, error: generation.error }, '[AiEmailReply] Generation returned no usable text, sending fallback');
        await sendFallback(generation.error || `${agentName} could not generate a reply`);
        await finishAiAttentionCheck(check);
        return;
      }

      const allowedPrices = [priceContext?.price, priceContext?.previousPrice].filter((v): v is number => typeof v === 'number');
      const deterministic = validateOutboundEmailMessage(generation.text, allowedPrices);
      const classifierVerdict = deterministic.ok ? await classifyAlexEmailReplySafety(generation.text) : 'UNSAFE';

      if (!deterministic.ok || classifierVerdict !== 'SAFE') {
        logger.warn({ leadId: lead._id, reasons: deterministic.reasons, classifierVerdict }, '[AiEmailReply] Generated reply blocked by safety checks, sending fallback');
        await sendFallback(deterministic.reasons.join(', ') || 'reply failed a safety check');
        await finishAiAttentionCheck(check);
        return;
      }

      const config = await OrgLeadConfig.findOne({ organizationId: orgId, isActive: true }).select('gmailAddress').lean();
      await sendLeadReplyEmail(lead, generation.text, AI_AGENT_ACTOR_ID, String(orgId), [], (config as any)?.gmailAddress, {
        beforeDispatch: emailDispatchGuard(orgId, lead._id),
      });

      if (generation.handoffReason) {
        const taskResult = await createAiAgentTaskAndNotify({
          organizationId: String(orgId),
          leadId: String(lead._id),
          channel: 'email',
          question: generation.handoffReason,
          agentName,
          customerName,
          assignedTo: lead.assignedTo ? String(lead.assignedTo) : null,
        }).catch(() => null);

        try {
          const mentionedUserIds = lead.assignedTo ? [String(lead.assignedTo)] : [];
          let mentionedGroupIds: string[] = [];
          if (!lead.assignedTo) {
            const orgMeta = await Organization.findById(orgId).select('metadata').lean();
            const fallbackGroupId = (orgMeta?.metadata as any)?.aiHandoffFallbackGroupId;
            if (fallbackGroupId) mentionedGroupIds = [String(fallbackGroupId)];
          }
          await addLeadNoteAndNotify({
            organizationId: String(orgId),
            leadId: String(lead._id),
            text: generation.handoffReason || 'Needs human follow-up',
            authorType: 'ai',
            authorName: agentName,
            mentionedUserIds,
            mentionedGroupIds,
            suppressNotification: shouldSuppressHandoffNoteNotification(lead.assignedTo, Boolean((taskResult as any)?.notified)),
          });
        } catch (err) {
          logger.error({ err, leadId: lead._id }, '[AiEmailReply] handoff note failed');
        }
      } else if (generation.milestoneNote) {
        await addLeadNoteAndNotify({
          organizationId: String(orgId),
          leadId: String(lead._id),
          text: generation.milestoneNote,
          authorType: 'ai',
          authorName: agentName,
          milestone: true,
        }).catch((err) => {
          logger.error({ err, leadId: lead._id }, '[AiEmailReply] milestone note failed');
        });
      }

      await finishAiAttentionCheck(check);
    } finally {
      await mongoose.model('Lead').updateOne(
        { _id: lead._id, organizationId: orgId, aiGeneratingAt: claimedForGen?.aiGeneratingAt },
        { $unset: { aiGeneratingAt: '' } },
      ).catch(() => undefined);
    }
  } catch (err) {
    if (err instanceof AiReplySuppressedError) {
      if (check) await finishAiAttentionCheck(check).catch(() => undefined);
      logger.info({ leadId: lead?._id }, '[AiEmailReply] AI email suppressed before dispatch');
      return;
    }
    logger.error({ err, leadId: lead?._id }, '[AiEmailReply] triggerAiEmailReplyForNewInquiry failed');
  }
}

function emailDispatchGuard(orgId: any, leadId: any) {
  return async () => {
    await assertAiDispatchAllowed({ organizationId: orgId, channel: 'email', workflow: 'email_reply', leadId });
  };
}
