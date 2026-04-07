import { Request, Response } from 'express';
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
export const getSystemLogs = asyncHandler(async (req: Request, res: Response) => {
  const logPath = path.join(process.cwd(), 'logs', 'app.log');
  const lineCount = parseInt(req.query.lines as string) || 200;

  if (!fs.existsSync(logPath)) {
    throw new ApiError(404, "Log file not found");
  }

  // Use a chunk-based approach to read from the end of the file
  const CHUNK_SIZE = 16 * 1024; // 16KB
  const stats = fs.statSync(logPath);
  let fileSize = stats.size;
  let fd = fs.openSync(logPath, 'r');
  let buffer = Buffer.alloc(CHUNK_SIZE);
  let lines: string[] = [];
  let currentPos = fileSize;

  try {
    while (lines.length < lineCount && currentPos > 0) {
      const readSize = Math.min(CHUNK_SIZE, currentPos);
      currentPos -= readSize;
      
      fs.readSync(fd, buffer, 0, readSize, currentPos);
      const chunk = buffer.toString('utf8', 0, readSize);
      const chunkLines = chunk.split('\n');
      
      if (lines.length > 0 && !chunk.endsWith('\n')) {
        // Handle line split across chunks
        const lastLineOfChunk = chunkLines.pop() || '';
        lines[0] = lastLineOfChunk + lines[0];
      }
      
      lines = [...chunkLines, ...lines];
    }
  } finally {
    fs.closeSync(fd);
  }

  // Slice to the requested number of lines from the end
  const result = lines.slice(-lineCount);

  return res.status(200).json(
    new ApiResponse(200, result, "Logs retrieved successfully")
  );
});

/**
 * Clear application logs
 */
export const clearSystemLogs = asyncHandler(async (req: Request, res: Response) => {
  const logPath = path.join(process.cwd(), 'logs', 'app.log');
  
  if (fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, '');
  }

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
