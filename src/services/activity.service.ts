import UserActivity, {
  IUserActivity,
  ActivityType,
} from "../models/UserActivity.model";
import mongoose from "mongoose";
import { getSocketIO } from "../utils/socketEmitter";

interface CreateActivityParams {
  userId: string;
  organizationId?: string;
  type: ActivityType;
  title: string;
  description: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Create a new user activity log
 */
const createActivity = async (
  params: CreateActivityParams,
): Promise<IUserActivity> => {
  const activity = await UserActivity.create({
    userId: new mongoose.Types.ObjectId(params.userId),
    organizationId: params.organizationId
      ? new mongoose.Types.ObjectId(params.organizationId)
      : undefined,
    type: params.type,
    title: params.title,
    description: params.description,
    metadata: params.metadata,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  });

  // Emit real-time event
  try {
    const io = getSocketIO();
    if (io && params.userId) {
      io.to(`user:${params.userId}`).emit("profile:activity_created", {
        _id: activity._id,
        type: activity.type,
        title: activity.title,
        description: activity.description,
        timestamp: activity.createdAt,
      });
    }
  } catch (error) {
    // Socket emission is non-critical
    console.error("Failed to emit activity event:", error);
  }

  return activity;
};

// Only surface meaningful actions — login/logout, page views, and other noise excluded
const IMPORTANT_ACTIVITY_TYPES: ActivityType[] = [
  'profile_update',
  'avatar_updated',
  'shipment_created',
  'shipment_updated',
  'shipment_deleted',
  'load_posted',
  'load_assigned',
  'load_delivered',
  'quote_created',
  'quote_updated',
  'quote_deleted',
  'payment_completed',
  'payout_received',
];

/**
 * Get recent activities for a user
 * Maps createdAt to timestamp for frontend compatibility
 */
const getRecentActivities = async (
  userId: string,
  limit = 20,
  skip = 0,
): Promise<any[]> => {
  const activities = await UserActivity.find({
    userId: new mongoose.Types.ObjectId(userId),
    type: { $in: IMPORTANT_ACTIVITY_TYPES },
  })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  // Map createdAt to timestamp for frontend compatibility
  return activities.map((activity) => ({
    ...activity,
    timestamp: activity.createdAt,
  }));
};

/**
 * Get activities for an organization (or global if ID is missing)
 */
const getOrganizationActivities = async (
  organizationId?: string,
  limit = 50,
  skip = 0,
): Promise<any[]> => {
  const query: any = {};

  if (organizationId) {
    query.organizationId = new mongoose.Types.ObjectId(organizationId);
  }

  const activities = await UserActivity.find(query)
    .populate("userId", "name email avatar")
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

  // Map createdAt to timestamp for frontend compatibility
  return activities.map((activity) => ({
    ...activity,
    timestamp: activity.createdAt,
  }));
};

/**
 * Get activity count for a user
 */
const getActivityCount = async (userId: string): Promise<number> => {
  return UserActivity.countDocuments({
    userId: new mongoose.Types.ObjectId(userId),
  });
};

/**
 * Delete old activities (utility function for manual cleanup)
 */
const deleteOldActivities = async (daysOld = 90): Promise<number> => {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysOld);

  const result = await UserActivity.deleteMany({
    createdAt: { $lt: cutoffDate },
  });

  return result.deletedCount || 0;
};

/**
 * Log profile update activity
 */
const logProfileUpdate = async (
  userId: string,
  organizationId: string | undefined,
  updatedFields: string[],
  ipAddress?: string,
  userAgent?: string,
): Promise<IUserActivity> => {
  return createActivity({
    userId,
    organizationId,
    type: "profile_update",
    title: "Profile Updated",
    description: `Updated: ${updatedFields.join(", ")}`,
    metadata: { updatedFields },
    ipAddress,
    userAgent,
  });
};

/**
 * Log login activity
 */
const logLogin = async (
  userId: string,
  organizationId: string | undefined,
  ipAddress?: string,
  userAgent?: string,
): Promise<IUserActivity> => {
  return createActivity({
    userId,
    organizationId,
    type: "login",
    title: "Signed In",
    description: "Successfully signed into the account",
    ipAddress,
    userAgent,
  });
};

/**
 * Log avatar update activity
 */
const logAvatarUpdate = async (
  userId: string,
  organizationId: string | undefined,
): Promise<IUserActivity> => {
  return createActivity({
    userId,
    organizationId,
    type: "avatar_updated",
    title: "Profile Picture Updated",
    description: "Changed profile picture",
  });
};

/**
 * Log Driver/Load related activities
 */
const logLoadActivity = async (
  userId: string,
  organizationId: string | undefined,
  type: ActivityType,
  loadId: string,
  description: string,
  metadata?: Record<string, any>,
): Promise<IUserActivity> => {
  const titles: Record<string, string> = {
    load_posted: "New Load Posted",
    load_assigned: "Load Assigned",
    load_delivered: "Load Delivered",
  };

  return createActivity({
    userId,
    organizationId,
    type,
    title: titles[type] || "Load Activity",
    description,
    metadata: { ...metadata, loadId },
  });
};

/**
 * Log Compliance/Document activities
 */
const logComplianceActivity = async (
  userId: string,
  organizationId: string | undefined,
  type: ActivityType,
  documentType: string,
  status: string,
): Promise<IUserActivity> => {
  const titles: Record<string, string> = {
    compliance_uploaded: "Compliance Document Uploaded",
    doc_verified: "Document Verified",
  };

  return createActivity({
    userId,
    organizationId,
    type,
    title: titles[type] || "Compliance Update",
    description: `${documentType} is now ${status}`,
    metadata: { documentType, status },
  });
};

/**
 * Log Financial/Wallet activities
 */
const logFinancialActivity = async (
  userId: string,
  organizationId: string | undefined,
  type: ActivityType,
  amount: number,
  description: string,
  metadata?: Record<string, any>,
): Promise<IUserActivity> => {
  const titles: Record<string, string> = {
    payout_received: "Payout Received",
    referral_applied: "Referral Bonus Applied",
    withdrawal_requested: "Withdrawal Requested",
    wallet_adjustment: "Wallet Adjusted",
  };

  return createActivity({
    userId,
    organizationId,
    type,
    title: titles[type] || "Financial Activity",
    description: `${description} (${amount > 0 ? "+" : ""}${amount})`,
    metadata: { ...metadata, amount },
  });
};

/**
 * Log Admin Management actions
 */
const logAdminAction = async (
  adminId: string,
  organizationId: string | undefined,
  type: ActivityType,
  targetUserId: string,
  description: string,
): Promise<IUserActivity> => {
  const titles: Record<string, string> = {
    user_suspended: "User Suspended",
    user_activated: "User Activated",
    org_suspended: "Organization Suspended",
    subscription_changed: "Subscription Updated",
    logs_cleared: "System Logs Cleared",
  };

  return createActivity({
    userId: adminId,
    organizationId,
    type,
    title: titles[type] || "Admin Action",
    description,
    metadata: { targetUserId },
  });
};

export default {
  createActivity,
  getRecentActivities,
  getOrganizationActivities,
  getActivityCount,
  deleteOldActivities,
  logProfileUpdate,
  logLogin,
  logAvatarUpdate,
  logLoadActivity,
  logComplianceActivity,
  logFinancialActivity,
  logAdminAction,
};
