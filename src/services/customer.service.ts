import Customer, { ICustomer, ICustomerTransaction, ICustomerConversation } from '../models/Customer.model';
import Lead from '../models/lead.model';
import mongoose from 'mongoose';
import logger from '../utils/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

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
}

// ─── Duplicate Detection ──────────────────────────────────────────────────────

/**
 * Normalises a phone number to digits only for comparison.
 * e.g. "+1 (555) 000-0000" → "15550000000"
 */
function normalisePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

/**
 * Checks for duplicate customers within an organisation.
 *
 * Priority order:
 *   1. Same email AND same phone  → email_and_phone
 *   2. Same email only            → email_only
 *   3. Same phone only (≥7 digits)→ phone_only
 */
async function checkDuplicate(
  orgId: string,
  email: string,
  phone: string,
  excludeId?: string,
): Promise<DuplicateCheckResult> {
  const normalisedPhone = normalisePhone(phone || '');
  const normalisedEmail = (email || '').toLowerCase().trim();

  const baseQuery: any = { organizationId: orgId };
  if (excludeId) {
    baseQuery._id = { $ne: new mongoose.Types.ObjectId(excludeId) };
  }

  // 1. Exact match on both
  if (normalisedEmail && normalisedPhone.length >= 7) {
    const bothMatch = await Customer.findOne({
      ...baseQuery,
      email: normalisedEmail,
    }).lean();

    if (bothMatch) {
      const existingNorm = normalisePhone(bothMatch.phone || '');
      if (existingNorm === normalisedPhone) {
        return { isDuplicate: true, existingCustomer: bothMatch as any, matchType: 'email_and_phone' };
      }
    }
  }

  // 2. Email only
  if (normalisedEmail) {
    const emailMatch = await Customer.findOne({
      ...baseQuery,
      email: normalisedEmail,
    }).lean();

    if (emailMatch) {
      return { isDuplicate: true, existingCustomer: emailMatch as any, matchType: 'email_only' };
    }
  }

  // 3. Phone only (require at least 7 digits to avoid false positives)
  if (normalisedPhone.length >= 7) {
    const allInOrg = await Customer.find({
      ...baseQuery,
      phone: { $exists: true, $ne: '' },
    })
      .select('_id phone')
      .lean();

    const phoneMatch = allInOrg.find(
      (c) => normalisePhone(c.phone || '') === normalisedPhone,
    );

    if (phoneMatch) {
      const full = await Customer.findById(phoneMatch._id).lean();
      return { isDuplicate: true, existingCustomer: full as any, matchType: 'phone_only' };
    }
  }

  return { isDuplicate: false };
}

// ─── Service Methods ──────────────────────────────────────────────────────────

/**
 * Creates a new customer with duplicate prevention.
 * Returns { customer, isNew } — isNew=false if an existing record was returned.
 */
async function createCustomer(
  input: CreateCustomerInput,
): Promise<{ customer: ICustomer; isNew: boolean; duplicateType?: string }> {
  const {
    organizationId, createdBy, firstName, lastName, email, phone,
    source = 'manual', sourceLeadId, ...rest
  } = input;

  // ── Duplicate check ────────────────────────────────────────────────────────
  const dupCheck = await checkDuplicate(organizationId, email, phone);
  if (dupCheck.isDuplicate && dupCheck.existingCustomer) {
    logger.info(
      { customerId: dupCheck.existingCustomer._id, matchType: dupCheck.matchType },
      'Duplicate customer detected — returning existing record',
    );
    return {
      customer: dupCheck.existingCustomer as ICustomer,
      isNew: false,
      duplicateType: dupCheck.matchType,
    };
  }

  // ── Create ─────────────────────────────────────────────────────────────────
  const customer = new Customer({
    organizationId,
    createdBy: new mongoose.Types.ObjectId(createdBy),
    firstName: firstName.trim(),
    lastName: (lastName || '').trim(),
    email: email.toLowerCase().trim(),
    phone: phone.trim(),
    source,
    sourceLeadId: sourceLeadId ? new mongoose.Types.ObjectId(sourceLeadId) : undefined,
    isActive: true,
    stats: {
      totalTransactions: 0,
      totalConversations: 0,
      totalAppointments: 0,
    },
    ...rest,
  });

  await customer.save();
  logger.info({ customerId: customer._id, orgId: organizationId, source }, 'Customer created');
  return { customer, isNew: true };
}

/**
 * Upserts a customer record derived from a lead.
 *
 * Logic:
 *   - If duplicate found   → update vehicle interest & source tracking, add lead transaction
 *   - If no duplicate      → create new customer record
 */
async function upsertFromLead(input: UpsertFromLeadInput): Promise<ICustomer> {
  const {
    organizationId, createdBy, leadId,
    firstName, lastName, email, phone,
    vehicleInterest, channel, comments, source,
  } = input;

  const normEmail = (email || '').toLowerCase().trim();
  const normPhone = (phone || '').trim();

  // ── Check for existing customer ────────────────────────────────────────────
  const dupCheck = await checkDuplicate(organizationId, normEmail, normPhone);

  const vehicleTitle = vehicleInterest
    ? `${vehicleInterest.year || ''} ${vehicleInterest.make || ''} ${vehicleInterest.model || ''}`.trim()
    : 'Vehicle Inquiry';

  const transactionEntry = {
    type: 'lead' as const,
    status: 'pending' as const,
    title: vehicleTitle || 'Lead Inquiry',
    description: comments || `Lead from ${source || 'Unknown source'}`,
    referenceId: leadId,
    referenceModel: 'Lead',
    metadata: { channel, source },
    occurredAt: new Date(),
  };

  // ── Existing customer: enrich and link ─────────────────────────────────────
  if (dupCheck.isDuplicate && dupCheck.existingCustomer) {
    const existing = await Customer.findById(dupCheck.existingCustomer._id);
    if (!existing) throw new Error('Duplicate found but document missing');

    // Prevent duplicate lead transactions
    const alreadyLinked = existing.transactions.some(
      (tx) => tx.referenceId === leadId,
    );

    if (!alreadyLinked) {
      existing.transactions.push(transactionEntry as any);
      existing.stats.totalTransactions = existing.transactions.length;
    }

    // Enrich vehicle interest if currently empty
    if (vehicleInterest?.make && !existing.vehicleInterest?.make) {
      existing.vehicleInterest = {
        year: vehicleInterest.year,
        make: vehicleInterest.make,
        model: vehicleInterest.model,
      };
    }

    // Update first/last contact timestamps
    const now = new Date();
    if (!existing.stats.firstContactedAt) {
      existing.stats.firstContactedAt = now;
    }
    existing.stats.lastContactedAt = now;

    // Link lead if not already set
    if (!existing.sourceLeadId) {
      existing.sourceLeadId = new mongoose.Types.ObjectId(leadId);
    }

    await existing.save();
    logger.info(
      { customerId: existing._id, leadId, matchType: dupCheck.matchType },
      'Lead linked to existing customer (no duplicate created)',
    );
    return existing;
  }

  // ── New customer ───────────────────────────────────────────────────────────
  const now = new Date();
  const customer = new Customer({
    organizationId,
    createdBy: new mongoose.Types.ObjectId(createdBy),
    firstName: (firstName || 'Unknown').trim(),
    lastName: (lastName || '').trim(),
    email: normEmail,
    phone: normPhone,
    source: 'lead',
    sourceLeadId: new mongoose.Types.ObjectId(leadId),
    vehicleInterest: vehicleInterest
      ? {
          year: vehicleInterest.year,
          make: vehicleInterest.make,
          model: vehicleInterest.model,
        }
      : undefined,
    isActive: true,
    transactions: [transactionEntry],
    stats: {
      totalTransactions: 1,
      totalConversations: 0,
      totalAppointments: 0,
      firstContactedAt: now,
      lastContactedAt: now,
    },
  });

  await customer.save();
  logger.info(
    { customerId: customer._id, leadId, orgId: organizationId },
    'New customer auto-created from lead',
  );
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
    const isDigits = /^\d+$/.test(s.replace(/\D/g, ''));
    if (isDigits && s.replace(/\D/g, '').length >= 4) {
      // Phone search — scan in-memory for normalised match
      const phoneDigits = s.replace(/\D/g, '');
      const all = await Customer.find(query)
        .select('_id phone firstName lastName email source createdAt stats isActive vehicleInterest')
        .lean();
      const matched = all.filter((c) =>
        normalisePhone(c.phone || '').includes(phoneDigits),
      );
      const total = matched.length;
      const paginated = matched
        .sort((a: any, b: any) =>
          sortOrder === 'desc'
            ? new Date(b[sortBy] || b.createdAt).getTime() - new Date(a[sortBy] || a.createdAt).getTime()
            : new Date(a[sortBy] || a.createdAt).getTime() - new Date(b[sortBy] || b.createdAt).getTime(),
        )
        .slice((page - 1) * limit, page * limit);
      return { customers: paginated, total, page, pages: Math.ceil(total / limit) };
    }

    // Text search on indexed fields
    query.$or = [
      { firstName: { $regex: s, $options: 'i' } },
      { lastName: { $regex: s, $options: 'i' } },
      { email: { $regex: s, $options: 'i' } },
      { phone: { $regex: s, $options: 'i' } },
      { 'vehicleInterest.make': { $regex: s, $options: 'i' } },
      { 'vehicleInterest.model': { $regex: s, $options: 'i' } },
    ];
  }

  const sortObj: any = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };
  const total = await Customer.countDocuments(query);
  const customers = await Customer.find(query)
    .select('-transactions -conversations') // keep list light
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
 * Aggregate stats for the organisation dashboard card.
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
 * Update a customer (partial update, respects org boundary).
 */
async function updateCustomer(
  id: string,
  orgId: string,
  data: Partial<ICustomer> & { updatedBy?: string },
): Promise<ICustomer | null> {
  const { updatedBy, ...rest } = data;
  const update: any = { ...rest };
  if (updatedBy) update.updatedBy = new mongoose.Types.ObjectId(updatedBy);

  return Customer.findOneAndUpdate(
    { _id: id, organizationId: orgId },
    { $set: update },
    { new: true },
  ).lean() as any;
}

/**
 * Hard delete a customer record.
 */
async function deleteCustomer(id: string, orgId: string): Promise<boolean> {
  const result = await Customer.findOneAndDelete({ _id: id, organizationId: orgId });
  return !!result;
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

  const tx = customer.transactions.find(
    (t) => t._id?.toString() === txId,
  );
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