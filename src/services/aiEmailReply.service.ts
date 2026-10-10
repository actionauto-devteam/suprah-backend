import mongoose from 'mongoose';
import Vehicle from '../models/Vehicle.model';
import OrgLeadConfig from '../models/OrgLeadConfig.model';
import Organization from '../models/Organization.model';
import { matchesVehicle } from './vehicleReengagement.service';
import {
  resolveAiAgentSettings,
  generateAlexEmailReply,
  classifyAlexEmailReplySafety,
  AiAgentTranscriptEntry,
  ALEX_FALLBACK_MESSAGE,
} from './aiAgent.service';
import {
  beginAiAttentionCheck,
  finishAiAttentionCheck,
  screenAiHumanAttention,
  claimAiGeneration,
} from './aiHumanAttention.service';
import { createAiAgentTaskAndNotify } from '../utils/aiAgentTask';
import { addLeadNoteAndNotify, shouldSuppressHandoffNoteNotification } from '../utils/leadNote';
import { sendLeadReplyEmail, fetchGmailThreadMessages } from '../controllers/lead.controller';
import { hasGuaranteedAvailabilityLanguage } from '../utils/aiOutboundSafety';
import logger from '../utils/logger';

const AI_AGENT_ACTOR_ID = 'ai-agent';

function normalizeVinOrStock(value: unknown): string {
  return String(value || '').trim().toUpperCase();
}

async function resolveCurrentVehicleAndPrice(lead: any): Promise<{ vehicle: any; price?: number; previousPrice?: number } | null> {
  if (!lead?.vehicle) return null;
  const vin = normalizeVinOrStock(lead.vehicle.vin);
  const stock = normalizeVinOrStock(lead.vehicle.stock);

  let vehicle: any = null;
  if (vin) {
    vehicle = await Vehicle.findOne({ organizationId: lead.organizationId, vin: new RegExp(`^${vin}$`, 'i') }).lean();
  }
  if (!vehicle && stock) {
    vehicle = await Vehicle.findOne({ organizationId: lead.organizationId, stockNumber: new RegExp(`^${stock}$`, 'i') }).lean();
  }
  if (!vehicle && !vin && !stock) {
    const candidates = await Vehicle.find({ organizationId: lead.organizationId, isArchived: { $ne: true } }).limit(500).lean();
    vehicle = candidates.find((v: any) => matchesVehicle(lead.vehicle, v)) || null;
  }
  if (!vehicle || typeof vehicle.price !== 'number') return vehicle ? { vehicle } : null;

  const history = Array.isArray(vehicle.priceHistory) ? vehicle.priceHistory : [];
  const last = history[history.length - 1];
  return {
    vehicle,
    price: vehicle.price,
    previousPrice: typeof last?.previousPrice === 'number' ? last.previousPrice : undefined,
  };
}

export function validateOutboundEmailMessage(text: string, allowedPrices: number[] = []): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (/\d+\s?%\s?(off)?/i.test(text)) reasons.push('percent-off');
  if (/\bdiscount(s|ed)?\b|\bpromo(tion)?(al)?\b|\bincentive[s]?\b|\brebate[s]?\b|\bon sale\b|\bsale price\b|\bclearance\b|\bspecial offer\b/i.test(text)) reasons.push('discount/incentive language');
  if (/\bfinanc(e|ing)\b|\bloan[s]?\b|\blease[ds]?\b|\bAPR\b|\bdown payment\b|\bmonthly payment[s]?\b|\bcredit approv(al|ed)\b|\/\s?mo\b/i.test(text)) reasons.push('financing/payment language');
  if (/\btrade[\s-]?in\b/i.test(text)) reasons.push('trade-in mention');
  if (hasGuaranteedAvailabilityLanguage(text)) reasons.push('guaranteed-availability language');
  if (/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(text)) reasons.push('unexpected phone number');
  if (/https?:\/\/|www\.|[a-z0-9-]+\.(com|net|org|io)\b/i.test(text)) reasons.push('unexpected link');
  if (/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(text)) reasons.push('unexpected email address');

  const dollarAmounts = Array.from(text.matchAll(/\$\s?([\d,]+(?:\.\d{2})?)/g)).map((m) => parseFloat(m[1].replace(/,/g, '')));
  for (const amount of dollarAmounts) {
    if (!allowedPrices.some((p) => Math.abs(p - amount) < 0.5)) {
      reasons.push('unverified price figure');
    }
  }

  if (text.trim().length < 10) reasons.push('message too short or malformed');
  return { ok: reasons.length === 0, reasons: Array.from(new Set(reasons)) };
}

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

    const { enabled, agentName } = await resolveAiAgentSettings(String(orgId));
    if (!enabled) return;

    const messageId = new mongoose.Types.ObjectId();
    check = await beginAiAttentionCheck({
      organizationId: String(orgId),
      channel: 'email',
      targetId: String(lead._id),
      messageId: String(messageId),
    });

    if (!(await screenAiHumanAttention({ ...check, leadId: String(lead._id), body: text, agentName }))) return;

    claimedForGen = await claimAiGeneration(check);
    if (!claimedForGen) return;

    try {
      const [org, priceContext, transcript] = await Promise.all([
        Organization.findById(orgId).select('name').lean(),
        resolveCurrentVehicleAndPrice(lead),
        buildEmailTranscript(lead),
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
      });

      const customerName = [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() || 'A customer';

      const sendFallback = async (reason: string) => {
        const fallbackConfig = await OrgLeadConfig.findOne({ organizationId: orgId, isActive: true }).select('gmailAddress').lean();
        await sendLeadReplyEmail(lead, ALEX_FALLBACK_MESSAGE, AI_AGENT_ACTOR_ID, String(orgId), [], (fallbackConfig as any)?.gmailAddress);
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
      await sendLeadReplyEmail(lead, generation.text, AI_AGENT_ACTOR_ID, String(orgId), [], (config as any)?.gmailAddress);

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
    logger.error({ err, leadId: lead?._id }, '[AiEmailReply] triggerAiEmailReplyForNewInquiry failed');
  }
}
