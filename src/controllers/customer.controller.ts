import { Request, Response, NextFunction } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import { IUser } from '../models/User.model';
import customerService from '../services/customer.service';
import activityService from '../services/activity.service';
import logger from '../utils/logger';
import Lead from '../models/lead.model';
import User from '../models/User.model';


export const createCustomer = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const orgId = req.orgId as string;

  const {
    firstName, lastName, email, phone, alternatePhone,
    dateOfBirth, address, notes, tags, preferredContactMethod,
    vehicleInterest,
  } = req.body;

  if (!firstName?.trim() || !email?.trim() || !phone?.trim()) {
    throw new ApiError(400, 'firstName, email, and phone are required');
  }

  const { customer, isNew, duplicateType } = await customerService.createCustomer({
    organizationId: orgId,
    createdBy: userId,
    firstName,
    lastName: lastName || '',
    email,
    phone,
    alternatePhone,
    dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
    address,
    notes,
    tags,
    preferredContactMethod,
    vehicleInterest,
    source: 'manual',
  });

  if (!isNew) {
    return res.status(200).json(
      new ApiResponse(200, { customer, isDuplicate: true, duplicateType },
        `Duplicate detected (${duplicateType?.replace('_', ' ')}). Returning existing record.`)
    );
  }

  await activityService.createActivity({
    userId,
    organizationId: orgId,
    type: 'other',
    title: 'Customer Record Created',
    description: `Manual customer record created for ${firstName} ${lastName || ''}`,
    metadata: { customerId: customer._id?.toString() },
  });

  logger.info({ customerId: customer._id, orgId, userId }, 'Customer created manually');

  res.status(201).json(new ApiResponse(201, { customer, isDuplicate: false }, 'Customer created successfully'));
});

/**
 * GET /api/customers
 * List customers for the authenticated organisation.
 */
export const getCustomers = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const {
    page, limit, search, source, isActive, sortBy, sortOrder, startDate, endDate,
  } = req.query;

  const result = await customerService.getCustomers(orgId, {
    page: page ? parseInt(page as string) : 1,
    limit: limit ? parseInt(limit as string) : 25,
    search: search as string,
    source: source as string,
    isActive: isActive !== undefined ? isActive === 'true' : undefined,
    sortBy: sortBy as string,
    sortOrder: sortOrder as 'asc' | 'desc',
    startDate: startDate ? new Date(startDate as string) : undefined,
    endDate: endDate ? new Date(endDate as string) : undefined,
  });

  res.json(new ApiResponse(200, result, 'Customers fetched successfully'));
});

/**
 * GET /api/customers/stats
 * Aggregate stats for the org's customer base.
 */
export const getCustomerStats = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const stats = await customerService.getOrgStats(orgId);
  res.json(new ApiResponse(200, stats, 'Customer stats fetched'));
});

/**
 * GET /api/customers/check-duplicate
 * Check if a customer with the given email/phone already exists.
 */
export const checkDuplicate = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { email, phone, excludeId } = req.query;

  if (!email && !phone) {
    throw new ApiError(400, 'At least email or phone is required');
  }

  const result = await customerService.checkDuplicate(
    orgId,
    (email as string) || '',
    (phone as string) || '',
    excludeId as string | undefined,
  );

  res.json(new ApiResponse(200, result, result.isDuplicate ? 'Duplicate found' : 'No duplicate'));
});

/**
 * GET /api/customers/:id
 * Get a full customer profile.
 */
export const getCustomerById = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { id } = req.params;

  const customer = await customerService.getCustomerById(id, orgId);
  if (!customer) throw new ApiError(404, 'Customer not found');

  res.json(new ApiResponse(200, customer, 'Customer fetched successfully'));
});

/**
 * PATCH /api/customers/:id
 * Update a customer record.
 */
export const updateCustomer = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const orgId = req.orgId as string;
  const { id } = req.params;

  const customer = await customerService.updateCustomer(id, orgId, {
    ...req.body,
    updatedBy: userId,
  });

  if (!customer) throw new ApiError(404, 'Customer not found');

  await activityService.createActivity({
    userId,
    organizationId: orgId,
    type: 'other',
    title: 'Customer Record Updated',
    description: `Customer ${customer.firstName} ${customer.lastName} record updated`,
    metadata: { customerId: id },
  });

  res.json(new ApiResponse(200, customer, 'Customer updated successfully'));
});

/**
 * DELETE /api/customers/:id
 * Permanently delete a customer record.
 */
export const deleteCustomer = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const orgId = req.orgId as string;
  const { id } = req.params;

  const deleted = await customerService.deleteCustomer(id, orgId);
  if (!deleted) throw new ApiError(404, 'Customer not found');

  await activityService.createActivity({
    userId,
    organizationId: orgId,
    type: 'other',
    title: 'Customer Record Deleted',
    description: `Customer record ${id} permanently deleted`,
    metadata: { customerId: id },
  });

  logger.warn({ customerId: id, orgId, userId }, 'Customer deleted');

  res.json(new ApiResponse(200, null, 'Customer deleted successfully'));
});

// ─── Transactions ─────────────────────────────────────────────────────────────

export const addTransaction = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { id } = req.params;
  const { type, status, title, description, amount, currency, referenceId, referenceModel, metadata } = req.body;

  if (!type || !title) throw new ApiError(400, 'type and title are required');

  const customer = await customerService.addTransaction(id, orgId, {
    type, status: status || 'pending', title, description, amount, currency,
    referenceId, referenceModel, metadata,
    occurredAt: req.body.occurredAt ? new Date(req.body.occurredAt) : new Date(),
  });

  if (!customer) throw new ApiError(404, 'Customer not found');
  res.status(201).json(new ApiResponse(201, customer, 'Transaction added'));
});

export const updateTransaction = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { id, txId } = req.params;
  const customer = await customerService.updateTransaction(id, orgId, txId, req.body);
  if (!customer) throw new ApiError(404, 'Customer or transaction not found');
  res.json(new ApiResponse(200, customer, 'Transaction updated'));
});

// ─── Conversations ────────────────────────────────────────────────────────────

export const addConversation = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const userId = (req.user as IUser)._id.toString();
  const { id } = req.params;
  const { channel, direction, senderType, senderName, content, subject, referenceId, referenceModel, metadata } = req.body;

  if (!channel || !content) throw new ApiError(400, 'channel and content are required');

  const customer = await customerService.addConversation(id, orgId, {
    channel, direction: direction || 'outbound', senderType: senderType || 'agent',
    senderName, content, subject, referenceId, referenceModel, metadata,
    sentAt: req.body.sentAt ? new Date(req.body.sentAt) : new Date(),
  });

  if (!customer) throw new ApiError(404, 'Customer not found');

  await activityService.createActivity({
    userId, organizationId: orgId, type: 'other',
    title: 'Conversation Logged',
    description: `${direction || 'outbound'} ${channel} conversation logged for customer`,
    metadata: { customerId: id },
  });

  res.status(201).json(new ApiResponse(201, customer, 'Conversation logged'));
});

// ─── Lead → Customer Sync (Auto-triggered from lead controller) ──────────────

export const syncFromLead = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const userId = (req.user as IUser)._id.toString();
  const { leadId, firstName, lastName, email, phone, vehicleInterest, channel, comments, source } = req.body;

  if (!leadId || !email) throw new ApiError(400, 'leadId and email are required');

  const customer = await customerService.upsertFromLead({
    organizationId: orgId, createdBy: userId, leadId,
    firstName: firstName || 'Unknown', lastName: lastName || '',
    email, phone: phone || '', vehicleInterest, channel, comments, source,
  });

  res.json(new ApiResponse(200, customer, 'Customer synced from lead'));
});

// ─── Sync All Leads → Customers (incremental, safe to call repeatedly) ───────

/**
 * POST /api/customers/sync-from-leads
 *
 * Syncs ALL leads in the org that don't yet have a corresponding customer.
 * Uses sourceLeadId to detect already-synced leads — skips them efficiently.
 * Safe to call multiple times (idempotent via upsert logic in service).
 *
 * Returns { total, synced, skipped, failed, alreadySynced }
 */
export const syncFromLeads = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const userId = (req.user as IUser)._id.toString();

  logger.info({ orgId, userId }, '[SYNC] Starting incremental lead→customer sync');

  // Find the best available user for createdBy
  let systemUserId = userId;
  if (!systemUserId) {
    const fallback =
      await User.findOne({ role: 'super_admin' }).lean() ||
      await User.findOne({ role: 'admin' }).lean() ||
      await User.findOne({}).lean();
    if (!fallback) throw new ApiError(500, 'No users found in system');
    systemUserId = (fallback as any)._id.toString();
  }

  // Get all leads for this org that have an email (required for customer creation)
  const total = await Lead.countDocuments({ organizationId: orgId, email: { $exists: true, $ne: '' } });

  if (total === 0) {
    return res.json(new ApiResponse(200, {
      total: 0, synced: 0, skipped: 0, failed: 0, alreadySynced: 0,
    }, 'No leads with email found to sync'));
  }

  logger.info({ orgId, total }, '[SYNC] Total leads to process');

  const BATCH_SIZE = 50;
  let synced = 0;
  let skipped = 0;
  let failed = 0;
  let alreadySynced = 0;
  let skip = 0;

  // Get all sourceLeadIds already in customers to skip efficiently
  const existingSourceLeadIds = new Set(
    (await Lead.find({ organizationId: orgId })
      .select('_id')
      .lean()
      // We cross-reference against customers that already have a sourceLeadId
      .then(async () => {
        const { default: Customer } = await import('../models/Customer.model');
        return Customer.find({ organizationId: orgId, sourceLeadId: { $exists: true } })
          .select('sourceLeadId')
          .lean();
      })
    ).map((c: any) => c.sourceLeadId?.toString()).filter(Boolean)
  );

  while (skip < total) {
    const batch = await Lead.find({
      organizationId: orgId,
      email: { $exists: true, $ne: '' },
    })
      .select('_id firstName lastName email phone vehicle comments source channel createdAt')
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(BATCH_SIZE)
      .lean();

    if (batch.length === 0) break;

    for (const lead of batch) {
      try {
        const leadIdStr = (lead as any)._id.toString();

        // Fast-skip leads that are already linked to a customer via sourceLeadId
        if (existingSourceLeadIds.has(leadIdStr)) {
          alreadySynced++;
          continue;
        }

        if (!lead.email || !lead.email.trim()) {
          skipped++;
          continue;
        }

        await customerService.upsertFromLead({
          organizationId: orgId,
          createdBy: systemUserId,
          leadId: leadIdStr,
          firstName: (lead as any).firstName || 'Unknown',
          lastName: (lead as any).lastName || '',
          email: lead.email,
          phone: (lead as any).phone || '',
          vehicleInterest: (lead as any).vehicle
            ? {
                year: (lead as any).vehicle.year,
                make: (lead as any).vehicle.make,
                model: (lead as any).vehicle.model,
              }
            : undefined,
          channel: (lead as any).channel,
          comments: (lead as any).comments || '',
          source: (lead as any).source || 'lead',
        });

        synced++;
        existingSourceLeadIds.add(leadIdStr); // prevent re-processing in same run
      } catch (err) {
        logger.error({ err, leadId: (lead as any)._id }, '[SYNC] Failed to sync lead');
        failed++;
      }
    }

    skip += BATCH_SIZE;
    logger.info({ orgId, skip, total, synced, failed, alreadySynced }, '[SYNC] Batch progress');
  }

  await activityService.createActivity({
    userId,
    organizationId: orgId,
    type: 'other',
    title: 'Lead Sync Completed',
    description: `Synced ${synced} new customers from ${total} leads (${alreadySynced} already synced, ${skipped} skipped, ${failed} failed)`,
    metadata: { total, synced, skipped, failed, alreadySynced },
  });

  logger.info({ orgId, total, synced, skipped, failed, alreadySynced }, '[SYNC] Sync complete');

  res.json(new ApiResponse(200, {
    total,
    synced,
    skipped,
    failed,
    alreadySynced,
  }, `Sync complete. ${synced} new customers synced, ${alreadySynced} already existed.`));
});

// ─── Backfill: Sync ALL existing leads → Customers (alias for sync-from-leads) ──

/**
 * POST /api/customers/backfill-from-leads
 * Kept for backwards compatibility — delegates to syncFromLeads logic.
 */
export const backfillFromLeads = asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
  // Delegate to the unified sync handler
  return syncFromLeads(req, res, next);
});

export default {
  createCustomer,
  getCustomers,
  getCustomerStats,
  checkDuplicate,
  getCustomerById,
  updateCustomer,
  deleteCustomer,
  addTransaction,
  updateTransaction,
  addConversation,
  syncFromLead,
  syncFromLeads,
  backfillFromLeads,
};