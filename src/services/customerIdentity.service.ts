import mongoose from 'mongoose';
import { createHash } from 'crypto';
import Customer from '../models/Customer.model';
import Lead from '../models/lead.model';
import { Conversation } from '../models/communication.model';
import { contactIdentity, normalizeIdentityEmail, normalizeIdentityPhone } from '../utils/contactIdentity';
import { withCustomerIdentityLock } from './customerIdentityLock.service';
import logger from '../utils/logger';
import { ApiError } from '../utils/ApiError';
import { assertCustomerIdentityIndexesReady } from './customerIdentityIndexes.service';

export type CustomerLinkStatus = 'pending' | 'linked' | 'unresolved' | 'ambiguous' | 'conflict' | 'retry';
export interface CustomerLinkResult {
  status: CustomerLinkStatus;
  reason: string;
  customerId?: string;
  candidateIds: string[];
}
type IdentityInput = { email?: unknown; phone?: unknown; alternatePhone?: unknown };
export type IdentityCustomer = IdentityInput & { _id: mongoose.Types.ObjectId; organizationId: string; isActive?: boolean };

export function evaluateCustomerIdentity(input: IdentityInput, candidates: IdentityCustomer[]): CustomerLinkResult {
  const identity = contactIdentity(input);
  const matches = candidates.filter(customer => {
    const other = contactIdentity(customer);
    return Boolean(identity.normalizedEmail && identity.normalizedEmail === other.normalizedEmail)
      || Boolean(identity.normalizedPhone && [other.normalizedPhone, other.normalizedAlternatePhone].includes(identity.normalizedPhone));
  });
  const candidateIds = [...new Set(matches.map(customer => String(customer._id)))];
  if (candidateIds.length > 1) return { status: 'ambiguous', reason: 'multiple_customers_match', candidateIds };
  if (!matches.length) return { status: 'unresolved', reason: 'no_existing_customer', candidateIds: [] };
  const customer = matches[0];
  const other = contactIdentity(customer);
  if (customer.isActive === false) return { status: 'conflict', reason: 'inactive_customer', candidateIds };
  if (identity.normalizedEmail && other.normalizedEmail && identity.normalizedEmail !== other.normalizedEmail) {
    return { status: 'conflict', reason: 'email_phone_disagree', candidateIds };
  }
  const phones = [other.normalizedPhone, other.normalizedAlternatePhone].filter(Boolean);
  if (identity.normalizedPhone && phones.length && !phones.includes(identity.normalizedPhone)) {
    return { status: 'conflict', reason: 'email_phone_disagree', candidateIds };
  }
  return { status: 'linked', reason: 'exact_normalized_contact', customerId: String(customer._id), candidateIds };
}

export async function findIdentityCustomers(organizationId: string, input: IdentityInput): Promise<IdentityCustomer[]> {
  if (!organizationId) throw new Error('Organization is required for customer identity lookup');
  const identity = contactIdentity(input);
  if (!identity.normalizedEmail && !identity.normalizedPhone) return [];
  const conditions: Record<string, unknown>[] = [{ identityVersion: { $ne: 1 } }];
  if (identity.normalizedEmail) conditions.push({ normalizedEmail: identity.normalizedEmail });
  if (identity.normalizedPhone) conditions.push({ normalizedPhone: identity.normalizedPhone }, { normalizedAlternatePhone: identity.normalizedPhone });
  const matches: IdentityCustomer[] = [];
  const cursor = Customer.find({ organizationId, $or: conditions })
    .select('_id organizationId firstName lastName email phone alternatePhone isActive').maxTimeMS(5000).lean().cursor();
  try {
    for await (const customer of cursor) {
      const result = evaluateCustomerIdentity(input, [customer]);
      if (result.candidateIds.length) matches.push(customer);
      if (matches.length >= 20) break;
    }
  } finally {
    await cursor.close();
  }
  return matches;
}

export async function findUniqueCustomerByPhone(organizationId: string, phone: string) {
  if (!organizationId || !normalizeIdentityPhone(phone)) return null;
  const candidates = await findIdentityCustomers(organizationId, { phone });
  const match = evaluateCustomerIdentity({ phone }, candidates);
  return match.status === 'linked' ? candidates.find(customer => String(customer._id) === match.customerId) || null : null;
}

async function reconcileUnderLock(organizationId: string, leadId: string, renew: () => Promise<void>, options: { dryRun?: boolean; historical?: boolean } = {}): Promise<CustomerLinkResult> {
  const lead = await Lead.findOne({ _id: leadId, organizationId }).maxTimeMS(5000).lean();
  if (!lead) throw new ApiError(404, 'Lead not found in this organization');
  const senderAddress = normalizeIdentityEmail(lead.senderEmail?.match(/<([^<>]+)>/)?.[1] || lead.senderEmail);
  const historicalProxyContact = lead.identityEmailExcluded === undefined && Boolean(senderAddress)
    && senderAddress === normalizeIdentityEmail(lead.email) && (lead.channel === 'adf' || lead.centralIngestion === true);
  const emailExcluded = lead.identityEmailExcluded || historicalProxyContact;
  const input = { email: emailExcluded ? undefined : lead.email, phone: lead.phone };
  const identity = contactIdentity(input);
  const snapshot = { _id: lead._id, organizationId, email: lead.email ?? null, phone: lead.phone ?? null, identityEmailExcluded: lead.identityEmailExcluded ?? { $ne: true }, customerId: lead.customerId ?? null };
  const persist = async (result: CustomerLinkResult, clearInvalidReference = false) => {
    if (!options.dryRun) {
      await renew();
      const updated = await Lead.updateOne(snapshot, {
        $set: {
          customerLink: { ...result, customerId: undefined, checkedAt: new Date(), nextRetryAt: result.status === 'retry' ? new Date(Date.now() + 60000) : null },
          ...identity,
          ...(emailExcluded ? { identityEmailExcluded: true } : {}),
          ...(result.status === 'linked' ? { customerId: result.customerId } : {}),
        },
        ...(clearInvalidReference ? { $unset: { customerId: 1 } } : {}),
      }, { timestamps: false, maxTimeMS: 5000 });
      if (!updated.matchedCount) throw new Error('Lead contact changed during synchronization; retry required');
    }
    return result;
  };
  if (lead.source === 'Demo') return persist({ status: 'unresolved', reason: 'demo_excluded', candidateIds: [] });
  if ((!identity.normalizedEmail && !identity.normalizedPhone)
    || (String(input.email || '').trim() && !normalizeIdentityEmail(input.email))
    || (String(input.phone || '').trim() && !normalizeIdentityPhone(input.phone))) {
    return persist({ status: 'unresolved', reason: emailExcluded && !identity.normalizedPhone ? 'untrusted_sender_contact' : 'missing_or_invalid_contact', candidateIds: [] });
  }
  const candidates = await findIdentityCustomers(organizationId, input);
  const provenance = await Customer.find({ organizationId, $or: [
    { sourceLeadId: lead._id },
    { transactions: { $elemMatch: { type: 'lead', referenceModel: 'Lead', referenceId: leadId } } },
  ] }).select('_id organizationId email phone alternatePhone isActive').limit(21).maxTimeMS(5000).lean();
  const known = new Map([...candidates, ...provenance].map(customer => [String(customer._id), customer]));
  if (lead.customerId) {
    const linked = await Customer.findOne({ _id: lead.customerId, organizationId }).maxTimeMS(5000).lean();
    if (!linked) return persist({ status: 'conflict', reason: 'invalid_customer_reference', candidateIds: [] }, true);
    known.set(String(linked._id), linked);
  }
  const result = evaluateCustomerIdentity(input, [...known.values()]);
  const provenIds = new Set(provenance.map(customer => String(customer._id)));
  if (lead.customerId) provenIds.add(String(lead.customerId));
  if (provenIds.size > 1 || (provenIds.size === 1 && (!result.customerId || !provenIds.has(result.customerId)))) {
    return persist({ status: 'conflict', reason: 'existing_relationship_disagrees', candidateIds: [...known.keys()].slice(0, 20) });
  }
  if (result.status === 'ambiguous' || result.status === 'conflict') return persist(result);
  if (!result.customerId && options.historical) return persist(result);
  if (options.dryRun) return result.customerId ? result : { ...result, reason: 'would_create_customer' };
  let customerId = result.customerId;
  if (!customerId) {
    await renew();
    const identityCreationKey = createHash('sha256').update(identity.normalizedEmail ? `email:${identity.normalizedEmail}` : `phone:${identity.normalizedPhone}`).digest('hex');
    const customer = await Customer.findOneAndUpdate({ organizationId, identityCreationKey }, { $setOnInsert: {
      organizationId, identityCreationKey, createdBy: lead.createdBy,
      firstName: lead.firstName || 'Unknown', lastName: lead.lastName || '',
      ...(identity.normalizedEmail ? { email: identity.normalizedEmail } : {}),
      ...(identity.normalizedPhone ? { phone: String(lead.phone).trim() } : {}),
      ...identity, identityVersion: 1, source: 'lead', sourceLeadId: lead._id, isActive: true,
      vehicleInterest: lead.vehicle ? { year: lead.vehicle.year, make: lead.vehicle.make, model: lead.vehicle.model } : undefined, transactions: [], conversations: [],
    } }, { upsert: true, new: true, runValidators: true, maxTimeMS: 5000 });
    const verified = evaluateCustomerIdentity(input, [customer]);
    if (verified.status !== 'linked') return persist(verified);
    customerId = String(customer._id);
  }
  const linkedResult: CustomerLinkResult = { status: 'linked', reason: result.customerId ? result.reason : 'customer_created', customerId, candidateIds: [customerId] };
  const customer = await Customer.findOne({ _id: customerId, organizationId }).maxTimeMS(5000).lean();
  if (!customer) throw new Error('Customer disappeared during synchronization');
  const enrichment: Record<string, unknown> = {};
  if (!String(customer.email || '').trim() && identity.normalizedEmail) enrichment.email = identity.normalizedEmail;
  if (!String(customer.phone || '').trim() && identity.normalizedPhone) enrichment.phone = String(lead.phone).trim();
  if (!customer.vehicleInterest?.make && lead.vehicle?.make) enrichment.vehicleInterest = { year: lead.vehicle.year, make: lead.vehicle.make, model: lead.vehicle.model };
  const enriched = contactIdentity({ ...customer, ...enrichment });
  await renew();
  await Customer.updateOne({ _id: customerId, organizationId }, { $set: { ...enrichment, ...enriched, identityVersion: 1 } }, { maxTimeMS: 5000 });
  await persist(linkedResult);
  await renew();
  const title = [lead.vehicle?.year, lead.vehicle?.make, lead.vehicle?.model].filter(Boolean).join(' ') || 'Lead Inquiry';
  await Customer.updateOne({ _id: customerId, organizationId, transactions: { $not: { $elemMatch: { type: 'lead', referenceModel: 'Lead', referenceId: leadId } } } }, {
    $push: { transactions: { type: 'lead', status: 'pending', title, description: lead.comments || `Lead from ${lead.source || 'Unknown source'}`, referenceId: leadId, referenceModel: 'Lead', metadata: { channel: lead.channel, source: lead.source }, occurredAt: lead.createdAt } },
    $inc: { 'stats.totalTransactions': 1 },
  }, { maxTimeMS: 5000 });
  await Customer.updateOne({ _id: customerId, organizationId, sourceLeadId: null }, { $set: { sourceLeadId: lead._id } }, { maxTimeMS: 5000 });
  await Customer.updateOne({ _id: customerId, organizationId }, {
    $min: { 'stats.firstContactedAt': lead.createdAt || new Date() },
    $max: { 'stats.lastContactedAt': lead.createdAt || new Date() },
  }, { maxTimeMS: 5000 });
  await Conversation.updateMany({ orgId: { $in: [organizationId, new mongoose.Types.ObjectId(organizationId)] }, leadId: lead._id, customerId: null }, {
    $set: { customerId },
  }, { maxTimeMS: 5000 });
  return linkedResult;
}

export async function syncLeadCustomer(organizationId: string, leadId: string, options: { dryRun?: boolean; historical?: boolean } = {}) {
  if (!organizationId || !mongoose.isValidObjectId(leadId)) throw new ApiError(400, 'Organization and valid Lead ID are required');
  if (!mongoose.isValidObjectId(organizationId)) throw new ApiError(400, 'Valid organization ID is required');
  if (options.dryRun) return reconcileUnderLock(organizationId, leadId, async () => undefined, options);
  return withCustomerIdentityLock(organizationId, renew => reconcileUnderLock(organizationId, leadId, renew, options));
}

export async function syncLeadCustomerSafely(organizationId: string, leadId: string) {
  try {
    return await syncLeadCustomer(organizationId, leadId);
  } catch (error) {
    logger.warn({ error, organizationId, leadId }, 'Lead customer synchronization needs retry');
    await Lead.updateOne({ _id: leadId, organizationId }, { $set: {
      'customerLink.status': 'retry', 'customerLink.reason': 'synchronization_failed', 'customerLink.nextRetryAt': new Date(Date.now() + 60000),
    } }, { timestamps: false }).catch(() => undefined);
    return { status: 'retry' as const, reason: 'synchronization_failed', candidateIds: [] };
  }
}

export async function reconcileHistoricalLeads(organizationId: string, options: { apply?: boolean; after?: string; limit?: number } = {}) {
  if (!mongoose.isValidObjectId(organizationId)) throw new ApiError(400, 'A valid organization ID is required');
  if (options.after && !mongoose.isValidObjectId(options.after)) throw new ApiError(400, 'Invalid reconciliation cursor');
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200)) throw new ApiError(400, 'Reconciliation limit must be an integer from 1 to 200');
  if (options.apply) await assertCustomerIdentityIndexesReady();
  const leads = await Lead.find({ organizationId, ...(options.after ? { _id: { $gt: options.after } } : {}) })
    .sort({ _id: 1 }).limit(Math.min(200, Math.max(1, options.limit || 50))).select('_id').lean();
  const results: Array<CustomerLinkResult & { leadId: string }> = [];
  for (const lead of leads) {
    try {
      results.push({ leadId: String(lead._id), ...await syncLeadCustomer(organizationId, String(lead._id), { dryRun: !options.apply, historical: true }) });
    } catch (error) {
      results.push({ leadId: String(lead._id), status: 'retry', reason: 'reconciliation_failed', candidateIds: [] });
    }
  }
  return { organizationId, dryRun: !options.apply, results, nextCursor: leads.length ? String(leads[leads.length - 1]._id) : null };
}

export async function retryPendingLeadCustomers(limit = 25) {
  const leads = await Lead.find({ 'customerLink.status': { $in: ['pending', 'retry'] }, 'customerLink.nextRetryAt': { $lte: new Date() } })
    .sort({ 'customerLink.nextRetryAt': 1 }).limit(Math.min(100, limit)).select('_id organizationId').lean();
  for (const lead of leads) await syncLeadCustomerSafely(String(lead.organizationId), String(lead._id));
  return leads.length;
}
