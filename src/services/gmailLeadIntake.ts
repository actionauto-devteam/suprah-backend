import Lead from '../models/lead.model';
import { isADFContent, parseEmailBody } from '../utils/adfParser';
import { normalizeIdentityEmail } from '../utils/contactIdentity';
import { buildInquiryContentKey } from '../utils/inquiryKeys';
import { LEAD_SOURCE } from '../constants/leadSource';
import { activeLeadStores, resolveLeadStore, storeForStock } from '../utils/leadStore';
import { LeadIntakeResult, findOpenLeadForContact, submitLeadInquiry } from './leadIntake.service';
import { adfInquiryRequest, startNewLeadAutomations } from './leadIntakeIntegration';
import {
  classifyPlainEmail,
  emailMessageIdOf,
  findInventoryVehicleReference,
  forwardedFromAddress,
  isAutomatedEmail,
  isEmailReply,
  senderDisplayName,
} from './emailInquiryEvidence';
import { FREE_MAIL_DOMAINS } from '../utils/freeMailDomains';
import { NOT_A_LEAD_STATUS } from '../constants/leadStatus';

const PLATFORM_NOTICE_SENDERS = new Set(['salesleads@cars.com', 'dealerleads@autotrader.com']);

export type GmailIntakeResult =
  | LeadIntakeResult
  | { status: 'skipped'; reason: string }
  | { status: 'sorted'; inquiryId: string; leadId: string | null; reason: string };

export async function processGmailMessageThroughIntake(input: {
  organizationId: string;
  message: any;
  rawBody: string;
  leadSourceEmail?: string | null;
  systemUserId: string;
  allowNewInquiry: boolean;
  mailbox?: string | null;
  plainEmailLeads?: boolean;
  ownAddresses?: string[];
  staffEmails?: Set<string>;
  notLeadSenders?: string[];
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
    ? await Lead.findOne({ organizationId, $or: [{ threadId }, { previousThreadIds: threadId }] }).sort({ createdAt: -1 }).select('_id').lean()
    : null;
  const emailMessageId = emailMessageIdOf(message) || undefined;
  const mailbox = normalizeIdentityEmail(input.mailbox) || undefined;
  const sourceIds = { gmailMessageId: message.id, gmailThreadId: threadId, emailMessageId, mailbox };
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
    const vehicleContext = await resolveLeadStore(organizationId, adfData.vehicle).catch(() => null);
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

  const leadSourceDomain = leadSource ? leadSource.split('@')[1] || '' : '';
  const senderDomain = senderAddress ? senderAddress.split('@')[1] || '' : '';
  const fromLeadSourceDomain = fromLeadSource
    || (Boolean(leadSourceDomain) && !FREE_MAIL_DOMAINS.has(leadSourceDomain) && senderDomain === leadSourceDomain);
  if (fromLeadSourceDomain && !isADFContent(rawBody.toLowerCase())) return { status: 'skipped', reason: 'lead_source_notice' };
  if (senderAddress && PLATFORM_NOTICE_SENDERS.has(senderAddress) && !isADFContent(rawBody.toLowerCase())) {
    return { status: 'skipped', reason: 'platform_notice' };
  }

  const ownAddresses = new Set((input.ownAddresses || []).map((address) => normalizeIdentityEmail(address)).filter(Boolean) as string[]);
  if (senderAddress && ownAddresses.has(senderAddress)) return { status: 'skipped', reason: 'own_mailbox' };

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

  if (input.plainEmailLeads && !fromLeadSource) {
    return routePlainEmail({
      organizationId,
      message,
      rawBody,
      subject,
      from,
      senderAddress: senderAddress || '',
      receivedAt,
      sourceIds,
      baseDraft,
      ownAddresses,
      staffEmails: input.staffEmails || new Set(),
      notLeadSenders: new Set((input.notLeadSenders || []).map((address) => normalizeIdentityEmail(address)).filter(Boolean) as string[]),
    });
  }

  if (!input.allowNewInquiry) return { status: 'skipped', reason: 'not_a_lead_email' };

  const emailExcluded = channel === 'adf' || fromLeadSource;
  const reply = !emailExcluded && isEmailReply(message, subject);
  const reference = !emailExcluded && !automated && !reply
    ? await findInventoryVehicleReference(organizationId, [subject, rawBody].join('\n')).catch(() => null)
    : null;
  const referenced = reference?.vehicle;
  const referencedStore = referenced?.stockNumber
    ? storeForStock(await activeLeadStores(organizationId).catch(() => []), referenced.stockNumber)
    : null;
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
            location: referencedStore || referenced.dealerCity || undefined,
          }
        : {}),
    },
  });
  await startNewLeadAutomations(organizationId, result).catch(() => undefined);
  return result;
}

async function routePlainEmail(input: {
  organizationId: string;
  message: any;
  rawBody: string;
  subject: string;
  from: string;
  senderAddress: string;
  receivedAt: Date;
  sourceIds: Record<string, unknown>;
  baseDraft: Record<string, unknown>;
  ownAddresses: Set<string>;
  staffEmails: Set<string>;
  notLeadSenders: Set<string>;
}): Promise<GmailIntakeResult> {
  const { organizationId, message, rawBody, subject, senderAddress, receivedAt, sourceIds } = input;
  const ownDomains = new Set([...input.ownAddresses].map((address) => address.split('@')[1] || '').filter(Boolean));
  const route = classifyPlainEmail({
    message,
    subject,
    senderAddress,
    staffEmails: input.staffEmails,
    ownDomains,
    notLeadSenders: input.notLeadSenders,
  });
  const comments = rawBody.slice(0, 10000);
  const forwardedFrom = forwardedFromAddress(message, input.ownAddresses);
  const sourceProvider = forwardedFrom ? `Forwarded from ${forwardedFrom}` : undefined;
  const name = senderDisplayName(input.from);
  const reply = isEmailReply(message, subject);

  if (route.route === 'dismiss') {
    return submitLeadInquiry({
      organizationId,
      kind: 'provider_inquiry',
      intentAssurance: 'unconfirmed',
      evidence: { automated: true, isReply: reply, vehicleMatch: null },
      receivedAt,
      channel: 'email',
      source: LEAD_SOURCE.EMAIL_INQUIRY,
      sourceProvider,
      contact: { email: senderAddress || undefined, assurance: 'self_reported' },
      subject,
      comments,
      sourceIds,
    });
  }

  if (route.route === 'others') {
    const sorted = await submitLeadInquiry({
      organizationId,
      kind: 'provider_inquiry',
      intentAssurance: 'confirmed',
      evidence: null,
      receivedAt,
      channel: 'email',
      source: LEAD_SOURCE.EMAIL_INQUIRY,
      sourceProvider,
      contact: { ...name, email: senderAddress || undefined, emailExcluded: true, assurance: 'self_reported' },
      subject,
      comments,
      sourceIds,
      sideEffects: { notification: 'skipped', alexReply: 'skipped' },
      leadDraft: {
        ...Object.fromEntries(Object.entries(input.baseDraft).filter(([key]) => key !== 'threadId')),
        comments: '',
        email: senderAddress || '',
        identityEmailExcluded: true,
        channel: 'email',
        status: NOT_A_LEAD_STATUS,
        othersReason: route.reason,
      },
    });
    if (sorted.status === 'associated') return { status: 'sorted', inquiryId: sorted.inquiryId, leadId: sorted.leadId, reason: route.reason };
    return sorted;
  }

  const openLead: any = senderAddress ? await findOpenLeadForContact(organizationId, { email: senderAddress }) : null;
  if (openLead) {
    return submitLeadInquiry({
      organizationId,
      kind: 'email_reply',
      receivedAt,
      channel: 'email',
      source: LEAD_SOURCE.EMAIL_INQUIRY,
      sourceProvider,
      contact: { email: senderAddress, assurance: 'self_reported' },
      subject,
      comments,
      sourceIds,
      contextLeadId: openLead._id,
      evidence: { automated: false, isReply: reply, vehicleMatch: null },
    });
  }

  const reference = await findInventoryVehicleReference(organizationId, [subject, rawBody].join('\n')).catch(() => null);
  const referenced = reference?.vehicle;
  const referencedStore = referenced?.stockNumber
    ? storeForStock(await activeLeadStores(organizationId).catch(() => []), referenced.stockNumber)
    : null;
  const vehicle = referenced
    ? { year: referenced.year ? String(referenced.year) : undefined, make: referenced.make, model: referenced.modelName, trim: referenced.trim, vin: referenced.vin, stock: referenced.stockNumber }
    : undefined;
  const result = await submitLeadInquiry({
    organizationId,
    kind: 'provider_inquiry',
    intentAssurance: 'confirmed',
    evidence: { automated: false, isReply: reply, vehicleMatch: reference?.match || null },
    vehicle,
    receivedAt,
    channel: 'email',
    source: LEAD_SOURCE.EMAIL_INQUIRY,
    sourceProvider,
    contact: { ...name, email: senderAddress || undefined, assurance: 'self_reported' },
    subject,
    comments,
    sourceIds,
    contentKey: buildInquiryContentKey({ email: senderAddress, comments: rawBody }),
    leadDraft: {
      ...input.baseDraft,
      comments: '',
      email: senderAddress || '',
      channel: 'email',
      ...(referenced
        ? { vehicle, vehicleId: referenced._id, location: referencedStore || referenced.dealerCity || undefined }
        : {}),
    },
  });
  await startNewLeadAutomations(organizationId, result, { email: false }).catch(() => undefined);
  return result;
}
