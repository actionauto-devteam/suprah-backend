import mongoose from 'mongoose';
import Customer from '../models/Customer.model';
import Lead from '../models/lead.model';
import OrgLeadConfig from '../models/OrgLeadConfig.model';
import { contactIdentity, normalizeIdentityEmail } from '../utils/contactIdentity';
import { verifyCustomerIdentityIndexes } from './customerIdentityIndexes.service';
import { syncLeadCustomerSafely } from './customerIdentity.service';
import { isAutomatedEmailReply } from './leadIntake.service';
import logger from '../utils/logger';
import { ApiError } from '../utils/ApiError';

const CENTRAL_LEAD_SOURCE_EMAIL = 'leads@dealerscloud.com';

export const LEADS_WAITING_FOR_CUSTOMER = {
  $or: [
    { customerLink: { $exists: false } },
    { 'customerLink.status': { $in: ['pending', 'retry'] } },
    { 'customerLink.status': 'unresolved', 'customerLink.reason': 'no_existing_customer' },
  ],
};

const OLD_LEADS = {
  organizationId: { $exists: true, $ne: null },
  $or: [
    { customerLink: { $exists: false } },
    { 'customerLink.status': 'unresolved', 'customerLink.reason': 'no_existing_customer' },
  ],
};

let leadCursor: mongoose.Types.ObjectId | null = null;

export function resetCustomerCatchUpCursor() {
  leadCursor = null;
}

export async function prepareLegacyCustomers(limit = 500) {
  const customers = await Customer.find({ identityVersion: { $ne: 1 } })
    .select('_id email phone alternatePhone').limit(limit).maxTimeMS(10000).lean();
  for (const customer of customers) {
    await Customer.updateOne(
      { _id: customer._id, identityVersion: { $ne: 1 } },
      { $set: { ...contactIdentity(customer), identityVersion: 1 } },
      { timestamps: false, maxTimeMS: 5000 },
    );
  }
  return customers.length;
}

export function isProviderEmail(email: string, providerEmails: Set<string>) {
  return providerEmails.has(email) || isAutomatedEmailReply({ fromEmail: email });
}

async function providerEmailsFor(organizationId: string, cache: Map<string, Set<string>>) {
  let emails = cache.get(organizationId);
  if (!emails) {
    const config: any = await OrgLeadConfig.findOne({ organizationId }).select('leadSourceEmail gmailAddress').lean();
    emails = new Set([CENTRAL_LEAD_SOURCE_EMAIL, config?.leadSourceEmail, config?.gmailAddress]
      .map((value) => normalizeIdentityEmail(value))
      .filter((value): value is string => Boolean(value)));
    cache.set(organizationId, emails);
  }
  return emails;
}

export async function catchUpLeadCustomersInBackground(options: { leadBatchSize?: number; customerBatchSize?: number; timeBudgetMs?: number } = {}) {
  const { ready } = await verifyCustomerIdentityIndexes();
  if (!ready) return { ready: false, prepared: 0, processed: 0 };
  const deadline = Date.now() + (options.timeBudgetMs ?? 40000);
  const customerBatchSize = options.customerBatchSize ?? 500;
  let prepared = 0;
  for (;;) {
    const count = await prepareLegacyCustomers(customerBatchSize);
    prepared += count;
    if (count < customerBatchSize || Date.now() > deadline) break;
  }
  let processed = 0;
  if (Date.now() <= deadline) {
    const leads = await Lead.find({ ...OLD_LEADS, ...(leadCursor ? { _id: { $gt: leadCursor } } : {}) })
      .sort({ _id: 1 }).limit(options.leadBatchSize ?? 200)
      .select('_id organizationId email identityEmailExcluded').maxTimeMS(10000).lean();
    if (!leads.length) leadCursor = null;
    const providers = new Map<string, Set<string>>();
    for (const lead of leads) {
      if (Date.now() > deadline) break;
      const organizationId = String(lead.organizationId);
      const email = normalizeIdentityEmail(lead.email);
      if (email && lead.identityEmailExcluded === undefined && isProviderEmail(email, await providerEmailsFor(organizationId, providers))) {
        await Lead.updateOne({ _id: lead._id }, { $set: { identityEmailExcluded: true } }, { timestamps: false });
      }
      await syncLeadCustomerSafely(organizationId, String(lead._id));
      leadCursor = lead._id as mongoose.Types.ObjectId;
      processed++;
    }
  }
  if (prepared || processed) logger.info({ prepared, processed }, 'Customer records catch-up batch');
  return { ready: true, prepared, processed };
}

export async function getCustomerCatchUpStatus(organizationId: string) {
  if (!mongoose.isValidObjectId(organizationId)) throw new ApiError(400, 'A valid organization ID is required');
  const [indexes, remaining] = await Promise.all([
    verifyCustomerIdentityIndexes(),
    Lead.countDocuments({ organizationId, ...LEADS_WAITING_FOR_CUSTOMER }).maxTimeMS(10000),
  ]);
  return { ready: indexes.ready, remaining };
}
