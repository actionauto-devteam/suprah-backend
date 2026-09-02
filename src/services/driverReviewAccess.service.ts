import mongoose from "mongoose";
import Load from "../models/Load.model";
import { ApiError } from "../utils/ApiError";

export const DRIVER_ACTIVE_LOAD_STATUSES = [
  "Assigned",
  "Accepted",
  "Picked Up",
  "In-Transit",
] as const;

export type DriverReviewAccessLevel =
  | "ADMIN_REVIEW"
  | "DISPATCH_ACTIVE_LOAD"
  | "DISPATCH_LIMITED"
  | "OPERATIONAL_ONLY"
  | "NONE";

export interface DriverReviewLoadRelationship {
  id: string;
  loadNumber?: string;
  status?: string;
}

export interface DriverReviewAccessDecision {
  level: DriverReviewAccessLevel;
  canOpenReviewCenter: boolean;
  canReviewDocuments: boolean;
  canViewDocumentContents: boolean;
  canViewReviewHistory: boolean;
  canFinalizeVerification: boolean;
  hasActiveLoadRelationship: boolean;
  organizationId?: string;
  activeLoads: DriverReviewLoadRelationship[];
  reason: string;
}

interface ResolveAccessArgs {
  viewer: any;
  organizationId?: string | null;
  organizationRole?: string | null;
  driverId: string;
}

const normalizeId = (value: unknown) => String(value ?? "").trim();

const hasDispatcherAccessForOrganization = (viewer: any, organizationId: string) => {
  if (!organizationId) return false;
  const scopedIds = Array.isArray(viewer?.dispatcherOrganizationIds)
    ? viewer.dispatcherOrganizationIds
    : [];
  return scopedIds.some((value: unknown) => normalizeId(value) === organizationId);
};

export async function resolveDriverReviewAccess({
  viewer,
  organizationId,
  organizationRole,
  driverId,
}: ResolveAccessArgs): Promise<DriverReviewAccessDecision> {
  const viewerId = normalizeId(viewer?._id);
  const viewerRole = normalizeId(viewer?.role);
  const orgId = normalizeId(organizationId);
  const orgRole = normalizeId(organizationRole);

  if (!viewerId) {
    throw new ApiError(401, "User not authenticated");
  }
  if (!mongoose.Types.ObjectId.isValid(driverId)) {
    throw new ApiError(400, "Invalid driver ID");
  }

  if (viewerRole === "super_admin") {
    return {
      level: "ADMIN_REVIEW",
      canOpenReviewCenter: true,
      canReviewDocuments: true,
      canViewDocumentContents: true,
      canViewReviewHistory: true,
      canFinalizeVerification: true,
      hasActiveLoadRelationship: false,
      organizationId: orgId || undefined,
      activeLoads: [],
      reason: "Platform Super Admin verification responsibility",
    };
  }

  if (!orgId) {
    return {
      level: "NONE",
      canOpenReviewCenter: false,
      canReviewDocuments: false,
      canViewDocumentContents: false,
      canViewReviewHistory: false,
      canFinalizeVerification: false,
      hasActiveLoadRelationship: false,
      activeLoads: [],
      reason: "No active organization context",
    };
  }

  // Reuse the exact assignment ownership relationship already used by Driver
  // Tracking / GPS. This service only reads it; it never changes load state.
  const activeOwnedLoads: any[] = await Load.find({
    organizationId: orgId,
    assignedDriverId: driverId,
    dispatchOwnerId: viewerId,
    status: { $in: DRIVER_ACTIVE_LOAD_STATUSES },
  })
    .select("_id loadNumber status")
    .lean();

  const activeLoads = activeOwnedLoads.map((load) => ({
    id: String(load._id),
    loadNumber: load.loadNumber ? String(load.loadNumber) : undefined,
    status: load.status ? String(load.status) : undefined,
  }));

  const hasActiveLoadRelationship = activeLoads.length > 0;

  // Organization admins can review only drivers that have an existing load
  // relationship with that organization. This prevents an org admin from
  // browsing the shared platform-wide driver pool with full verification access.
  if (orgRole === "admin" || viewerRole === "admin") {
    const hasAdministrativeScope = Boolean(
      await Load.exists({
        organizationId: orgId,
        assignedDriverId: driverId,
      }),
    );

    if (hasAdministrativeScope) {
      return {
        level: "ADMIN_REVIEW",
        canOpenReviewCenter: true,
        canReviewDocuments: true,
        canViewDocumentContents: true,
        canViewReviewHistory: true,
        canFinalizeVerification: true,
        hasActiveLoadRelationship,
        organizationId: orgId,
        activeLoads,
        reason: "Organization Admin with an existing organization-driver load relationship",
      };
    }

    return {
      level: "NONE",
      canOpenReviewCenter: false,
      canReviewDocuments: false,
      canViewDocumentContents: false,
      canViewReviewHistory: false,
      canFinalizeVerification: false,
      hasActiveLoadRelationship: false,
      organizationId: orgId,
      activeLoads: [],
      reason: "The driver is outside this administrator's organization scope",
    };
  }

  const hasDispatcherDesignation =
    viewerRole === "employee" &&
    hasDispatcherAccessForOrganization(viewer, orgId);

  if (hasDispatcherDesignation) {
    if (hasActiveLoadRelationship) {
      return {
        level: "DISPATCH_ACTIVE_LOAD",
        canOpenReviewCenter: true,
        canReviewDocuments: false,
        canViewDocumentContents: false,
        canViewReviewHistory: false,
        canFinalizeVerification: false,
        hasActiveLoadRelationship: true,
        organizationId: orgId,
        activeLoads,
        reason: "Organization-scoped Dispatcher owns an active load assigned to this exact driver",
      };
    }

    return {
      level: "DISPATCH_LIMITED",
      canOpenReviewCenter: true,
      canReviewDocuments: false,
      canViewDocumentContents: false,
      canViewReviewHistory: false,
      canFinalizeVerification: false,
      hasActiveLoadRelationship: false,
      organizationId: orgId,
      activeLoads: [],
      reason: "Organization-scoped Dispatcher has no active load relationship with this driver",
    };
  }

  // Existing support workflows can make a normal employee the explicit
  // dispatchOwnerId for a load. In that exceptional case, expose only the
  // operational minimum required for the exact active relationship.
  if (viewerRole === "employee" && hasActiveLoadRelationship) {
    return {
      level: "OPERATIONAL_ONLY",
      canOpenReviewCenter: true,
      canReviewDocuments: false,
      canViewDocumentContents: false,
      canViewReviewHistory: false,
      canFinalizeVerification: false,
      hasActiveLoadRelationship: true,
      organizationId: orgId,
      activeLoads,
      reason: "Employee is the current dispatch owner for an active load with this driver",
    };
  }

  return {
    level: "NONE",
    canOpenReviewCenter: false,
    canReviewDocuments: false,
    canViewDocumentContents: false,
    canViewReviewHistory: false,
    canFinalizeVerification: false,
    hasActiveLoadRelationship: false,
    organizationId: orgId,
    activeLoads: [],
    reason: "Driver Review Center is restricted to authorized review staff or an exact active-load relationship",
  };
}

export function assertDriverReviewCenterAccess(
  decision: DriverReviewAccessDecision,
): void {
  if (!decision.canOpenReviewCenter || decision.level === "NONE") {
    throw new ApiError(403, decision.reason);
  }
}

export function assertDriverReviewMutationAccess(
  decision: DriverReviewAccessDecision,
): void {
  if (!decision.canReviewDocuments || decision.level !== "ADMIN_REVIEW") {
    throw new ApiError(403, "This Driver Verification action is restricted to an authorized administrator");
  }
}