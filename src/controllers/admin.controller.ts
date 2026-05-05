import { Request, Response } from 'express';
import os from 'os';
import pidusage from 'pidusage';
import fs from 'fs';
import path from 'path';
import Organization from '../models/Organization.model';
import User from '../models/User.model';
import AuditLog from '../models/AuditLog.model';
import SyncLog from '../models/SyncLog.model';
import { ApiError } from '../utils/ApiError';
import { ApiResponse } from '../utils/ApiResponse';
import { asyncHandler } from '../utils/asyncHandler';
import activityService from '../services/activity.service';
import logger from '../utils/logger';
import { SystemLog } from '../models/SystemLog.model';

import { metrics, getPercentile } from '../utils/metrics';

/**
 * Get all organizations with pagination and search
 */
export const getAllOrganizations = asyncHandler(
  async (req: Request, res: Response) => {
    const { page = 1, limit = 10, search } = req.query;
    const pageNum = Number(page);
    const limitNum = Number(limit);
    const skip = (pageNum - 1) * limitNum;

    const filter: any = {};
    if (search) {
      filter.name = { $regex: search, $options: "i" };
    }

    const [orgs, total] = await Promise.all([
      Organization.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate("ownerId", "name email"),
      Organization.countDocuments(filter),
    ]);

    const totalPages = Math.ceil(total / limitNum);

    res.json(
      new ApiResponse(
        200,
        {
          organizations: orgs,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total,
            totalPages,
          },
        },
        "Organizations fetched successfully",
      ),
    );
  },
);

/**
 * Get all users with pagination and search
 */
export const getAllUsers = asyncHandler(async (req: Request, res: Response) => {
  const { page = 1, limit = 10, search } = req.query;
  const pageNum = Number(page);
  const limitNum = Number(limit);
  const skip = (pageNum - 1) * limitNum;

  const filter: any = {};
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { email: { $regex: search, $options: "i" } },
    ];
  }

  const [users, total] = await Promise.all([
    User.find(filter)
      .sort({ createdAt: -1 })
      .select("-password")
      .skip(skip)
      .limit(limitNum)
      .populate("organizationId", "name"),
    User.countDocuments(filter),
  ]);

  const totalPages = Math.ceil(total / limitNum);

  res.json(
    new ApiResponse(
      200,
      {
        users,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages,
        },
      },
      "Users fetched successfully",
    ),
  );
});

/**
 * Get system-wide statistics (DB counts)
 */
export const getSystemStats = asyncHandler(async (req: Request, res: Response) => {
  const [orgCount, userCount] = await Promise.all([
    Organization.countDocuments(),
    User.countDocuments(),
  ]);

  res.json(
    new ApiResponse(
      200,
      {
        organizations: orgCount,
        users: userCount,
      },
      "System stats fetched successfully",
    ),
  );
});

// --- REAL-TIME MONITORING ---

/**
 * Get real-time process performance stats (CPU, RAM)
 */
export const getProcessStats = asyncHandler(async (req: Request, res: Response) => {
  const stats = await pidusage(process.pid);

  const formattedStats = {
    performance: {
      cpu: Math.round(stats.cpu * 100) / 100,
      memory: Math.round((stats.memory / 1024 / 1024) * 100) / 100, // MB
      memoryTotal: Math.round((os.totalmem() / 1024 / 1024) * 100) / 100, // MB
      uptime: Math.round(stats.elapsed / 1000), // seconds
    },
    goldenSignals: {
      traffic: {
        requestsTotal: metrics.requestsTotal,
        requestsPerMinute: Math.round((metrics.requestsTotal / (process.uptime() / 60)) * 100) / 100
      },
      errors: {
        total: metrics.errorsTotal,
        rate: metrics.requestsTotal > 0
          ? Math.round((metrics.errorsTotal / metrics.requestsTotal) * 10000) / 100
          : 0,
        count4xx: metrics.errors4xx,
        count5xx: metrics.errors5xx
      },
      latency: {
        p50: getPercentile(metrics.latencies, 50),
        p95: getPercentile(metrics.latencies, 95),
        p99: getPercentile(metrics.latencies, 99)
      }
    },
    timestamp: new Date().toISOString()
  };

  return res.status(200).json(
    new ApiResponse(200, formattedStats, "Process stats retrieved successfully")
  );
});

/**
 * Retrieves the last X lines of the application log file safely using a memory-efficient buffer.
 */
/**
 * Retrieves system logs from the indexed database with advanced filtering.
 */
export const getSystemLogs = asyncHandler(async (req: Request, res: Response) => {
  const {
    level,
    search,
    from,
    to,
    page = 1,
    limit = 50,
    requestId,
    userId,
    organizationId
  } = req.query;

  const pageNum = Number(page);
  const limitNum = Number(limit);
  const skip = (pageNum - 1) * limitNum;

  const filter: any = {};

  // Level filter (supports csv: info,error,warn)
  if (level) {
    const levels = (level as string).split(',').map(l => l.trim().toUpperCase());
    filter.level = levels.length > 1 ? { $in: levels } : levels[0];
  }

  // Time range filter
  if (from || to) {
    filter.timestamp = {};
    if (from) filter.timestamp.$gte = new Date(from as string);
    if (to) filter.timestamp.$lte = new Date(to as string);
  }

  // Search filter (High-performance Unified Text Search)
  if (search) {
    const searchTerm = search as string;

    // If it looks like a specific ID (Request ID, User ID), we use prioritized match
    if (searchTerm.includes('_') || searchTerm.length > 20) {
      filter.$or = [
        { 'req.id': searchTerm },
        { 'req.userId': searchTerm },
        { message: { $regex: searchTerm, $options: 'i' } }
      ];
    } else {
      // Use the Compound Text Index for general keyword searches
      filter.$text = { $search: searchTerm };
    }
  }

  // Context filters
  if (requestId) filter['req.id'] = requestId;
  if (userId) filter['req.userId'] = userId;
  if (organizationId) filter['req.organizationId'] = organizationId;

  const [logs, total] = await Promise.all([
    SystemLog.find(filter)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limitNum),
    SystemLog.countDocuments(filter)
  ]);

  const totalPages = Math.ceil(total / limitNum);

  return res.status(200).json(
    new ApiResponse(200, {
      logs,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages
      }
    }, "Logs retrieved successfully")
  );
});

/**
 * Get log frequency statistics for the visual histogram.
 */
export const getLogStats = asyncHandler(async (req: Request, res: Response) => {
  const { from, to, interval = 'hour' } = req.query;

  const startTime = from ? new Date(from as string) : new Date(Date.now() - 24 * 60 * 60 * 1000);
  const endTime = to ? new Date(to as string) : new Date();

  // Create a time-series aggregation for logs
  const stats = await SystemLog.aggregate([
    {
      $match: {
        timestamp: { $gte: startTime, $lte: endTime }
      }
    },
    {
      $group: {
        _id: {
          $dateToString: {
            format: interval === 'day' ? "%Y-%m-%d" : "%Y-%m-%dT%H:00:00Z",
            date: "$timestamp"
          }
        },
        count: { $sum: 1 },
        errors: {
          $sum: { $cond: [{ $in: ["$level", ["ERROR", "FATAL"]] }, 1, 0] }
        },
        warnings: {
          $sum: { $cond: [{ $eq: ["$level", "WARN"] }, 1, 0] }
        }
      }
    },
    { $sort: { "_id": 1 } }
  ]);

  return res.status(200).json(
    new ApiResponse(200, stats, "Log stats retrieved successfully")
  );
});

/**
 * Clear application logs
 */
export const clearSystemLogs = asyncHandler(async (req: Request, res: Response) => {
  const { confirm } = req.body;

  if (confirm !== true) {
    throw new ApiError(400, "Deletion aborted. You must provide {'confirm': true} in the request body to clear logs.");
  }

  // --- DATABASE SECURITY GATEKEEPER ---
  const MONGODB_URI = process.env.MONGODB_URI || '';
  const isAtlas = MONGODB_URI.includes('mongodb+srv') || MONGODB_URI.includes('mongodb.net');

  if (isAtlas && process.env.ALLOW_WIPE !== 'true') {
    logger.error('Attempted to clear system logs on a Cloud Atlas instance without ALLOW_WIPE=true');
    throw new ApiError(403, "Database Protection: Bulk log deletion is blocked on live clusters. Set ALLOW_WIPE=true to override.");
  }
  // ------------------------------------

  const logPath = path.join(process.cwd(), 'logs', 'app.log');

  if (fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, '');
  }

  // Also purge the database indexed logs
  await SystemLog.deleteMany({});

  // Log activity
  const adminUser = req.user as any;
  if (adminUser) {
    await activityService.logAdminAction(
      adminUser._id.toString(),
      undefined,
      'logs_cleared',
      adminUser._id.toString(),
      'Admin cleared system-wide application logs'
    );

    logger.warn({ adminId: adminUser._id }, 'System application logs cleared by administrator');
  }

  return res.status(200).json(
    new ApiResponse(200, null, "Logs cleared successfully")
  );
});

// --- USER MANAGEMENT ---

export const suspendUser = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const user = await User.findByIdAndUpdate(
    id,
    { isActive: false },
    { new: true },
  );
  if (!user) throw new ApiError(404, "User not found");

  // Log activity
  const adminUser = req.user as any;
  await activityService.logAdminAction(
    adminUser._id.toString(),
    undefined,
    'user_suspended',
    user._id.toString(),
    `Suspended user: ${user.email}`
  );

  logger.warn({ adminId: adminUser._id, targetUserId: user._id, targetEmail: user.email }, 'User suspended by administrator');

  res.json(new ApiResponse(200, user, "User suspended successfully"));
});

export const activateUser = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const user = await User.findByIdAndUpdate(
    id,
    { isActive: true },
    { new: true },
  );
  if (!user) throw new ApiError(404, "User not found");

  // Log activity
  const adminUser = req.user as any;
  await activityService.logAdminAction(
    adminUser._id.toString(),
    undefined,
    'user_activated',
    user._id.toString(),
    `Activated user: ${user.email}`
  );

  logger.info({ adminId: adminUser._id, targetUserId: user._id, targetEmail: user.email }, 'User activated by administrator');

  res.json(new ApiResponse(200, user, "User activated successfully"));
});

export const updateUserRole = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { organizationRole } = req.body;

  if (!organizationRole)
    throw new ApiError(400, "organizationRole is required");

  const user = await User.findById(id);
  if (!user) throw new ApiError(404, "User not found");

  (user as any).organizationRole = organizationRole;
  await user.save();

  logger.info({ adminId: (req.user as any)._id, targetUserId: user._id, newRole: organizationRole }, 'User organization role updated');

  res.json(new ApiResponse(200, user, "User role updated successfully"));
});

export const deleteUser = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const adminUser = req.user as any;

  if (adminUser._id.toString() === id) {
    throw new ApiError(400, "You cannot delete your own account");
  }

  const user = await User.findById(id);
  if (!user) throw new ApiError(404, "User not found");

  if (user.role === "super_admin") {
    throw new ApiError(403, "Cannot delete a super admin account");
  }

  await User.findByIdAndDelete(id);

  res.json(new ApiResponse(200, null, "User deleted successfully"));
});

// --- ORGANIZATION MANAGEMENT ---

export const suspendOrganization = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const org = await Organization.findByIdAndUpdate(
      id,
      { status: "suspended" },
      { new: true },
    );
    if (!org) throw new ApiError(404, "Organization not found");

    // Log activity
    const adminUser = req.user as any;
    await activityService.logAdminAction(
      adminUser._id.toString(),
      undefined,
      'org_suspended',
      org.ownerId?.toString() || id,
      `Suspended organization: ${org.name}`
    );

    logger.warn({ adminId: adminUser._id, orgId: id, orgName: org.name }, 'Organization suspended by administrator');

    res.json(new ApiResponse(200, org, "Organization suspended successfully"));
  },
);

export const activateOrganization = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const org = await Organization.findByIdAndUpdate(
      id,
      { status: "active" },
      { new: true },
    );
    if (!org) throw new ApiError(404, "Organization not found");
    res.json(new ApiResponse(200, org, "Organization activated successfully"));
  },
);

export const updateOrganizationSubscription = asyncHandler(
  async (req: Request, res: Response) => {
    const { id } = req.params;
    const { plan, status } = req.body;

    const org = await Organization.findById(id);
    if (!org) throw new ApiError(404, "Organization not found");

    const owner = await User.findById(org.ownerId);
    if (!owner) throw new ApiError(404, "Organization owner not found");

    if (plan) owner.subscription!.plan = plan;
    if (status) owner.subscription!.status = status;

    await owner.save();

    // Log activity
    const adminUser = req.user as any;
    await activityService.logAdminAction(
      adminUser._id.toString(),
      undefined,
      'subscription_changed',
      owner._id.toString(),
      `Changed subscription for ${org.name} to plan: ${plan || 'N/A'}, status: ${status || 'N/A'}`
    );

    res.json(
      new ApiResponse(
        200,
        owner.subscription,
        "Subscription updated successfully",
      ),
    );
  },
);

// --- FINANCIALS ---

export const getFinancialStats = asyncHandler(async (req: Request, res: Response) => {
  const users = await User.find({ "subscription.status": "active" }).select(
    "subscription.plan",
  );

  let mrr = 0;
  const planPrices: Record<string, number> = {
    free: 0,
    starter: 29,
    professional: 99,
    enterprise: 299,
  };

  users.forEach((u) => {
    const plan = u.subscription?.plan || "free";
    mrr += planPrices[plan] || 0;
  });

  res.json(
    new ApiResponse(
      200,
      {
        mrr,
        totalRevenue: mrr * 12,
        activeSubscriptions: users.length,
      },
      "Financial stats fetched successfully",
    ),
  );
});

// --- AUDIT LOGS & SYNC LOGS ---

export const getAuditLogs = asyncHandler(async (req: Request, res: Response) => {
  const {
    page = 1,
    limit = 20,
    entityType,
    action,
    userId,
    search,
  } = req.query;
  const pageNum = Number(page);
  const limitNum = Number(limit);
  const skip = (pageNum - 1) * limitNum;

  const filter: any = {};
  if (entityType) filter.entityType = entityType;
  if (action) filter.action = action;
  if (userId) filter.performedBy = userId;
  if (search) {
    filter.reason = { $regex: search, $options: "i" };
  }

  const [logs, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limitNum)
      .populate("performedBy", "name email"),
    AuditLog.countDocuments(filter),
  ]);

  const totalPages = Math.ceil(total / limitNum);

  res.json(
    new ApiResponse(
      200,
      {
        logs,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages,
        },
      },
      "Audit logs fetched successfully",
    ),
  );
});

export const getAuditLogStats = asyncHandler(async (req: Request, res: Response) => {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const stats = await AuditLog.aggregate([
    { $match: { timestamp: { $gte: thirtyDaysAgo } } },
    {
      $group: {
        _id: {
          date: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } },
          type: "$entityType",
        },
        count: { $sum: 1 },
      },
    },
    {
      $group: {
        _id: "$_id.date",
        breakdown: {
          $push: {
            k: "$_id.type",
            v: "$count",
          },
        },
        total: { $sum: "$count" },
      },
    },
    {
      $project: {
        date: "$_id",
        _id: 0,
        breakdown: { $arrayToObject: "$breakdown" },
        total: 1,
      },
    },
    { $sort: { date: 1 } },
  ]);

  res.json(new ApiResponse(200, stats, "Audit log stats fetched successfully"));
});

export const getSyncLogs = asyncHandler(async (req: Request, res: Response) => {
  const { page = 1, limit = 10 } = req.query;
  const pageNum = Number(page);
  const limitNum = Number(limit);
  const skip = (pageNum - 1) * limitNum;

  const [logs, total] = await Promise.all([
    SyncLog.find().sort({ startTime: -1 }).skip(skip).limit(limitNum),
    SyncLog.countDocuments(),
  ]);

  const totalPages = Math.ceil(total / limitNum);

  res.json(
    new ApiResponse(
      200,
      {
        logs,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages,
        },
      },
      "Sync logs fetched successfully",
    ),
  );
});

export const getSyncStats = asyncHandler(async (req: Request, res: Response) => {
  const latestSync = await SyncLog.findOne().sort({ startTime: -1 });

  const last30Runs = await SyncLog.find().sort({ startTime: -1 }).limit(30);
  const successCount = last30Runs.filter(
    (run) => run.status === "COMPLETED",
  ).length;
  const successRate =
    last30Runs.length > 0 ? (successCount / last30Runs.length) * 100 : 100;

  res.json(
    new ApiResponse(
      200,
      {
        latestSync,
        successRate,
        totalRuns: await SyncLog.countDocuments(),
      },
      "Sync stats fetched successfully",
    ),
  );
});

export default {
  getAllOrganizations,
  getAllUsers,
  getSystemStats,
  getProcessStats,
  getSystemLogs,
  getLogStats,
  clearSystemLogs,
  suspendUser,
  activateUser,
  updateUserRole,
  deleteUser,
  suspendOrganization,
  activateOrganization,
  updateOrganizationSubscription,
  getFinancialStats,
  getAuditLogs,
  getAuditLogStats,
  getSyncLogs,
  getSyncStats,
};
