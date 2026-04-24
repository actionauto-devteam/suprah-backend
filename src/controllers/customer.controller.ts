import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import { ApiResponse } from '../utils/ApiResponse';
import { ApiError } from '../utils/ApiError';
import { IUser } from '../models/User.model';
import customerService from '../services/customer.service';
import activityService from '../services/activity.service';
import logger from '../utils/logger';

// ─── Customers CRUD ───────────────────────────────────────────────────────────

/**
 * POST /api/customers
 * Create a new customer record manually.
 */
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

  const { customer, isNew } = await customerService.createCustomer({
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
      new ApiResponse(200, customer, 'Customer with this email already exists — returned existing record')
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

  res.status(201).json(new ApiResponse(201, customer, 'Customer created successfully'));
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

/**
 * POST /api/customers/:id/transactions
 * Add a transaction to a customer record.
 */
export const addTransaction = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { id } = req.params;

  const { type, status, title, description, amount, currency, referenceId, referenceModel, metadata } = req.body;

  if (!type || !title) throw new ApiError(400, 'type and title are required');

  const customer = await customerService.addTransaction(id, orgId, {
    type,
    status: status || 'pending',
    title,
    description,
    amount,
    currency,
    referenceId,
    referenceModel,
    metadata,
    occurredAt: req.body.occurredAt ? new Date(req.body.occurredAt) : new Date(),
  });

  if (!customer) throw new ApiError(404, 'Customer not found');

  res.status(201).json(new ApiResponse(201, customer, 'Transaction added'));
});

/**
 * PATCH /api/customers/:id/transactions/:txId
 * Update a specific transaction.
 */
export const updateTransaction = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { id, txId } = req.params;

  const customer = await customerService.updateTransaction(id, orgId, txId, req.body);
  if (!customer) throw new ApiError(404, 'Customer or transaction not found');

  res.json(new ApiResponse(200, customer, 'Transaction updated'));
});

// ─── Conversations ────────────────────────────────────────────────────────────

/**
 * POST /api/customers/:id/conversations
 * Log a conversation entry for a customer.
 */
export const addConversation = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const userId = (req.user as IUser)._id.toString();
  const { id } = req.params;

  const { channel, direction, senderType, senderName, content, subject, referenceId, referenceModel, metadata } = req.body;

  if (!channel || !content) throw new ApiError(400, 'channel and content are required');

  const customer = await customerService.addConversation(id, orgId, {
    channel,
    direction: direction || 'outbound',
    senderType: senderType || 'agent',
    senderName,
    content,
    subject,
    referenceId,
    referenceModel,
    metadata,
    sentAt: req.body.sentAt ? new Date(req.body.sentAt) : new Date(),
  });

  if (!customer) throw new ApiError(404, 'Customer not found');

  await activityService.createActivity({
    userId,
    organizationId: orgId,
    type: 'other',
    title: 'Conversation Logged',
    description: `${direction || 'outbound'} ${channel} conversation logged for customer`,
    metadata: { customerId: id },
  });

  res.status(201).json(new ApiResponse(201, customer, 'Conversation logged'));
});

// ─── Lead → Customer Sync (internal, also exposed as endpoint) ────────────────

/**
 * POST /api/customers/sync-from-lead
 * Internal endpoint — upserts a customer record from a lead payload.
 * Called automatically by the lead sync pipeline; can also be triggered manually.
 */
export const syncFromLead = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const userId = (req.user as IUser)._id.toString();

  const {
    leadId, firstName, lastName, email, phone,
    vehicleInterest, channel, comments, source,
  } = req.body;

  if (!leadId || !email) throw new ApiError(400, 'leadId and email are required');

  const customer = await customerService.upsertFromLead({
    organizationId: orgId,
    createdBy: userId,
    leadId,
    firstName: firstName || 'Unknown',
    lastName: lastName || '',
    email,
    phone: phone || '',
    vehicleInterest,
    channel,
    comments,
    source,
  });

  res.json(new ApiResponse(200, customer, 'Customer synced from lead'));
});

export default {
  createCustomer,
  getCustomers,
  getCustomerStats,
  getCustomerById,
  updateCustomer,
  deleteCustomer,
  addTransaction,
  updateTransaction,
  addConversation,
  syncFromLead,
};