import Customer, { ICustomer, ICustomerTransaction, ICustomerConversation } from '../models/Customer.model';
import Lead from '../models/lead.model';
import mongoose from 'mongoose';
import { createHash } from 'crypto';
import { contactIdentity } from '../utils/contactIdentity';
import { evaluateCustomerIdentity, findIdentityCustomers, syncLeadCustomer, syncLeadCustomerSafely } from './customerIdentity.service';
import { withCustomerIdentityLock } from './customerIdentityLock.service';
import { ApiError } from '../utils/ApiError';


export interface CreateCustomerInput {
  organizationId: string;
  createdBy: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  alternatePhone?: string;
  dateOfBirth?: Date;
  address?: {
    street?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };
  notes?: string;
  tags?: string[];
  preferredContactMethod?: 'email' | 'phone' | 'sms';
  vehicleInterest?: {
    year?: string;
    make?: string;
    model?: string;
    trim?: string;
    vin?: string;
    budget?: string;
    condition?: 'new' | 'used' | 'certified';
  };
  source: 'lead' | 'manual' | 'import' | 'booking';
  sourceLeadId?: string;
}

export interface UpsertFromLeadInput {
  organizationId: string;
  createdBy: string;
  leadId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  vehicleInterest?: {
    year?: string;
    make?: string;
    model?: string;
  };
  channel?: string;
  comments?: string;
  source?: string;
}

export interface GetCustomersOptions {
  page?: number;
  limit?: number;
  search?: string;
  source?: string;
  isActive?: boolean;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  startDate?: Date;
  endDate?: Date;
}

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  existingCustomer?: ICustomer | null;
  matchType?: 'email_and_phone' | 'email_only' | 'phone_only';
  confidence?: number;
}


function validateContact(input: { email?: unknown; phone?: unknown; alternatePhone?: unknown }) {
  const identity = contactIdentity(input);
  if ((!identity.normalizedEmail && !identity.normalizedPhone)
    || (String(input.email || '').trim() && !identity.normalizedEmail)
    || (String(input.phone || '').trim() && !identity.normalizedPhone)
    || (String(input.alternatePhone || '').trim() && !identity.normalizedAlternatePhone)) {
    throw new ApiError(400, 'Provide a valid email or full phone number');
  }
  return identity;
}

async function checkDuplicate(orgId: string, email: string, phone: string, excludeId?: string): Promise<DuplicateCheckResult> {
  const candidates = (await findIdentityCustomers(orgId, { email, phone })).filter(customer => String(customer._id) !== excludeId);
  const result = evaluateCustomerIdentity({ email, phone }, candidates);
  if (result.status === 'ambiguous' || result.status === 'conflict') {
    throw new ApiError(409, 'Customer identity requires review', [{ reason: result.reason, candidateIds: result.candidateIds }]);
  }
  if (!result.customerId) return { isDuplicate: false };
  const customer = await Customer.findOne({ _id: result.customerId, organizationId: orgId });
  return { isDuplicate: true, existingCustomer: customer, matchType: email && phone ? 'email_and_phone' : email ? 'email_only' : 'phone_only' };
}

async function createCustomer(input: CreateCustomerInput): Promise<{ customer: ICustomer; isNew: boolean; duplicateType?: string }> {
  const identity = validateContact(input);
  return withCustomerIdentityLock(input.organizationId, async renew => {
    const duplicate = await checkDuplicate(input.organizationId, input.email, input.phone);
    if (identity.normalizedAlternatePhone) {
      const alternate = await findIdentityCustomers(input.organizationId, { phone: input.alternatePhone });
      if (alternate.some(customer => String(customer._id) !== String(duplicate.existingCustomer?._id))) throw new ApiError(409, 'Alternate phone matches another customer; review required');
    }
    if (duplicate.existingCustomer) return { customer: duplicate.existingCustomer, isNew: false, duplicateType: duplicate.matchType };
    await renew();
    const customer = await Customer.create({
      ...input, email: identity.normalizedEmail || undefined, phone: input.phone?.trim() || undefined,
      ...identity, identityVersion: 1,
      identityCreationKey: createHash('sha256').update(identity.normalizedEmail ? `email:${identity.normalizedEmail}` : `phone:${identity.normalizedPhone}`).digest('hex'),
    });
    return { customer, isNew: true };
  });
}

async function upsertFromLead(input: UpsertFromLeadInput): Promise<ICustomer> {
  const result = await syncLeadCustomer(input.organizationId, input.leadId);
  if (!result.customerId || result.status !== 'linked') throw new ApiError(409, 'Lead customer relationship requires review', [result]);
  const customer = await Customer.findOne({ _id: result.customerId, organizationId: input.organizationId });
  if (!customer) throw new ApiError(409, 'Linked customer is unavailable');
  return customer;
}

/**
 * Paginated customer list with search and filters.
 */
async function getCustomers(orgId: string, opts: GetCustomersOptions) {
  const {
    page = 1, limit = 25, search, source, isActive,
    sortBy = 'createdAt', sortOrder = 'desc',
    startDate, endDate,
  } = opts;

  const query: any = { organizationId: orgId };

  if (isActive !== undefined) query.isActive = isActive;
  if (source) query.source = source;
  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = startDate;
    if (endDate) query.createdAt.$lte = endDate;
  }

  if (search && search.trim()) {
    const s = search.trim();
    const digitOnly = s.replace(/\D/g, '');

    if (digitOnly.length >= 4) {
      // Phone search — broad regex on indexed phone field
      query.$or = [
        { phone: { $regex: digitOnly, $options: 'i' } },
        { alternatePhone: { $regex: digitOnly, $options: 'i' } },
      ];
    } else {
      query.$or = [
        { firstName: { $regex: s, $options: 'i' } },
        { lastName: { $regex: s, $options: 'i' } },
        { email: { $regex: s, $options: 'i' } },
        { 'vehicleInterest.make': { $regex: s, $options: 'i' } },
        { 'vehicleInterest.model': { $regex: s, $options: 'i' } },
      ];
    }
  }

  const sortObj: any = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };
  const total = await Customer.countDocuments(query);
  const customers = await Customer.find(query)
    .select('-transactions -conversations') // keep list payload light
    .sort(sortObj)
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  return { customers, total, page, pages: Math.ceil(total / limit) };
}

/**
 * Full customer document (with embedded transactions + conversations).
 */
async function getCustomerById(id: string, orgId: string): Promise<ICustomer | null> {
  return Customer.findOne({ _id: id, organizationId: orgId }).lean() as any;
}

/**
 * Aggregate stats for the organisation dashboard.
 */
async function getOrgStats(orgId: string) {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const [total, active, fromLeads, manual, recentlyAdded] = await Promise.all([
    Customer.countDocuments({ organizationId: orgId }),
    Customer.countDocuments({ organizationId: orgId, isActive: true }),
    Customer.countDocuments({ organizationId: orgId, source: 'lead' }),
    Customer.countDocuments({ organizationId: orgId, source: 'manual' }),
    Customer.countDocuments({ organizationId: orgId, createdAt: { $gte: thirtyDaysAgo } }),
  ]);

  return { total, active, fromLeads, manual, recentlyAdded };
}

/**
 * Partial update respecting org boundary.
 */
async function updateCustomer(
  id: string,
  orgId: string,
  data: Partial<ICustomer> & { updatedBy?: string },
): Promise<ICustomer | null> {
  const allowed = ['firstName', 'lastName', 'email', 'phone', 'alternatePhone', 'dateOfBirth', 'address', 'notes', 'tags', 'preferredContactMethod', 'vehicleInterest', 'isActive'];
  const updated = await withCustomerIdentityLock(orgId, async renew => {
    const existing = await Customer.findOne({ _id: id, organizationId: orgId }).lean();
    if (!existing) return null;
    const update: any = Object.fromEntries(Object.entries(data).filter(([key]) => allowed.includes(key)));
    const contactChanged = ['email', 'phone', 'alternatePhone'].some(key => Object.prototype.hasOwnProperty.call(update, key));
    if (contactChanged) {
      const identity = validateContact({ ...existing, ...update });
      const candidates = (await findIdentityCustomers(orgId, { ...existing, ...update })).filter(customer => String(customer._id) !== id);
      if (candidates.length) throw new ApiError(409, 'Contact details match another customer; review required');
      const alternate = identity.normalizedAlternatePhone ? await findIdentityCustomers(orgId, { phone: (update.alternatePhone ?? existing.alternatePhone) }) : [];
      if (alternate.some(customer => String(customer._id) !== id)) throw new ApiError(409, 'Alternate phone matches another customer; review required');
      Object.assign(update, identity, { identityVersion: 1 });
      update.identityCreationKey = createHash('sha256').update(identity.normalizedEmail ? `email:${identity.normalizedEmail}` : `phone:${identity.normalizedPhone}`).digest('hex');
      if (Object.prototype.hasOwnProperty.call(update, 'email')) update.email = identity.normalizedEmail || undefined;
      await Lead.updateMany({ organizationId: orgId, customerId: id }, { $set: { 'customerLink.status': 'pending', 'customerLink.nextRetryAt': new Date() } }, { timestamps: false });
    }
    if (!contactChanged && Object.prototype.hasOwnProperty.call(update, 'isActive')) await Lead.updateMany({ organizationId: orgId, customerId: id }, { $set: { 'customerLink.status': 'pending', 'customerLink.nextRetryAt': new Date() } }, { timestamps: false });
    if (data.updatedBy) update.updatedBy = new mongoose.Types.ObjectId(data.updatedBy);
    await renew();
    const unset = Object.prototype.hasOwnProperty.call(update, 'email') && !update.email;
    if (unset) delete update.email;
    return Customer.findOneAndUpdate({ _id: id, organizationId: orgId }, {
      $set: update, ...(unset ? { $unset: { email: 1 } } : {}),
    }, { new: true, runValidators: true }).lean();
  });
  if (updated) {
    const leads = await Lead.find({ organizationId: orgId, customerId: id, 'customerLink.status': 'pending' }).select('_id').lean();
    for (const lead of leads) await syncLeadCustomerSafely(orgId, String(lead._id));
  }
  return updated as any;
}

/**
 * Hard delete a customer record.
 */
async function deleteCustomer(id: string, orgId: string): Promise<boolean> {
  return withCustomerIdentityLock(orgId, async renew => {
    if (await Lead.exists({ organizationId: orgId, customerId: id })) throw new ApiError(409, 'Customer has linked Leads and cannot be deleted');
    await renew();
    return Boolean(await Customer.findOneAndDelete({ _id: id, organizationId: orgId }));
  });
}

// ─── Embedded sub-document helpers ───────────────────────────────────────────

async function addTransaction(
  id: string,
  orgId: string,
  tx: Omit<ICustomerTransaction, '_id'>,
): Promise<ICustomer | null> {
  const customer = await Customer.findOne({ _id: id, organizationId: orgId });
  if (!customer) return null;

  customer.transactions.push(tx as any);
  customer.stats.totalTransactions = customer.transactions.length;
  await customer.save();
  return customer;
}

async function updateTransaction(
  customerId: string,
  orgId: string,
  txId: string,
  data: Partial<ICustomerTransaction>,
): Promise<ICustomer | null> {
  const customer = await Customer.findOne({ _id: customerId, organizationId: orgId });
  if (!customer) return null;

  const tx = customer.transactions.find((t) => t._id?.toString() === txId);
  if (!tx) return null;

  Object.assign(tx, data);
  await customer.save();
  return customer;
}

async function addConversation(
  id: string,
  orgId: string,
  conv: Omit<ICustomerConversation, '_id'>,
): Promise<ICustomer | null> {
  const customer = await Customer.findOne({ _id: id, organizationId: orgId });
  if (!customer) return null;

  customer.conversations.push(conv as any);
  customer.stats.totalConversations = customer.conversations.length;

  const now = new Date();
  if (!customer.stats.firstContactedAt) customer.stats.firstContactedAt = now;
  customer.stats.lastContactedAt = now;

  await customer.save();
  return customer;
}

// ─── Export ───────────────────────────────────────────────────────────────────

export default {
  checkDuplicate,
  createCustomer,
  upsertFromLead,
  getCustomers,
  getCustomerById,
  getOrgStats,
  updateCustomer,
  deleteCustomer,
  addTransaction,
  updateTransaction,
  addConversation,
};
