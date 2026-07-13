import { NextFunction, Request, Response } from "express";
import activityService from "../services/activity.service";
import { ActivityType } from "../models/UserActivity.model";
import logger from "../utils/logger";

const EXCLUDED_PATH_PREFIXES = [
  "/api/health",
  "/api/activity",
  "/api/profile/activities",
];

const EXCLUDED_METHODS = new Set(["GET", "OPTIONS", "HEAD"]);

function normalizePath(pathname: string) {
  return pathname.replace(/\?.*$/, "").replace(/\/+$/, "") || "/";
}

function toTitleCase(value: string) {
  return value
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function summarizeResource(pathname: string) {
  const parts = normalizePath(pathname)
    .split("/")
    .filter(Boolean)
    .filter((part) => part !== "api")
    .filter((part) => !/^[a-fA-F0-9]{24}$/.test(part))
    .filter((part) => !/^\d+$/.test(part));

  if (parts.length === 0) return "Resource";
  return toTitleCase(parts.join(" "));
}

function inferActivityType(pathname: string, method: string): ActivityType {
  const path = normalizePath(pathname);

  if (
    (path === "/api/auth/login" || path === "/api/crm/login") &&
    method === "POST"
  )
    return "login";
  if (
    (path === "/api/auth/logout" || path === "/api/crm/logout") &&
    method === "POST"
  )
    return "logout";
  if (path === "/api/profile/avatar" && method === "PATCH")
    return "avatar_updated";
  if (path === "/api/profile" && method === "PATCH") return "profile_update";

  if (path.startsWith("/api/quotes")) {
    if (method === "POST") return "quote_created";
    if (method === "PATCH" || method === "PUT") return "quote_updated";
    if (method === "DELETE") return "quote_deleted";
  }

  if (path.startsWith("/api/shipments")) {
    if (method === "POST") return "shipment_created";
    if (method === "PATCH" || method === "PUT") return "shipment_updated";
    if (method === "DELETE") return "shipment_deleted";
  }

  if (path.startsWith("/api/appointments")) {
    if (method === "POST") return "appointment_created";
    if (method === "PATCH" || method === "PUT") return "appointment_updated";
    if (method === "DELETE") return "appointment_cancelled";
  }

  if (
    path.startsWith("/api/vehicles") ||
    path.startsWith("/api/customer/vehicles")
  ) {
    if (method === "POST") return "vehicle_added";
    if (method === "PATCH" || method === "PUT") return "vehicle_updated";
  }

  if (path.startsWith("/api/google-calendar")) {
    if (method === "POST") return "google_calendar_connected";
    if (method === "DELETE") return "google_calendar_disconnected";
  }

  if (
    path.startsWith("/api/customer/wallet") ||
    path.startsWith("/api/payments")
  ) {
    if (method === "POST") return "payment_completed";
  }

  return "other";
}

function inferTitle(pathname: string, method: string) {
  const resource = summarizeResource(pathname);

  if (method === "GET") return `Viewed ${resource}`;
  if (method === "POST") return `Created ${resource}`;
  if (method === "PUT" || method === "PATCH") return `Updated ${resource}`;
  if (method === "DELETE") return `Deleted ${resource}`;

  return `Action on ${resource}`;
}

function inferDescription(
  pathname: string,
  method: string,
  statusCode: number,
) {
  const resource = summarizeResource(pathname);
  return `${method} ${resource} (HTTP ${statusCode})`;
}

export const activityAuditMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const startedAt = Date.now();

  res.on("finish", () => {
    const path = normalizePath(req.originalUrl || req.url || "");
    const method = req.method.toUpperCase();

    if (!path.startsWith("/api/")) return;
    if (EXCLUDED_METHODS.has(method)) return;
    if (EXCLUDED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)))
      return;

    const statusCode = res.statusCode;
    if (statusCode < 200 || statusCode >= 400) return;

    const actorId =
      req.user?._id?.toString?.() || req.crmUser?._id?.toString?.();
    if (!actorId) return;

    const organizationId =
      req.orgId ||
      req.user?.organizationId?.toString?.() ||
      req.crmUser?.organizationId?.toString?.();

    const activityType = inferActivityType(path, method);
    const title = inferTitle(path, method);
    const description = inferDescription(path, method, statusCode);

    void activityService
      .createActivity({
        userId: actorId,
        organizationId,
        type: activityType,
        title,
        description,
        ipAddress: req.ip,
        userAgent: req.get("user-agent") || undefined,
        metadata: {
          method,
          path,
          statusCode,
          durationMs: Date.now() - startedAt,
        },
      })
      .catch((error) => {
        logger.debug(
          { error, path, method },
          "Failed to persist activity audit log",
        );
      });
  });

  next();
};
