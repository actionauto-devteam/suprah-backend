import Lead from '../models/lead.model';
import { parseEmailBody } from '../utils/adfParser';
import { normalizeIdentityEmail } from '../utils/contactIdentity';
import { buildInquiryContentKey } from '../utils/inquiryKeys';
import { LEAD_SOURCE } from '../constants/leadSource';
import { resolveVehicleContextForLead } from './leadLocation.service';
import { LeadIntakeResult, submitLeadInquiry } from './leadIntake.service';
import { adfInquiryRequest, startNewLeadAutomations } from './leadIntakeIntegration';
import { findInventoryVehicleReference, isAutomatedEmail, isEmailReply } from './emailInquiryEvidence';

export type GmailIntakeResult = LeadIntakeResult | { status: 'skipped'; reason: string };

export async function processGmailMessageThroughIntake(input: {
  organizationId: string;
  message: any;
  rawBody: string;
  leadSourceEmail?: string | null;
  systemUserId: string;
  allowNewInquiry: boolean;
}): Promise<GmailIntakeResult> {
  const { organizationId, message, rawBody } = input;
  const headers: any[] = message.payload?.headers || [];
  const header = (name: string) => headers.find((entry) => entry?.name?.toLowerCase() === name)?.value || '';
  const subject = header('subject');
  const from = header('from');
  const { parsedContent, channel, adfData } = await parseEmailBody(rawBody, subject, from);
  const senderAddress = normalizeIdentityEmail(from.match(/<([^<>]+)>/)?.[1] || from);
  const leadSource = normalizeIdentityEmail(input.leadSourceEmail);
  const fromLeadSource = Boolean(leadSource) && senderAddress === leadSource;
  const receivedAt = message.internalDate ? new Date(Number(message.internalDate)) : new Date();
  const threadId: string | undefined = message.threadId || undefined;
  const threadLead: any = threadId
    ? await Lead.findOne({ organizationId, threadId }).sort({ createdAt: -1 }).select('_id').lean()
    : null;
  const sourceIds = { gmailMessageId: message.id, gmailThreadId: threadId };
  const baseDraft: Record<string, unknown> = {
    createdBy: input.systemUserId,
    subject,
    body: rawBody,
    parsedContent,
    messageId: message.id,
    ...(threadLead ? {} : { threadId }),
    senderEmail: from,
    sourceSubmittedAt: receivedAt,
    centralIngestion: true,
  };

  if (adfData) {
    const vehicleContext = await resolveVehicleContextForLead(organizationId, adfData.vehicle).catch(() => null);
    const result = await submitLeadInquiry(adfInquiryRequest({
      organizationId,
      adf: adfData,
      receivedAt,
      channel,
      source: LEAD_SOURCE.THIRD_PARTY_LEAD,
      sourceIds,
      leadDraft: { ...baseDraft, vehicle: adfData.vehicle, vehicleId: vehicleContext?.vehicleId, location: vehicleContext?.location },
    }));
    await startNewLeadAutomations(organizationId, result).catch(() => undefined);
    return result;
  }

  const automated = !fromLeadSource && isAutomatedEmail(message);

  if (threadLead && !fromLeadSource) {
    return submitLeadInquiry({
      organizationId,
      kind: 'email_reply',
      receivedAt,
      channel: 'email',
      source: LEAD_SOURCE.EMAIL_INQUIRY,
      contact: { email: senderAddress || undefined, assurance: 'self_reported' },
      subject,
      comments: rawBody.slice(0, 10000),
      sourceIds,
      contextLeadId: threadLead._id,
      evidence: { automated, isReply: true, vehicleMatch: null },
    });
  }

  if (!input.allowNewInquiry) return { status: 'skipped', reason: 'not_a_lead_email' };

  const emailExcluded = channel === 'adf' || fromLeadSource;
  const reply = !emailExcluded && isEmailReply(message, subject);
  const reference = !emailExcluded && !automated && !reply
    ? await findInventoryVehicleReference(organizationId, [subject, rawBody].join('\n')).catch(() => null)
    : null;
  const referenced = reference?.vehicle;
  const result = await submitLeadInquiry({
    organizationId,
    kind: 'provider_inquiry',
    intentAssurance: emailExcluded || reference ? 'confirmed' : 'unconfirmed',
    evidence: emailExcluded ? null : { automated, isReply: reply, vehicleMatch: reference?.match || null },
    vehicle: referenced
      ? { year: referenced.year ? String(referenced.year) : undefined, make: referenced.make, model: referenced.modelName, trim: referenced.trim, vin: referenced.vin, stock: referenced.stockNumber }
      : undefined,
    receivedAt,
    channel,
    source: LEAD_SOURCE.EMAIL_INQUIRY,
    contact: { email: senderAddress || undefined, emailExcluded, assurance: 'self_reported' },
    subject,
    comments: rawBody.slice(0, 10000),
    sourceIds,
    contentKey: buildInquiryContentKey({ email: emailExcluded ? undefined : senderAddress, comments: rawBody }),
    leadDraft: {
      ...baseDraft,
      comments: '',
      email: senderAddress || '',
      identityEmailExcluded: emailExcluded,
      channel,
      ...(referenced
        ? {
            vehicle: { year: referenced.year ? String(referenced.year) : undefined, make: referenced.make, model: referenced.modelName, trim: referenced.trim, vin: referenced.vin, stock: referenced.stockNumber },
            vehicleId: referenced._id,
            location: referenced.dealerCity || undefined,
          }
        : {}),
    },
  });
  await startNewLeadAutomations(organizationId, result).catch(() => undefined);
  return result;
}
