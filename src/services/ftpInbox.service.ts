import { FtpSrv } from "ftp-srv";
import chokidar from "chokidar";
import fs from "fs/promises";
import path from "path";
import FeedConfig from "../models/FeedConfig.model";
import feedService from "./dealersCloudFeed.service";
import logger from "../utils/logger";

/**
 * FTP INBOX (push model)
 * ----------------------
 * DealersCloud uploads DealerCloud.txt to an FTP server WE host. A filesystem
 * watcher then parses + ingests each completed upload through the same
 * syncFeed() pipeline used everywhere else.
 *
 * Required env (see .env notes):
 *   FTP_SERVER_PORT=2121
 *   FTP_PASSIVE_URL=<PUBLIC ip/hostname DC connects to>   // NOT 127.0.0.1 in prod
 *   FTP_PASV_MIN=21000
 *   FTP_PASV_MAX=21010
 *   FTP_SERVER_USER=dealerscloud
 *   FTP_SERVER_PASSWORD=<strong secret>                    // change from test123
 *   FTP_UPLOAD_DIR=./ftp-uploads
 *
 * Call startFtpInbox() once during server startup (see startup snippet).
 */

const UPLOAD_DIR = path.resolve(process.env.FTP_UPLOAD_DIR || "./ftp-uploads");
const PROCESSED_DIR = path.join(UPLOAD_DIR, ".processed");
const FAILED_DIR = path.join(UPLOAD_DIR, ".failed");

const ensureDirs = async () => {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.mkdir(PROCESSED_DIR, { recursive: true });
  await fs.mkdir(FAILED_DIR, { recursive: true });
};

/**
 * Decide which feed (org) an uploaded file belongs to.
 * - If the file sits in a subfolder, treat the folder name as the feedId.
 * - Otherwise, if there's exactly one active push feed, use it.
 * - Otherwise we can't route it safely -> null.
 */
const resolveFeedId = async (relPath: string): Promise<string | null> => {
  const parts = relPath.split(path.sep).filter(Boolean);
  const folder = parts.length > 1 ? parts[0] : null;

  if (folder) {
    const byFolder = await FeedConfig.findOne({
      feedId: folder,
      mode: "push",
      active: true,
    });
    if (byFolder) return byFolder.feedId;
  }

  const pushFeeds = await FeedConfig.find({
    mode: "push",
    active: true,
  }).select("feedId");

  return pushFeeds.length === 1 ? pushFeeds[0].feedId : null;
};

const moveFile = async (from: string, toDir: string) => {
  const dest = path.join(toDir, `${Date.now()}_${path.basename(from)}`);
  await fs.rename(from, dest).catch(async () => {
    // rename across devices can fail; fall back to copy+unlink
    await fs.copyFile(from, dest);
    await fs.unlink(from);
  });
  return dest;
};

const ingestFile = async (filePath: string) => {
  // Ignore our own bookkeeping folders
  if (filePath.includes(`${path.sep}.processed${path.sep}`)) return;
  if (filePath.includes(`${path.sep}.failed${path.sep}`)) return;

  const relPath = path.relative(UPLOAD_DIR, filePath);

  try {
    const feedId = await resolveFeedId(relPath);
    if (!feedId) {
      logger.warn(
        { file: relPath },
        "FTP inbox: could not match file to a push feed (no/ambiguous FeedConfig) — moving to .failed",
      );
      await moveFile(filePath, FAILED_DIR);
      return;
    }

    const contents = await fs.readFile(filePath, "utf8");
    const result = await feedService.syncFeed(feedId, contents);

    await moveFile(filePath, PROCESSED_DIR);
    logger.info({ file: relPath, ...result }, "FTP inbox: file ingested");
  } catch (err) {
    logger.error({ file: relPath, err }, "FTP inbox: ingest failed");
    await moveFile(filePath, FAILED_DIR).catch(() => {});
  }
};

let watcherStarted = false;
const startWatcher = () => {
  if (watcherStarted) return;
  watcherStarted = true;

  const watcher = chokidar.watch(UPLOAD_DIR, {
    ignoreInitial: true,
    ignored: [`${PROCESSED_DIR}/**`, `${FAILED_DIR}/**`],
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 250 },
    depth: 2,
  });

  watcher
    .on("add", (fp) => ingestFile(fp))
    .on("change", (fp) => ingestFile(fp))
    .on("error", (err) => logger.error({ err }, "FTP inbox watcher error"));

  logger.info({ dir: UPLOAD_DIR }, "FTP inbox watcher started");
};

let ftpServer: FtpSrv | null = null;

export const startFtpInbox = async () => {
  await ensureDirs();

  const port = Number(process.env.FTP_SERVER_PORT) || 2121;
  const pasvUrl = process.env.FTP_PASSIVE_URL || "127.0.0.1";
  const pasvMin = Number(process.env.FTP_PASV_MIN) || 21000;
  const pasvMax = Number(process.env.FTP_PASV_MAX) || 21010;
  const ftpUser = process.env.FTP_SERVER_USER || "dealerscloud";
  const ftpPass = process.env.FTP_SERVER_PASSWORD || "";

  ftpServer = new FtpSrv({
    url: `ftp://0.0.0.0:${port}`,
    pasv_url: pasvUrl,
    pasv_min: pasvMin,
    pasv_max: pasvMax,
    anonymous: false,
    greeting: ["Inventory feed inbox"],
  });

  ftpServer.on("login", ({ username, password }, resolve, reject) => {
    if (username === ftpUser && password === ftpPass && ftpPass.length > 0) {
      // Each login is rooted at the upload dir; create a per-user subfolder
      // if you onboard multiple dealerships and want folder-based routing.
      return resolve({ root: UPLOAD_DIR });
    }
    return reject(new Error("Invalid FTP credentials"));
  });

  await ftpServer.listen();
  logger.info({ port, pasvUrl, pasvMin, pasvMax }, "FTP inbox server listening");

  startWatcher();
};

export const stopFtpInbox = async () => {
  if (ftpServer) await ftpServer.close();
};

export default { startFtpInbox, stopFtpInbox };