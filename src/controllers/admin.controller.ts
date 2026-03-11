import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import Organization from "../models/Organization.model";
import User from "../models/User.model";
import Session from "../models/Session.model";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import { safeCreateNotification, notifyOrgAdmins } from "../utils/safeNotification";

/**
 * Get all organizations with pagination and search
 */
const getAllOrganizations = asyncHandler(
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
const getAllUsers = asyncHandler(async (req: Request, res: Response) => {
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
            .select("-password") // Exclude password if it existed
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
 * Get system-wide statistics
 */
const getSystemStats = asyncHandler(async (req: Request, res: Response) => {
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

// --- USER MANAGEMENT ---

const suspendUser = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const user = await User.findByIdAndUpdate(id, { isActive: false }, { new: true });
    if (!user) throw new ApiError(404, "User not found");
    safeCreateNotification({ userId: user._id.toString(), organizationId: user.organizationId?.toString() || "", type: "system_announcement", title: "Account Suspended", message: "Your account has been suspended by an administrator." });
    res.json(new ApiResponse(200, user, "User suspended successfully"));
});

const activateUser = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const user = await User.findByIdAndUpdate(id, { isActive: true }, { new: true });
    if (!user) throw new ApiError(404, "User not found");
    safeCreateNotification({ userId: user._id.toString(), organizationId: user.organizationId?.toString() || "", type: "system_announcement", title: "Account Activated", message: "Your account has been reactivated by an administrator." });
    res.json(new ApiResponse(200, user, "User activated successfully"));
});

const updateUserRole = asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const { organizationRole } = req.body; // Promoting member to admin, etc.

    if (!organizationRole)
        throw new ApiError(400, "organizationRole is required");

    const user = await User.findById(id);
    if (!user) throw new ApiError(404, "User not found");

    // We use the casted assignment strategy we established earlier
    (user as any).organizationRole = organizationRole;
    await user.save();

    safeCreateNotification({ userId: user._id.toString(), organizationId: user.organizationId?.toString() || "", type: "role_changed", title: "Role Updated", message: `Your role has been changed to ${organizationRole}.` });

    res.json(new ApiResponse(200, user, "User role updated successfully"));
});

const deleteUser = asyncHandler(async (req: Request, res: Response) => {
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

    await Promise.all([
        User.findByIdAndDelete(id),
        Session.deleteMany({ userId: id }),
    ]);

    res.json(new ApiResponse(200, null, "User deleted successfully"));
});

// --- ORGANIZATION MANAGEMENT ---

const suspendOrganization = asyncHandler(
    async (req: Request, res: Response) => {
        const { id } = req.params;
        const org = await Organization.findByIdAndUpdate(id, { status: "suspended" }, { new: true });
        if (!org) throw new ApiError(404, "Organization not found");
        notifyOrgAdmins(id, "system_announcement", "Organization Suspended", "Your organization has been suspended by a system administrator.");
        res.json(new ApiResponse(200, org, "Organization suspended successfully"));
    },
);

const activateOrganization = asyncHandler(
    async (req: Request, res: Response) => {
        const { id } = req.params;
        const org = await Organization.findByIdAndUpdate(id, { status: "active" }, { new: true });
        if (!org) throw new ApiError(404, "Organization not found");
        notifyOrgAdmins(id, "system_announcement", "Organization Activated", "Your organization has been reactivated by a system administrator.");
        res.json(new ApiResponse(200, org, "Organization activated successfully"));
    },
);

const updateOrganizationSubscription = asyncHandler(
    async (req: Request, res: Response) => {
        const { id } = req.params;
        const { plan, status } = req.body;

        // We update the subscription object on the User (Owner) or Org?
        // Plan says "Edit Subscription".
        // Currently subscription is on the USER (IUser.subscription).
        // But we are editing an ORGANIZATION. logic is a bit split.
        // For now, let's assume we update the owner's subscription for this org.

        const org = await Organization.findById(id);
        if (!org) throw new ApiError(404, "Organization not found");

        const owner = await User.findById(org.ownerId);
        if (!owner) throw new ApiError(404, "Organization owner not found");

        if (plan) owner.subscription!.plan = plan;
        if (status) owner.subscription!.status = status;

        await owner.save();

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

const getFinancialStats = asyncHandler(async (req: Request, res: Response) => {
    // Aggregate MRR from all users
    // This is a rough calculation based on plan types
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
                totalRevenue: mrr * 12, // Projected
                activeSubscriptions: users.length,
            },
            "Financial stats fetched successfully",
        ),
    );
});

// --- AUDIT LOGS & SYNC LOGS ---

import AuditLog from "../models/AuditLog.model";
import SyncLog from "../models/SyncLog.model";

const getAuditLogs = asyncHandler(async (req: Request, res: Response) => {
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
            .populate("performedBy", "name email"), // Assuming User model has name/email
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

const getAuditLogStats = asyncHandler(async (req: Request, res: Response) => {
    // Aggregation for Activity Graph (Last 30 days)
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

const getSyncLogs = asyncHandler(async (req: Request, res: Response) => {
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

const getSyncStats = asyncHandler(async (req: Request, res: Response) => {
    // Latest Sync
    const latestSync = await SyncLog.findOne().sort({ startTime: -1 });

    // Success Rate (Last 30 runs)
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
