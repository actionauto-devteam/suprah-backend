import { Request, Response } from "express";
import crypto from "crypto";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import FeedConfig from "../models/FeedConfig.model";
import feedService from "../services/dealersCloudFeed.service";

const ADMIN_ROLES = ["admin", "super_admin"];

function requireAdmin(req: Request) {
  if (!ADMIN_ROLES.includes(req.orgRole || "")) {
    throw new ApiError(403, "Only admins can manage inventory feed configs");
  }
}

const WRITABLE_FIELDS = [
  "provider", "active", "mode", "ftpHost", "ftpPort", "ftpUser", "ftpPassword",
  "ftpSecure", "remoteFilePath", "delimiter", "columnMap", "missingStrategy", "defaultStatus",
] as const;

function pickWritable(body: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const key of WRITABLE_FIELDS) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

const createFeedConfig = asyncHandler(async (req: Request, res: Response) => {
  requireAdmin(req);
  const orgId = req.orgId as string;
  if (!orgId) throw new ApiError(400, "organizationId is required");

  const feedId =
    req.body.feedId ||
    `feed_${orgId}_${crypto.randomBytes(6).toString("hex")}`;

  const config = await FeedConfig.create({
    ...pickWritable(req.body),
    feedId,
    organizationId: orgId,
  });

  res
    .status(201)
    .json(new ApiResponse(201, config, "Feed config created"));
});

const listFeedConfigs = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const filter = orgId ? { organizationId: orgId } : {};
  const configs = await FeedConfig.find(filter).sort({ createdAt: -1 });
  res.json(new ApiResponse(200, configs, "Feed configs fetched"));
});

const updateFeedConfig = asyncHandler(async (req: Request, res: Response) => {
  requireAdmin(req);
  const config = await FeedConfig.findOneAndUpdate(
    { feedId: req.params.feedId, organizationId: req.orgId as string },
    pickWritable(req.body),
    { new: true, runValidators: true },
  );
  if (!config) throw new ApiError(404, "Feed config not found");
  res.json(new ApiResponse(200, config, "Feed config updated"));
});

/** Manually trigger a pull-and-sync for one feed (handy for testing). */
const triggerSync = asyncHandler(async (req: Request, res: Response) => {
  requireAdmin(req);
  const config = await FeedConfig.findOne({ feedId: req.params.feedId, organizationId: req.orgId as string }).select("_id");
  if (!config) throw new ApiError(404, "Feed config not found");
  const result = await feedService.syncFeed(req.params.feedId);
  res.json(new ApiResponse(200, result, "Feed synced"));
});

/**
 * "Push" endpoint: if DealersCloud (or your FTP-inbox watcher) hands you the
 * file body directly, POST it here as text/plain or { contents }.
 */
const ingestPushedFeed = asyncHandler(async (req: Request, res: Response) => {
  const contents =
    typeof req.body === "string" ? req.body : req.body?.contents;
  if (!contents) throw new ApiError(400, "Feed contents are required");
  const result = await feedService.syncFeed(req.params.feedId, contents);
  res.json(new ApiResponse(200, result, "Feed ingested"));
});

/** Sync all active feeds (call from cron or expose to an admin button). */
const triggerSyncAll = asyncHandler(async (_req: Request, res: Response) => {
  const results = await feedService.syncAllFeeds();
  res.json(new ApiResponse(200, results, "All feeds synced"));
});

export default {
  createFeedConfig,
  listFeedConfigs,
  updateFeedConfig,
  triggerSync,
  ingestPushedFeed,
  triggerSyncAll,
};