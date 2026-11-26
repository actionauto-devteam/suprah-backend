import Lead from '../models/lead.model';
import { NURTURE_ELIGIBLE_STATUSES } from '../constants/leadStatus';
import Vehicle, { IVehicle } from '../models/Vehicle.model';
import VehicleReengagementLog from '../models/VehicleReengagementLog.model';
import { sendAutomatedSms, isSmsOptedOut } from './communication.service';
import { decideAiDelivery, AI_NOT_LIVE_REASON } from './aiOperatingMode.service';
import { AiReplySuppressedError } from '../utils/aiReplySuppressed';
import { resolveAiAgentSettings } from './aiAgent.service';
import { resolvePinnedVehicleContext, latestSharedConversationActivity } from './vehicleInquiryContext.service';
import { normalizeIdentityPhone } from '../utils/contactIdentity';
import { resolveSmsDestination } from '../utils/smsDestination';
import { checkContactForSend, contactRestrictionMessage, isContactRestrictedError } from './contactRestriction.service';
import { normalizeToken, matchesVehicle } from '../utils/vehicleMatch';

const COOLDOWN_DAYS = parseInt(process.env.VEHICLE_REENGAGEMENT_COOLDOWN_DAYS || '30', 10);
const MAX_LEAD_AGE_DAYS = parseInt(process.env.VEHICLE_REENGAGEMENT_MAX_LEAD_AGE_DAYS || '180', 10);
const MAX_MATCHES_PER_VEHICLE = parseInt(process.env.VEHICLE_REENGAGEMENT_MAX_MATCHES_PER_VEHICLE || '15', 10);
const CANDIDATE_SCAN_LIMIT = 2000;

const STOP_SUFFIX = ' Reply STOP to opt out.';
const MAX_FINAL_LENGTH = 600;
const MAX_LINK_LENGTH = 300;
const REENGAGEMENT_DEALERSHIP = 'Action Auto Sales and Finance';
const PLACEHOLDER_NAMES = new Set(['unknown', 'customer', 'n/a', 'na', 'none']);
const ACTIVE_CONVERSATION_WINDOW_MS =
  parseInt(process.env.VEHICLE_REENGAGEMENT_ACTIVE_CONVERSATION_HOURS || '48', 10) * 60 * 60 * 1000;

export { normalizeToken, matchesVehicle };

export async function findMatchingLeads(vehicle: IVehicle) {
  const cooldownCutoff = new Date(Date.now() - COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
  const maxAgeCutoff = new Date(Date.now() - MAX_LEAD_AGE_DAYS * 24 * 60 * 60 * 1000);

  const candidates = await Lead.find({
    organizationId: vehicle.organizationId,
    status: { $in: NURTURE_ELIGIBLE_STATUSES },
    phone: { $exists: true, $ne: '' },
    createdAt: { $gte: maxAgeCutoff },
    $or: [
      { 'followUp.lastReengagementAt': null },
      { 'followUp.lastReengagementAt': { $exists: false } },
      { 'followUp.lastReengagementAt': { $lt: cooldownCutoff } },
    ],
    'vehicle.year': { $exists: true, $ne: '' },
    'vehicle.make': { $exists: true, $ne: '' },
    'vehicle.model': { $exists: true, $ne: '' },
  })
    .select('organizationId firstName lastName phone vehicle followUp createdAt')
    .limit(CANDIDATE_SCAN_LIMIT)
    .lean();

  const matched = candidates.filter((lead: any) => matchesVehicle(lead.vehicle, vehicle));

  matched.sort((a: any, b: any) => {
    const aTime = new Date(a.followUp?.lastCustomerActivityAt || a.createdAt).getTime();
    const bTime = new Date(b.followUp?.lastCustomerActivityAt || b.createdAt).getTime();
    return bTime - aTime;
  });

  return matched.slice(0, MAX_MATCHES_PER_VEHICLE);
}

function greetingName(value: unknown): string {
  const name = String(value || '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > 30 || /[@\d<>{}[\]\\/]/.test(name) || PLACEHOLDER_NAMES.has(name.toLowerCase())) return 'there';
  return name;
}

function vehicleLink(value: unknown): string {
  const link = String(value || '').trim();
  if (!link || link.length > MAX_LINK_LENGTH || /\s/.test(link)) return '';
  try {
    const url = new URL(link);
    return url.protocol === 'https:' || url.protocol === 'http:' ? link : '';
  } catch {
    return '';
  }
}

export function buildReengagementText(lead: any, vehicle: IVehicle, agentName: string): string {
  const vehicleLabel = [vehicle.year, vehicle.make, vehicle.modelName, vehicle.trim].filter(Boolean).join(' ') || 'vehicle';
  const link = vehicleLink(vehicle.vdpUrl);
  return [
    `Hey ${greetingName(lead.firstName)}, this is ${agentName} from ${REENGAGEMENT_DEALERSHIP}.`,
    `The ${vehicleLabel} has completed the reconditioning process and is now ready for sale.`,
    'Please book a test drive or schedule an appointment today!',
    link ? `Click here for vehicle information: ${link}` : '',
  ].filter(Boolean).join(' ');
}

export async function generateReengagementMessage(
  lead: any,
  vehicle: IVehicle,
): Promise<{ text: string | null; error?: string }> {
  const { agentName } = await resolveAiAgentSettings(String(vehicle.organizationId));
  return { text: buildReengagementText(lead, vehicle, agentName) };
}

async function writeLog(entry: Partial<IVehicleReengagementLogInput>) {
  try {
    await VehicleReengagementLog.create(entry as any);
  } catch (err) {
    console.error('[VehicleReengagement] Failed to write log:', err);
  }
}

interface IVehicleReengagementLogInput {
  organizationId: string;
  vehicleId: any;
  leadId: any;
  vehicleLabel: string;
  leadVehicleLabel?: string;
  leadName: string;
  leadPhone: string;
  generatedMessage?: string;
  finalMessage?: string;
  status: 'blocked' | 'sent' | 'failed' | 'skipped' | 'skipped_ai_not_live';
  blockedReason?: string;
  classifierVerdict?: 'SAFE' | 'UNSAFE' | 'ERROR';
  failureReason?: string;
  sentAt?: Date;
}

export async function processLeadForVehicle(lead: any, vehicle: IVehicle): Promise<void> {
  const vehicleLabel = [vehicle.year, vehicle.make, vehicle.modelName, vehicle.trim].filter(Boolean).join(' ');
  const leadVehicleLabel = [lead.vehicle?.year, lead.vehicle?.make, lead.vehicle?.model].filter(Boolean).join(' ');
  const leadName = [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() || 'Customer';

  const base: Omit<IVehicleReengagementLogInput, 'status'> = {
    organizationId: vehicle.organizationId,
    vehicleId: vehicle._id,
    leadId: lead._id,
    vehicleLabel,
    leadVehicleLabel,
    leadName,
    leadPhone: lead.phone,
  };

  const delivery = await decideAiDelivery({
    organizationId: vehicle.organizationId,
    channel: 'sms',
    workflow: 'vehicle_reengagement',
    toPhone: lead.phone,
    leadId: lead._id,
  });
  if (delivery.action !== 'send') {
    await writeLog({ ...base, status: 'skipped_ai_not_live', failureReason: delivery.reason || `${AI_NOT_LIVE_REASON} (sms: ${delivery.mode})` });
    return;
  }

  if (await isSmsOptedOut(vehicle.organizationId, lead.phone)) {
    await writeLog({ ...base, status: 'skipped', failureReason: 'Customer opted out of SMS' });
    return;
  }

  const destination = resolveSmsDestination(lead.phone, 'automated');
  if (!destination.ok) {
    await writeLog({ ...base, status: 'skipped', failureReason: destination.message });
    return;
  }

  const restriction = await checkContactForSend({
    organizationId: vehicle.organizationId,
    phone: lead.phone,
    email: lead.email,
    leadId: lead._id,
    customerId: lead.customerId,
  }, { channel: 'sms', purpose: 'vehicle_reengagement', actor: { kind: 'ai', userId: 'ai-agent', name: null } });
  if (restriction.status !== 'allowed') {
    await writeLog({
      ...base,
      status: restriction.status === 'restricted' ? 'skipped' : 'failed',
      failureReason: contactRestrictionMessage(restriction) || undefined,
    });
    return;
  }

  const vehicleContext = await resolvePinnedVehicleContext({ organizationId: vehicle.organizationId, lead, phone: lead.phone });
  if (vehicleContext.multipleInquiries) {
    const sharedActivityAt = await latestSharedConversationActivity(vehicle.organizationId, lead.phone).catch(() => null);
    if (sharedActivityAt && Date.now() - sharedActivityAt.getTime() < ACTIVE_CONVERSATION_WINDOW_MS) {
      await writeLog({
        ...base,
        status: 'skipped',
        failureReason: 'Customer has other open vehicle inquiries and an active text conversation — left for staff',
      });
      return;
    }
  }

  const generation = await generateReengagementMessage(lead, vehicle);
  if (!generation.text) {
    await writeLog({ ...base, status: 'failed', failureReason: generation.error || 'Draft generation failed' });
    return;
  }
  const draft = generation.text;

  const finalMessage = `${draft}${STOP_SUFFIX}`;

  if (finalMessage.length > MAX_FINAL_LENGTH) {
    await writeLog({
      ...base,
      generatedMessage: draft,
      finalMessage,
      status: 'blocked',
      blockedReason: 'message too long after opt-out suffix',
    });
    return;
  }

  let sent: boolean;
  try {
    sent = await sendAutomatedSms({
      orgId: vehicle.organizationId,
      toPhone: lead.phone,
      body: finalMessage,
      leadId: lead._id,
      aiWorkflow: 'vehicle_reengagement',
    });
  } catch (err) {
    if (isContactRestrictedError(err)) {
      await writeLog({
        ...base,
        generatedMessage: draft,
        finalMessage,
        status: err.restricted ? 'skipped' : 'failed',
        failureReason: err.message,
      });
      return;
    }
    if (!(err instanceof AiReplySuppressedError)) throw err;
    await writeLog({
      ...base,
      generatedMessage: draft,
      finalMessage,
      status: 'skipped_ai_not_live',
      failureReason: `${AI_NOT_LIVE_REASON} (changed before send)`,
    });
    return;
  }

  if (!sent) {
    await writeLog({
      ...base,
      generatedMessage: draft,
      finalMessage,
      status: 'skipped',
      failureReason: 'Customer opted out of SMS',
    });
    return;
  }

  const now = new Date();
  await Lead.updateOne(
    { _id: lead._id },
    {
      $set: { 'followUp.lastReengagementAt': now },
      $inc: { 'followUp.reengagementCount': 1 },
      $max: { 'campaignSentAt.reengagement': now },
    },
  );

  await writeLog({
    ...base,
    generatedMessage: draft,
    finalMessage,
    status: 'sent',
    sentAt: now,
  });
}

export async function processVehicleForReengagement(vehicle: IVehicle): Promise<{ matched: number }> {
  const leads = await findMatchingLeads(vehicle);
  const contactedPhones = new Set<string>();
  for (const lead of leads) {
    const phoneKey = normalizeIdentityPhone(lead.phone) || String(lead.phone || '').replace(/\D/g, '');
    if (phoneKey && contactedPhones.has(phoneKey)) {
      await writeLog({
        organizationId: vehicle.organizationId,
        vehicleId: vehicle._id,
        leadId: lead._id,
        vehicleLabel: [vehicle.year, vehicle.make, vehicle.modelName, vehicle.trim].filter(Boolean).join(' '),
        leadVehicleLabel: [lead.vehicle?.year, lead.vehicle?.make, lead.vehicle?.model].filter(Boolean).join(' '),
        leadName: [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim() || 'Customer',
        leadPhone: lead.phone,
        status: 'skipped',
        failureReason: 'Same customer was already matched to this vehicle through another inquiry',
      });
      continue;
    }
    if (phoneKey) contactedPhones.add(phoneKey);
    await processLeadForVehicle(lead, vehicle);
  }
  return { matched: leads.length };
}
