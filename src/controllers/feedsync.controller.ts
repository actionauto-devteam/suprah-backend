import { Request, Response } from "express";
import { asyncHandler } from "../utils/asyncHandler";
import { ApiResponse } from "../utils/ApiResponse";
import { ApiError } from "../utils/ApiError";
import FeedConfig from "../models/FeedConfig.model";
import feedService from "../services/dealersCloudFeed.service";

/**
 * Create / register a feed.
 * If DealersCloud issues the Feed ID, pass it in `feedId`.
 * If YOU issue it, omit `feedId` and we generate one to hand to DealersCloud.
 */
const createFeedConfig = asyncHandler(async (req: Request, res: Response) => {
  const orgId = (req.orgId as string) || req.body.organizationId;
  if (!orgId) throw new ApiError(400, "organizationId is required");

  const feedId =
    req.body.feedId ||
    `feed_${orgId}_${Math.random().toString(36).slice(2, 10)}`;

  const config = await FeedConfig.create({
    ...req.body,
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
  const config = await FeedConfig.findOneAndUpdate(
    { feedId: req.params.feedId },
    req.body,
    { new: true, runValidators: true },
  );
  if (!config) throw new ApiError(404, "Feed config not found");
  res.json(new ApiResponse(200, config, "Feed config updated"));
});

/** Manually trigger a pull-and-sync for one feed (handy for testing). */
const triggerSync = asyncHandler(async (req: Request, res: Response) => {
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