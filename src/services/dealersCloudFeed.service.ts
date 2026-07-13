import { Client as FtpClient } from "basic-ftp";
import { Writable } from "stream";
import Vehicle from "../models/Vehicle.model";
import FeedConfig, { IFeedConfig } from "../models/FeedConfig.model";
import { ApiError } from "../utils/ApiError";
import logger from "../utils/logger";
import cacheService from "../services/cache.service";


const normKey = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]/g, "");

const ALIASES: Record<string, string> = {
  vin: "vin",
  year: "year",
  modelyear: "year",
  make: "make",
  model: "modelName",
  modelname: "modelName",
  trim: "trim",
  trimlevel: "trim",
  exteriorcolor: "exteriorColor",
  extcolor: "exteriorColor",
  color: "exteriorColor",
  interiorcolor: "interiorColor",
  intcolor: "interiorColor",
  stocknumber: "stockNumber",
  stock: "stockNumber",
  stockno: "stockNumber",
  vehicletype: "vehicleType",
  type: "vehicleType",
  bodystyle: "bodyStyle",
  body: "bodyStyle",
  price: "price",
  sellingprice: "price",
  internetprice: "price",
  listprice: "price",
  msrp: "msrp",
  retailprice: "msrp",
  cost: "cost",
  unitcost: "cost",
  mileage: "mileage",
  odometer: "mileage",
  miles: "mileage",
  transmission: "transmission",
  trans: "transmission",
  engine: "engine",
  fueltype: "fuelType",
  fuel: "fuelType",
  drivetrain: "driveTrain",
  drivetype: "driveTrain",
  drive: "driveTrain",
  doors: "doors",
  cylinders: "cylinders",
  cyl: "cylinders",
  options: "options",
  features: "options",
  comments: "comments",
  description: "comments",
  images: "images",
  imageurls: "images",
  photourls: "images",
  photos: "images",
  vdpurl: "vdpUrl",
  detailurl: "vdpUrl",
  certified: "certified",
  cpo: "certified",
  isnew: "isNewVehicle",
  newused: "isNewVehicle",
  condition: "isNewVehicle",
  dealerid: "dealerId",
  dealername: "dealerName",
  dealeraddress: "dealerAddress",
  dealercity: "dealerCity",
  city: "dealerCity",
  dealerstate: "dealerState",
  state: "dealerState",
  dealerzip: "dealerZip",
  zip: "dealerZip",
  zipcode: "dealerZip",
  dealeremail: "dealerEmail",
  status: "status",
};

const NUMERIC_FIELDS = new Set([
  "year",
  "price",
  "msrp",
  "cost",
  "mileage",
  "doors",
  "cylinders",
]);
const BOOLEAN_FIELDS = new Set(["certified"]);

const toNumber = (v: string): number | undefined => {
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : undefined;
};

const toBool = (v: string): boolean =>
  /^(true|yes|y|1|cpo|certified)$/i.test(String(v).trim());

const splitImages = (v: string): string[] =>
  String(v)
    .split(/[|;,\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s));

const toIsNew = (v: string): boolean => /^(new|n|true|1)$/i.test(String(v).trim());

const detectDelimiter = (headerLine: string): string => {
  const counts: Record<string, number> = {
    "\t": (headerLine.match(/\t/g) || []).length,
    "|": (headerLine.match(/\|/g) || []).length,
    ",": (headerLine.match(/,/g) || []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
};

export interface ParsedVehicle {
  [key: string]: any;
}

export const parseFeed = (
  contents: string,
  config: Pick<IFeedConfig, "delimiter" | "columnMap" | "defaultStatus">,
): ParsedVehicle[] => {
  const lines = contents
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);

  if (lines.length < 2) return [];

  const delimiter =
    !config.delimiter || config.delimiter === "auto"
      ? detectDelimiter(lines[0])
      : config.delimiter;

  const rawHeaders = lines[0].split(delimiter).map((h) => h.trim());
  const override = config.columnMap || {};

  const fieldForIndex: (string | null)[] = rawHeaders.map((h) => {
    if (override[h]) return override[h];
    return ALIASES[normKey(h)] ?? null;
  });

  const records: ParsedVehicle[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(delimiter);
    const rec: ParsedVehicle = {};

    fieldForIndex.forEach((field, idx) => {
      if (!field) return;
      const raw = (cols[idx] ?? "").trim();
      if (raw === "") return;

      if (field === "images") rec.images = splitImages(raw);
      else if (field === "isNewVehicle") rec.isNewVehicle = toIsNew(raw);
      else if (BOOLEAN_FIELDS.has(field)) rec[field] = toBool(raw);
      else if (NUMERIC_FIELDS.has(field)) {
        const n = toNumber(raw);
        if (n !== undefined) rec[field] = n;
      } else rec[field] = raw;
    });

    if (!rec.vin) continue;
    rec.vin = String(rec.vin).toUpperCase().trim();

    if (!rec.status) rec.status = config.defaultStatus;
    records.push(rec);
  }

  return records;
};

export const fetchFeedFile = async (config: IFeedConfig): Promise<string> => {
  const host = config.ftpHost || process.env.DEALERSCLOUD_FTP_HOST;
  const user = config.ftpUser || process.env.DEALERSCLOUD_FTP_USER;
  const password = config.ftpPassword || process.env.DEALERSCLOUD_FTP_PASSWORD;
  const remotePath =
    config.remoteFilePath ||
    process.env.DEALERSCLOUD_FTP_FILE ||
    "DealerCloud.txt";

  if (!host || !user) {
    throw new ApiError(
      400,
      `Feed ${config.feedId}: missing FTP host/user (set on FeedConfig or DEALERSCLOUD_FTP_* env)`,
    );
  }

  const client = new FtpClient(30_000);
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });

  try {
    await client.access({
      host,
      port: config.ftpPort || Number(process.env.DEALERSCLOUD_FTP_PORT) || 21,
      user,
      password,
      secure: config.ftpSecure ?? false,
    });
    await client.downloadTo(sink, remotePath);
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    client.close();
  }
};

export interface SyncResult {
  feedId: string;
  organizationId: string;
  parsed: number;
  inserted: number;
  updated: number;
  missing: number;
}

export const syncFeed = async (
  feedId: string,
  rawContentsOverride?: string,
): Promise<SyncResult> => {
  const config = await FeedConfig.findOne({ feedId, active: true });
  if (!config) {
    throw new ApiError(404, `No active feed config found for feedId "${feedId}"`);
  }

  try {
    const contents =
      rawContentsOverride ?? (await fetchFeedFile(config));
    const records = parseFeed(contents, config);

    if (records.length === 0) {
      throw new ApiError(422, "Feed parsed to zero vehicles — check delimiter/headers");
    }

    const now = new Date();
    const feedVins = records.map((r) => r.vin);

    const ops = records.map((rec) => ({
      updateOne: {
        filter: { vin: rec.vin },
        update: {
          $set: { ...rec, organizationId: config.organizationId },
          $setOnInsert: { dateAdded: now, daysOnLot: 0, isDeleted: false },
        },
        upsert: true,
      },
    }));

    const result = await Vehicle.bulkWrite(ops, { ordered: false });
    const inserted = result.upsertedCount || 0;
    const updated = result.modifiedCount || 0;

    let missing = 0;
    if (config.missingStrategy !== "ignore") {
      const missingFilter = {
        organizationId: config.organizationId,
        isDeleted: false,
        vin: { $nin: feedVins },
      };
      const update =
        config.missingStrategy === "mark-sold"
          ? { $set: { status: "Sold", dateSold: now } }
          : { $set: { isDeleted: true } };
      const r = await Vehicle.updateMany(missingFilter, update);
      missing = r.modifiedCount || 0;
    }

    const counts = { parsed: records.length, inserted, updated, missing };

    config.lastSyncAt = now;
    config.lastSyncStatus = "success";
    config.lastSyncMessage = `Synced ${records.length} vehicles`;
    config.lastSyncCounts = counts;
    await config.save();

    await cacheService.invalidateByPrefix("veh:");

    logger.info(
      { feedId, orgId: config.organizationId, ...counts },
      "DealersCloud feed synced",
    );

    return { feedId, organizationId: config.organizationId, ...counts };
  } catch (err: any) {
    config.lastSyncAt = new Date();
    config.lastSyncStatus = "error";
    config.lastSyncMessage = err?.message || "Unknown sync error";
    await config.save().catch(() => {});
    logger.error({ feedId, err }, "DealersCloud feed sync failed");
    throw err;
  }
};

export const syncAllFeeds = async (): Promise<SyncResult[]> => {
  const feeds = await FeedConfig.find({ active: true }).select("feedId");
  const results: SyncResult[] = [];
  for (const f of feeds) {
    try {
      results.push(await syncFeed(f.feedId));
    } catch {
    }
  }
  return results;
};

export default { parseFeed, fetchFeedFile, syncFeed, syncAllFeeds };