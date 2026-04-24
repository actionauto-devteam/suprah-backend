import Customer, { ICustomer, ICustomerTransaction, ICustomerConversation } from '../models/Customer.model';
import mongoose from 'mongoose';
import logger from '../utils/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreateCustomerDTO {
  organizationId: string;
  createdBy: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  alternatePhone?: string;
  dateOfBirth?: Date;
  address?: ICustomer['address'];
  notes?: string;
  tags?: string[];
  preferredContactMethod?: ICustomer['preferredContactMethod'];
  source?: ICustomer['source'];
  sourceLeadId?: string;
  vehicleInterest?: ICustomer['vehicleInterest'];
}

export interface UpdateCustomerDTO {
  updatedBy: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  alternatePhone?: string;
  dateOfBirth?: Date;
  address?: ICustomer['address'];
  notes?: string;
  tags?: string[];
  preferredContactMethod?: ICustomer['preferredContactMethod'];
  vehicleInterest?: ICustomer['vehicleInterest'];
  isActive?: boolean;
}

export interface CustomerListOptions {
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

// ─── Service ──────────────────────────────────────────────────────────────────

class CustomerService {
  /**
   * Create a new customer, preventing duplicates by email within the same org.
   * Returns the existing customer if a duplicate is found.
   */
  async createCustomer(dto: CreateCustomerDTO): Promise<{ customer: ICustomer; isNew: boolean }> {
    const normalizedEmail = dto.email.toLowerCase().trim();

    // Deduplication check
    const existing = await Customer.findOne({
      organizationId: dto.organizationId,
      email: normalizedEmail,
    });

    if (existing) {
      logger.info(
        { customerId: existing._id, email: normalizedEmail },
        'Customer already exists — returning existing record'
      );
      return { customer: existing, isNew: false };
    }

    const now = new Date();

    const customer = await Customer.create({
      organizationId: dto.organizationId,
      createdBy: new mongoose.Types.ObjectId(dto.createdBy),
      firstName: dto.firstName.trim(),
      lastName: (dto.lastName || '').trim(),
      email: normalizedEmail,
      phone: dto.phone?.trim() || '',
      alternatePhone: dto.alternatePhone?.trim(),
      dateOfBirth: dto.dateOfBirth,
      address: dto.address,
      notes: dto.notes,
      tags: dto.tags || [],
      preferredContactMethod: dto.preferredContactMethod || 'email',
      source: dto.source || 'manual',
      sourceLeadId: dto.sourceLeadId
        ? new mongoose.Types.ObjectId(dto.sourceLeadId)
        : undefined,
      vehicleInterest: dto.vehicleInterest,
      stats: {
        totalTransactions: 0,
        totalConversations: 0,
        totalAppointments: 0,
        firstContactedAt: now,
        lastContactedAt: now,
      },
    });

    logger.info(
      { customerId: customer._id, orgId: dto.organizationId, source: dto.source },
      'Customer created'
    );

    return { customer, isNew: true };
  }

  /**
   * Upsert a customer from a Lead record. Called automatically when a lead is synced.
   */
  async upsertFromLead(params: {
    organizationId: string;
    createdBy: string;
    leadId: string;
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
    vehicleInterest?: ICustomer['vehicleInterest'];
    channel?: string;
    comments?: string;
    source?: string;
  }): Promise<ICustomer> {
    const normalizedEmail = params.email?.toLowerCase().trim();
    if (!normalizedEmail) {
      throw new Error('Email is required to upsert customer from lead');
    }

    const now = new Date();

    const customer = await Customer.findOneAndUpdate(
      { organizationId: params.organizationId, email: normalizedEmail },
      {
        $setOnInsert: {
          organizationId: params.organizationId,
          createdBy: new mongoose.Types.ObjectId(params.createdBy),
          source: 'lead',
          sourceLeadId: new mongoose.Types.ObjectId(params.leadId),
          'stats.firstContactedAt': now,
        },
        $set: {
          firstName: params.firstName?.trim() || 'Unknown',
          lastName: params.lastName?.trim() || '',
          phone: params.phone?.trim() || '',
          ...(params.vehicleInterest && { vehicleInterest: params.vehicleInterest }),
          'stats.lastContactedAt': now,
        },
        $inc: { 'stats.totalTransactions': 1 },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Append a transaction record for this lead ingestion (avoid duplicates)
    const alreadyLogged = customer.transactions.some(
      (t) => t.referenceId === params.leadId && t.type === 'lead'
    );

    if (!alreadyLogged) {
      customer.transactions.push({
        type: 'lead',
        status: 'active',
        title: `Lead from ${params.source || 'Unknown Source'}`,
        description: params.comments || '',
        referenceId: params.leadId,
        referenceModel: 'Lead',
        metadata: { channel: params.channel },
        occurredAt: now,
      } as ICustomerTransaction);

      if (params.comments) {
        customer.conversations.push({
          channel: (params.channel as any) || 'email',
          direction: 'inbound',
          senderType: 'customer',
          senderName: `${params.firstName} ${params.lastName}`.trim(),
          content: params.comments,
          subject: 'Lead Inquiry',
          referenceId: params.leadId,
          referenceModel: 'Lead',
          sentAt: now,
        } as ICustomerConversation);
        customer.stats.totalConversations += 1;
      }

      await customer.save();
    }

    logger.info(
      { customerId: customer._id, leadId: params.leadId },
      'Customer upserted from lead'
    );

    return customer;
  }

  /**
   * Get paginated list of customers for an organisation.
   */
  async getCustomers(
    orgId: string,
    options: CustomerListOptions = {}
  ): Promise<{ customers: ICustomer[]; total: number; page: number; pages: number }> {
    const {
      page = 1,
      limit = 25,
      search,
      source,
      isActive,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      startDate,
      endDate,
    } = options;

    const skip = (page - 1) * limit;
    const filter: any = { organizationId: orgId };

    if (search) {
      filter.$or = [
        { firstName: { $regex: search, $options: 'i' } },
        { lastName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
      ];
    }

    if (source) filter.source = source;
    if (isActive !== undefined) filter.isActive = isActive;
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = startDate;
      if (endDate) filter.createdAt.$lte = endDate;
    }

    const [customers, total] = await Promise.all([
      Customer.find(filter)
        .select(
          'firstName lastName email phone source isActive stats vehicleInterest tags notes createdAt updatedAt'
        )
        .sort({ [sortBy]: sortOrder === 'asc' ? 1 : -1 })
        .skip(skip)
        .limit(limit)
        .lean({ virtuals: true }) as unknown as ICustomer[],
      Customer.countDocuments(filter),
    ]);

    return {
      customers,
      total,
      page,
      pages: Math.ceil(total / limit),
    };
  }

  /**
   * Get a full customer profile including embedded transactions and conversations.
   */
  async getCustomerById(id: string, orgId: string): Promise<ICustomer | null> {
    return Customer.findOne({ _id: id, organizationId: orgId })
      .populate('createdBy', 'name email')
      .populate('updatedBy', 'name email')
      .lean({ virtuals: true }) as unknown as Promise<ICustomer | null>;
  }

  /**
   * Get a customer by email within an org.
   */
  async getCustomerByEmail(email: string, orgId: string): Promise<ICustomer | null> {
    return Customer.findOne({
      organizationId: orgId,
      email: email.toLowerCase().trim(),
    }).lean({ virtuals: true }) as unknown as Promise<ICustomer | null>;
  }

  /**
   * Update customer profile fields.
   */
  async updateCustomer(
    id: string,
    orgId: string,
    dto: UpdateCustomerDTO
  ): Promise<ICustomer | null> {
    const update: any = {
      updatedBy: new mongoose.Types.ObjectId(dto.updatedBy),
    };

    const fields = [
      'firstName', 'lastName', 'email', 'phone', 'alternatePhone',
      'dateOfBirth', 'address', 'notes', 'tags', 'preferredContactMethod',
      'vehicleInterest', 'isActive',
    ] as const;

    for (const f of fields) {
      if (dto[f] !== undefined) {
        update[f] = f === 'email' ? (dto[f] as string).toLowerCase().trim() : dto[f];
      }
    }

    const customer = await Customer.findOneAndUpdate(
      { _id: id, organizationId: orgId },
      { $set: update },
      { new: true, runValidators: true }
    ).lean({ virtuals: true }) as unknown as ICustomer | null;

    if (customer) {
      logger.info({ customerId: id, orgId }, 'Customer updated');
    }

    return customer;
  }

  /**
   * Soft-delete a customer by setting isActive = false.
   */
  async deactivateCustomer(id: string, orgId: string): Promise<ICustomer | null> {
    return Customer.findOneAndUpdate(
      { _id: id, organizationId: orgId },
      { $set: { isActive: false } },
      { new: true }
    ).lean({ virtuals: true }) as unknown as Promise<ICustomer | null>;
  }

  /**
   * Hard-delete a customer record.
   */
  async deleteCustomer(id: string, orgId: string): Promise<boolean> {
    const result = await Customer.findOneAndDelete({ _id: id, organizationId: orgId });
    if (result) {
      logger.warn({ customerId: id, orgId }, 'Customer permanently deleted');
      return true;
    }
    return false;
  }

  // ─── Transactions ───────────────────────────────────────────────────────────

  async addTransaction(
    customerId: string,
    orgId: string,
    transaction: Omit<ICustomerTransaction, '_id' | 'createdAt' | 'updatedAt'>
  ): Promise<ICustomer | null> {
    const customer = await Customer.findOneAndUpdate(
      { _id: customerId, organizationId: orgId },
      {
        $push: { transactions: { ...transaction, occurredAt: transaction.occurredAt || new Date() } },
        $inc: { 'stats.totalTransactions': 1 },
        $set: { 'stats.lastContactedAt': new Date() },
      },
      { new: true }
    );
    return customer;
  }

  async updateTransaction(
    customerId: string,
    orgId: string,
    transactionId: string,
    update: Partial<ICustomerTransaction>
  ): Promise<ICustomer | null> {
    const setFields: any = {};
    for (const [k, v] of Object.entries(update)) {
      setFields[`transactions.$.${k}`] = v;
    }

    return Customer.findOneAndUpdate(
      {
        _id: customerId,
        organizationId: orgId,
        'transactions._id': new mongoose.Types.ObjectId(transactionId),
      },
      { $set: setFields },
      { new: true }
    );
  }

  // ─── Conversations ──────────────────────────────────────────────────────────

  async addConversation(
    customerId: string,
    orgId: string,
    conversation: Omit<ICustomerConversation, '_id' | 'createdAt'>
  ): Promise<ICustomer | null> {
    return Customer.findOneAndUpdate(
      { _id: customerId, organizationId: orgId },
      {
        $push: { conversations: { ...conversation, sentAt: conversation.sentAt || new Date() } },
        $inc: { 'stats.totalConversations': 1 },
        $set: { 'stats.lastContactedAt': new Date() },
      },
      { new: true }
    );
  }

  // ─── Stats ──────────────────────────────────────────────────────────────────

  async getOrgStats(orgId: string): Promise<{
    total: number;
    active: number;
    fromLeads: number;
    manual: number;
    recentlyAdded: number;
  }> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [total, active, fromLeads, manual, recentlyAdded] = await Promise.all([
      Customer.countDocuments({ organizationId: orgId }),
      Customer.countDocuments({ organizationId: orgId, isActive: true }),
      Customer.countDocuments({ organizationId: orgId, source: 'lead' }),
      Customer.countDocuments({ organizationId: orgId, source: 'manual' }),
      Customer.countDocuments({ organizationId: orgId, createdAt: { $gte: thirtyDaysAgo } }),
    ]);

    return { total, active, fromLeads, manual, recentlyAdded };
  }
}

export default new CustomerService();