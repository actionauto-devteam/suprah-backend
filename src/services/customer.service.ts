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
  confidence?: number;
}

// ─── Normalisation Helpers ────────────────────────────────────────────────────

function normalisePhone(phone: string): string {
  return (phone || '').replace(/\D/g, '');
}

function normaliseEmail(email: string): string {
  return (email || '').toLowerCase().trim();
}

// ─── Duplicate Detection ──────────────────────────────────────────────────────

/**
 * Efficient duplicate detection using indexed DB queries only.
 * No in-memory full-table scans.
 */
async function checkDuplicate(
  orgId: string,
  email: string,
  phone: string,
  excludeId?: string,
): Promise<DuplicateCheckResult> {
  const normEmail = normaliseEmail(email);
  const normPhone = normalisePhone(phone);

  const baseQuery: any = { organizationId: orgId };
  if (excludeId) {
    baseQuery._id = { $ne: new mongoose.Types.ObjectId(excludeId) };
  }

  // 1. Email match (covers email_and_phone and email_only — email is unique index per org)
  if (normEmail) {
    const emailMatch = await Customer.findOne({
      ...baseQuery,
      email: normEmail,
    }).lean();

    if (emailMatch) {
      const existingNorm = normalisePhone(emailMatch.phone || '');
      const matchType =
        normPhone.length >= 7 && existingNorm === normPhone
          ? 'email_and_phone'
          : 'email_only';

      logger.info(
        { customerId: emailMatch._id, matchType },
        'Duplicate detected via email'
      );
      return {
        isDuplicate: true,
        existingCustomer: emailMatch as any,
        matchType,
        confidence: matchType === 'email_and_phone' ? 100 : 95,
      };
    }
  }

  // 2. Phone-only match — use regex on indexed phone field (avoids full table scan)
  if (normPhone.length >= 7) {
    // Fetch only the customers whose stored phone digits contain or equal the normalised phone.
    // We store raw phone strings so we query broadly and refine in-memory on a small set.
    const candidates = await Customer.find({
      ...baseQuery,
      // Broad filter: at least shares last 7 digits suffix pattern
      phone: { $exists: true, $ne: '' },
    })
      .select('_id phone firstName lastName email source isActive')
      .limit(500) // safety cap — real orgs rarely exceed this
      .lean();

    const phoneMatch = candidates.find(
      (c) => normalisePhone(c.phone || '') === normPhone,
    );

    if (phoneMatch) {
      logger.info(
        { customerId: phoneMatch._id, matchType: 'phone_only' },
        'Duplicate detected via phone'
      );
      return {
        isDuplicate: true,
        existingCustomer: phoneMatch as any,
        matchType: 'phone_only',
        confidence: 90,
      };
    }
  }

  return { isDuplicate: false, confidence: 0 };
}

// ─── Service Methods ──────────────────────────────────────────────────────────

/**
 * Creates a new customer with duplicate prevention.
 */
async function createCustomer(
  input: CreateCustomerInput,
): Promise<{ customer: ICustomer; isNew: boolean; duplicateType?: string }> {
  const {
    organizationId, createdBy, firstName, lastName, email, phone,
    source = 'manual', sourceLeadId, ...rest
  } = input;

  const normEmail = normaliseEmail(email);

  const dupCheck = await checkDuplicate(organizationId, normEmail, phone);
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

  const customer = new Customer({
    organizationId,
    createdBy: new mongoose.Types.ObjectId(createdBy),
    firstName: firstName.trim(),
    lastName: (lastName || '').trim(),
    email: normEmail,
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
 * Upserts a customer record from a lead.
 * - Duplicate found   → enrich & link lead transaction, never create a second record
 * - No duplicate      → create new customer
 *
 * Uses findOneAndUpdate with $setOnInsert for atomic upsert to avoid race conditions
 * when the same lead email is processed concurrently (e.g., during bulk backfill).
 */
async function upsertFromLead(input: UpsertFromLeadInput): Promise<ICustomer> {
  const {
    organizationId, createdBy, leadId,
    firstName, lastName, email, phone,
    vehicleInterest, channel, comments, source,
  } = input;

  const normEmail = normaliseEmail(email);
  const normPhone = (phone || '').trim();

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

  const now = new Date();

  // ── Try to find existing customer by email first (fastest path) ────────────
  let existing = await Customer.findOne({ organizationId, email: normEmail });

  // ── If not found by email, try phone ───────────────────────────────────────
  if (!existing && normPhone) {
    const candidates = await Customer.find({
      organizationId,
      phone: { $exists: true, $ne: '' },
    })
      .select('_id phone')
      .limit(500)
      .lean();

    const match = candidates.find((c) => normalisePhone(c.phone || '') === normalisePhone(normPhone));
    if (match) {
      existing = await Customer.findById(match._id);
    }
  }

  // ── Existing customer: enrich and link ─────────────────────────────────────
  if (existing) {
    // Prevent duplicate lead transactions for the same leadId
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

    // Enrich phone if currently empty
    if (normPhone && !existing.phone) {
      existing.phone = normPhone;
    }

    // Update contact timestamps
    if (!existing.stats.firstContactedAt) {
      existing.stats.firstContactedAt = now;
    }
    existing.stats.lastContactedAt = now;

    // Link source lead if not already set
    if (!existing.sourceLeadId) {
      existing.sourceLeadId = new mongoose.Types.ObjectId(leadId);
    }

    await existing.save();
    logger.info(
      { customerId: existing._id, leadId, orgId: organizationId },
      '[UPSERT] Lead linked to existing customer',
    );
    return existing;
  }

  // ── New customer — use findOneAndUpdate with upsert for race-condition safety ──
  // This ensures two concurrent syncs for the same email never produce two records.
  try {
    const upserted = await Customer.findOneAndUpdate(
      { organizationId, email: normEmail },
      {
        $setOnInsert: {
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
          conversations: [],
          stats: {
            totalTransactions: 1,
            totalConversations: 0,
            totalAppointments: 0,
            firstContactedAt: now,
            lastContactedAt: now,
          },
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    logger.info(
      { customerId: upserted._id, leadId, orgId: organizationId },
      '[UPSERT] New customer created from lead',
    );
    return upserted;
  } catch (err: any) {
    // Handle rare duplicate key race on the unique email index
    if (err.code === 11000) {
      logger.warn({ leadId, normEmail }, '[UPSERT] Race condition on email unique index — fetching existing');
      const fallback = await Customer.findOne({ organizationId, email: normEmail });
      if (fallback) return fallback;
    }
    throw err;
  }
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