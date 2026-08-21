import ftpService, { RawVehicleData } from "./ftp.service";
import Vehicle from "../models/Vehicle.model";
import SyncLog from "../models/SyncLog.model";
import AuditLog from "../models/AuditLog.model";
import cacheService from "./cache.service";
import { diff } from "deep-diff";
import mongoose from "mongoose";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { parse } from "csv-parse";
import { Readable } from "stream";
import config from "../config";

const ACTION_AUTO_ORG_ID =
  process.env.ACTION_AUTO_ORG_ID || "69d6a26499bee4596c1ea94c";

/**
 * ─── SYNC SAFETY GUARDS ─────────────────────────────────────────────────────
 *
 * MIN_FEED_VEHICLES  — a confirmed feed must contain at least this many valid
 *                      VINs before ANY write (upsert or archive) is allowed.
 *                      An empty/garbled parse aborts the whole run.
 *
 * MAX_ARCHIVE_PERCENT — the archive pass refuses to archive more than this
 *                      percentage of the currently-active (non-Sold) inventory
 *                      in a single run. A truncated upload that only carried
 *                      half the lot can therefore never mass-archive the rest.
 *                      Set to 100 to disable the guard (e.g. for an intentional
 *                      large liquidation feed).
 */
const MIN_FEED_VEHICLES = config.sync.minFeedVehicles;
const MAX_ARCHIVE_PERCENT = config.sync.maxArchivePercent;

const ARCHIVE_REASON_FEED =
  "No longer present in latest DealersCloud feed";

const DC_HEADER_MAP: Record<string, string> = {
  vin: "vin",
  year: "year",
  make: "make",
  model: "model",
  trim: "trim",
  mileage: "mileage",
  internetprice: "price",
  engine: "engine",
  bodytype: "vehicletype",
  drivetype: "drivetype",
  installedoptions: "installed options",
  sellercomment: "dealer comments on vehicle",
  vehicleimagesurl: "picture urls",
  interiorcolor: "interior color",
  exteriorcolor: "exterior color",
  fueltype: "fuel type",
  doors: "doors",
  stocknumber: "stock number",
  dealershipid: "dealer id",
  dealershipname: "dealer name",
  dealershipstreet: "dealer street address",
  dealershipstate: "dealer state",
  dealershipcity: "dealer city",
  dealershipzipcode: "dealer zip",
  dealershipemail: "dealer crm email",
  dealershipphone: "dealer phone",
  dealershipwebsite: "dealer website",
  totalcost: "total cost",
};

/** A fully parsed + normalized feed row, keyed and deduplicated by VIN. */
interface NormalizedFeedRow {
  vin: string;
  /** Complete document body derived from the feed (no status field). */
  data: Record<string, any>;
  /** Row had a valid VIN but was missing required fields (make/model/year). */
  incomplete: boolean;
}

interface SyncResult {
  processed: number;
  added: number;
  updated: number;
  unchanged: number;
  archived: number;
  skippedIncomplete: number;
  duplicateRowsInFeed: number;
  duplicatesMergedInDb: number;
  archiveGuardTripped: boolean;
  warnings: string[];
}

export class SyncService {
  private isLocked = false;

  // ──────────────────────────────────────────────────────────────────────────
  //  PUBLIC ENTRY POINTS
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Scheduled pull-based sync (downloads the feed from DealersCloud FTP).
   */
  async syncInventory(): Promise<any> {
    return this.runSync(
      () => ftpService.getInventoryStream(),
      "DealersCloud FTP pull",
    );
  }

  /**
   * Push-based sync — invoked by the FTP server after a file lands in R2.
   */
  async processR2File(key: string): Promise<any> {
    return this.runSync(async () => {
      const s3Client = new S3Client({
        region: "auto",
        endpoint: config.r2.endpoint,
        credentials: {
          accessKeyId: config.r2.accessKeyId,
          secretAccessKey: config.r2.secretAccessKey,
        },
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      });

      const command = new GetObjectCommand({
        Bucket: config.r2.buckets.ftp,
        Key: key,
      });
      const response = await s3Client.send(command);
      return response.Body as Readable;
    }, `R2://${key}`);
  }

  /**
   * @deprecated Use processR2File or syncInventory
   */
  async processLocalFile(filePath: string): Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs");
    return this.runSync(
      async () => fs.createReadStream(filePath) as Readable,
      `local://${filePath}`,
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  CORE PIPELINE
  //
  //  PHASE 1 — Parse & validate the ENTIRE feed. Zero database writes happen
  //            until the file has been read to the end without a parse error
  //            and has passed the MIN_FEED_VEHICLES gate. A connection drop,
  //            truncated upload, or malformed file aborts here with the
  //            inventory completely untouched.
  //
  //  PHASE 2 — Upsert by normalized VIN (bulkWrite). Existing VINs are updated
  //            in place, new VINs inserted, previously archived VINs that
  //            reappear are automatically restored. Duplicate rows inside the
  //            feed are collapsed (last row wins) so no duplicates are ever
  //            created.
  //
  //  PHASE 3 — Archive pass. Runs ONLY after Phase 2 commits successfully.
  //            Any active vehicle whose VIN is absent from the confirmed feed
  //            is moved to Archive/Sold (soft state — full history retained).
  //            Guarded by MAX_ARCHIVE_PERCENT against partial feeds.
  // ──────────────────────────────────────────────────────────────────────────

  private async runSync(
    streamFactory: () => Promise<Readable> | Readable,
    sourceLabel: string,
  ): Promise<any> {
    if (this.isLocked) {
      console.log(
        `[SyncService] Sync already in progress — skipping (${sourceLabel}).`,
      );
      return { message: "Sync already in progress" };
    }

    // Cross-process guard: the FTP worker and the API server are separate
    // processes, so the in-memory lock above can't see the other side. A
    // RUNNING SyncLog younger than 15 minutes means another process is
    // mid-sync (older RUNNING rows are treated as crashed and ignored).
    const staleCutoff = new Date(Date.now() - 15 * 60 * 1000);
    const runningElsewhere = await SyncLog.findOne({
      status: "RUNNING",
      startTime: { $gte: staleCutoff },
    })
      .select("_id startTime")
      .lean();
    if (runningElsewhere) {
      console.log(
        `[SyncService] Another process started a sync at ` +
          `${(runningElsewhere as any).startTime?.toISOString?.() || "?"} — skipping (${sourceLabel}).`,
      );
      return { message: "Sync already in progress (another process)" };
    }

    this.isLocked = true;

    const startTime = new Date();
    const syncLog = await SyncLog.create({
      startTime,
      status: "RUNNING",
      organizationId: ACTION_AUTO_ORG_ID,
      errorMessage: `Source: ${sourceLabel}`,
    });

    try {
      // ── PHASE 1: parse the whole file up-front (no writes yet) ───────────
      const stream = await streamFactory();
      const { rows, duplicateRowsInFeed } = await this.collectFeedRows(stream);

      const feedVins = new Set<string>(rows.map((r) => r.vin));
      const completeRows = rows.filter((r) => !r.incomplete);
      const skippedIncomplete = rows.length - completeRows.length;

      if (feedVins.size < MIN_FEED_VEHICLES) {
        throw new Error(
          `Feed produced only ${feedVins.size} valid VIN(s) — below the ` +
            `SYNC_MIN_FEED_VEHICLES threshold of ${MIN_FEED_VEHICLES}. ` +
            `Aborting with no changes to protect existing inventory. ` +
            `Check the file's delimiter/headers.`,
        );
      }

      // ── PHASE 1.5: merge duplicate vehicle documents already in the DB ───
      // Legacy imports matched VINs case-sensitively, so the same physical
      // car can exist twice (e.g. "abc123" and "ABC123"). Merge those before
      // upserting so the feed always updates exactly one document per VIN.
      const dedupeStats = await this.dedupeVehicles();

      // ── PHASE 2: upsert the confirmed dataset ────────────────────────────
      const upsertStats = await this.applyUpserts(completeRows);

      // ── PHASE 3: archive vehicles missing from the confirmed feed ────────
      // feedVins intentionally includes VINs from incomplete rows: a vehicle
      // whose row was malformed is still PRESENT in the feed and must never
      // be archived because of a data-quality hiccup on unrelated columns.
      const archiveStats = await this.archiveMissingVehicles(feedVins);

      await this.updateDaysOnLot();

      const warnings: string[] = [];
      if (skippedIncomplete > 0) {
        warnings.push(
          `${skippedIncomplete} row(s) had a valid VIN but were missing required fields (make/model/year); their details were not updated but they were protected from archiving.`,
        );
      }
      if (duplicateRowsInFeed > 0) {
        warnings.push(
          `${duplicateRowsInFeed} duplicate VIN row(s) inside the feed were collapsed (last occurrence wins).`,
        );
      }
      if (dedupeStats.removed > 0) {
        warnings.push(
          `${dedupeStats.removed} duplicate vehicle document(s) in the database were merged into their primary record (notes preserved).`,
        );
      }
      if (upsertStats.writeErrorCount > 0) {
        warnings.push(
          `${upsertStats.writeErrorCount} row(s) failed to write (see server logs).`,
        );
      }
      if (archiveStats.guardTripped) {
        warnings.push(archiveStats.guardMessage as string);
      }

      const result: SyncResult = {
        processed: rows.length,
        added: upsertStats.added,
        updated: upsertStats.updated,
        unchanged: upsertStats.unchanged,
        archived: archiveStats.archivedCount,
        skippedIncomplete,
        duplicateRowsInFeed,
        duplicatesMergedInDb: dedupeStats.removed,
        archiveGuardTripped: archiveStats.guardTripped,
        warnings,
      };

      syncLog.status = "COMPLETED";
      syncLog.endTime = new Date();
      syncLog.vehiclesProcessed = result.processed;
      syncLog.vehiclesAdded = result.added;
      syncLog.vehiclesUpdated = result.updated;
      syncLog.vehiclesDeleted = result.archived; // archived, not deleted — history retained
      if (warnings.length > 0) {
        syncLog.errorMessage = `Source: ${sourceLabel} | WARNINGS: ${warnings.join(" ")}`;
      }
      await syncLog.save();

      await cacheService.invalidateByPrefix("veh:");

      console.log(
        `[SyncService] Sync complete (${sourceLabel}) — ` +
          `processed:${result.processed} added:${result.added} ` +
          `updated:${result.updated} unchanged:${result.unchanged} ` +
          `archived:${result.archived}` +
          (warnings.length ? ` | warnings: ${warnings.join(" ")}` : ""),
      );

      return result;
    } catch (error: any) {
      syncLog.status = "FAILED";
      syncLog.errorMessage = error.message;
      syncLog.stackTrace = error.stack;
      syncLog.endTime = new Date();
      await syncLog.save();
      console.error(`[SyncService] Sync FAILED (${sourceLabel}):`, error);
      throw error;
    } finally {
      this.isLocked = false;
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  PHASE 1 — PARSE & VALIDATE
  // ──────────────────────────────────────────────────────────────────────────

  private collectFeedRows(
    stream: Readable,
  ): Promise<{ rows: NormalizedFeedRow[]; duplicateRowsInFeed: number }> {
    return new Promise((resolve, reject) => {
      // Keyed by VIN so duplicate rows inside a single feed collapse to one
      // record ("last row wins" — matches vendor behavior of appending fixes).
      const byVin = new Map<string, NormalizedFeedRow>();
      let duplicateRowsInFeed = 0;

      const parser = stream.pipe(
        parse({
          // Lowercase every header, then translate DealersCloud's CamelCase
          // column names into the keys normalizeRow() expects. Unmapped
          // headers pass through lowercased (harmless).
          columns: (header) =>
            header.map((h: string) => {
              const lower = h.trim().toLowerCase();
              return DC_HEADER_MAP[lower] || lower;
            }),
          skip_empty_lines: true,
          trim: true,
          relax_quotes: true,
          relax_column_count: true,
          skip_records_with_error: true,
          // Auto-detect the delimiter: DealersCloud has sent BOTH comma (.csv)
          // and tab (.txt). An array lets csv-parse pick whichever fits.
          delimiter: [",", "\t"],
        }),
      );

      parser.on("data", (raw: RawVehicleData) => {
        const row = this.normalizeRow(raw);
        if (!row) return;
        if (byVin.has(row.vin)) duplicateRowsInFeed++;
        byVin.set(row.vin, row);
      });

      parser.on("end", () => {
        resolve({ rows: Array.from(byVin.values()), duplicateRowsInFeed });
      });

      parser.on("error", (err) => reject(err));
      stream.on("error", (err) => reject(err));
    });
  }

  /**
   * Turns a raw feed row into a normalized document body. Returns null when
   * the row has no usable VIN. Rows with a valid VIN but missing required
   * fields are flagged `incomplete` — they still count as "present in feed"
   * (archive protection) but are not written to the database.
   */
  private normalizeRow(raw: RawVehicleData): NormalizedFeedRow | null {
    const parseNum = (val: string) => {
      if (!val) return undefined;
      const parsed = parseFloat(val.replace(/[^0-9.]/g, ""));
      return isNaN(parsed) ? 0 : parsed;
    };

    const parseBool = (val: string) => {
      if (!val) return false;
      const normalized = val.toLowerCase().trim();
      return (
        normalized === "yes" ||
        normalized === "true" ||
        normalized === "1" ||
        normalized === "y"
      );
    };

    const parseImages = (val: string) => {
      if (!val) return [];
      return val
        .split(/[|;,\s]+/)
        .map((url) => url.trim())
        .filter((url) => url.length > 0);
    };

    const cleanStock = (val: string) => {
      if (!val) return undefined;
      const trimmed = val.trim();
      return trimmed.length > 50 ? trimmed.substring(0, 50) : trimmed;
    };

    if (
      !raw.vin ||
      raw.vin.trim().toLowerCase() === "vin" ||
      raw.vin.trim().length < 5
    ) {
      return null;
    }

    const vin = raw.vin.trim().toUpperCase();

    const data = {
      vin,
      year: Math.floor(parseNum(raw.year) || 0),
      make: raw.make?.trim(),
      modelName: raw.model?.trim(),
      trim: raw.trim?.trim(),
      exteriorColor: raw["exterior color"]?.trim(),
      interiorColor: raw["interior color"]?.trim(),
      stockNumber: cleanStock(raw["stock number"]),
      vehicleType: raw.vehicletype?.trim(),

      price: parseNum(raw.price),
      mileage: parseNum(raw.mileage),
      engine: raw.engine?.trim(),
      transmission: raw["transmission type"]?.trim(),
      driveTrain: (raw as any)["drivetype"]?.trim(),
      fuelType: (raw as any)["fuel type"]?.trim(),
      doors: parseNum((raw as any)["doors"]),
      cost: parseNum((raw as any)["total cost"]),
      options: raw["installed options"]?.trim(),
      comments: raw["dealer comments on vehicle"]?.trim(),
      images: parseImages(raw["picture urls"]),
      vdpUrl: raw.vdp_vin_url?.trim(),

      certified: parseBool(raw.certified),
      isNewVehicle: parseBool(raw["is new"]),

      dealerId: raw["dealer id"]?.trim(),
      dealerName: raw["dealer name"]?.trim(),
      dealerAddress: raw["dealer street address"]?.trim(),
      dealerCity: raw["dealer city"]?.trim(),
      dealerState: raw["dealer state"]?.trim(),
      dealerZip: raw["dealer zip"]?.trim(),
      dealerEmail: raw["dealer crm email"]?.trim(),

      isDeleted: false,
      organizationId: ACTION_AUTO_ORG_ID,
    };

    // Schema requires year/make/modelName — a row missing them can't be
    // inserted or safely used to overwrite an existing record.
    const incomplete = !data.make || !data.modelName || !(data.year > 0);

    return { vin, data, incomplete };
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  PHASE 2 — UPSERT BY VIN
  // ──────────────────────────────────────────────────────────────────────────

  private async applyUpserts(rows: NormalizedFeedRow[]): Promise<{
    added: number;
    updated: number;
    unchanged: number;
    writeErrorCount: number;
  }> {
    const now = new Date();

    if (rows.length === 0) {
      return { added: 0, updated: 0, unchanged: 0, writeErrorCount: 0 };
    }

    const vins = rows.map((r) => r.vin);

    // VIN is globally unique in the schema, so the existence lookup is by VIN
    // (matches previous behavior). Everything written is stamped with the
    // Action Auto org id. The case-insensitive collation (strength 2) makes
    // sure a legacy lowercase-VIN document is FOUND and updated (its VIN is
    // normalized to uppercase by the $set) instead of a second, duplicate
    // uppercase document being inserted next to it.
    const existingDocs = await Vehicle.find({ vin: { $in: vins } })
      .collation({ locale: "en", strength: 2 })
      .lean();
    const existingByVin = new Map<string, any>(
      existingDocs.map((doc: any) => [
        String(doc.vin).trim().toUpperCase(),
        doc,
      ]),
    );

    const bulkOps: any[] = [];
    const auditDocs: any[] = [];
    let added = 0;
    let updated = 0;
    let unchanged = 0;

    for (const row of rows) {
      const existing = existingByVin.get(row.vin);

      if (!existing) {
        // ── NEW VEHICLE ────────────────────────────────────────────────────
        // Pre-generate the _id so the CREATE audit entry can reference the
        // real document even though the insert happens in the bulk batch.
        const newId = new mongoose.Types.ObjectId();
        const initialPrice =
          row.data.price !== undefined && row.data.price !== null
            ? Number(row.data.price)
            : undefined;

        bulkOps.push({
          insertOne: {
            document: {
              _id: newId,
              ...row.data,
              status: "Ready for Sale",
              isArchived: false,
              archivedAt: null,
              lastSeenInFeedAt: now,
              ...(initialPrice !== undefined && Number.isFinite(initialPrice)
                ? {
                    priceUpdatedAt: now,
                    priceHistory: [
                      {
                        previousPrice: null,
                        newPrice: initialPrice,
                        changedAt: now,
                        source: "DealersCloud",
                      },
                    ],
                  }
                : {}),
            },
          },
        });
        auditDocs.push({
          entityType: "Vehicle",
          entityId: newId,
          action: "CREATE",
          reason: "New vehicle found in DealersCloud feed",
          changes: { ...row.data, status: "Ready for Sale" },
          organizationId: ACTION_AUTO_ORG_ID,
        });
        added++;
        continue;
      }

      // ── EXISTING VEHICLE — update in place, never duplicate ──────────────
      const update: Record<string, any> = {
        ...row.data,
        lastSeenInFeedAt: now,
        // Present in the latest feed ⇒ always active inventory again.
        isArchived: false,
        archivedAt: null,
        archiveReason: null,
      };

      const wasArchived = existing.isArchived === true;
      const reactivate =
        !existing.manualStatusLock &&
        existing.status === "Sold";

      const existingPrice =
        existing.price !== undefined && existing.price !== null
          ? Number(existing.price)
          : undefined;
      const incomingPrice =
        row.data.price !== undefined && row.data.price !== null
          ? Number(row.data.price)
          : undefined;
      const priceChanged =
        incomingPrice !== undefined &&
        Number.isFinite(incomingPrice) &&
        incomingPrice !== existingPrice;

      if (priceChanged) {
        update.priceUpdatedAt = now;
      }

      if (reactivate) {
        update.status = "Ready for Sale";
        update.dateSold = null;
      }
      // manualStatusLock vehicles NEVER have their status touched by the feed.

      // Change detection for audit trail (same relevant-key diff as before).
      const relevantKeys = Object.keys(row.data).filter(
        (k) => k !== "isDeleted" && k !== "organizationId",
      );
      const oldData: Record<string, any> = {};
      relevantKeys.forEach((k) => {
        oldData[k] = existing[k];
      });
      const newData: Record<string, any> = {};
      relevantKeys.forEach((k) => {
        newData[k] = row.data[k];
      });
      const changes = diff(oldData, newData);

      if (changes || reactivate || wasArchived) {
        const updateOperations: Record<string, any> = {
          $set: update,
        };

        if (priceChanged && incomingPrice !== undefined) {
          updateOperations.$push = {
            priceHistory: {
              previousPrice: existingPrice ?? null,
              newPrice: incomingPrice,
              changedAt: now,
              source: "DealersCloud",
            },
          };
        }

        bulkOps.push({
          updateOne: {
            filter: { _id: existing._id },
            update: updateOperations,
          },
        });
        auditDocs.push({
          entityType: "Vehicle",
          entityId: existing._id,
          action: "UPDATE",
          reason: wasArchived
            ? "Vehicle returned to DealersCloud feed — restored from Archive"
            : reactivate
              ? "Vehicle returned to DealersCloud feed — re-activated"
              : priceChanged
                ? "Vehicle price updated from DealersCloud feed"
                : "Data updated from DealersCloud feed",
          changes: changes || { status: "Ready for Sale", isArchived: false },
          organizationId: ACTION_AUTO_ORG_ID,
        });
        updated++;
      } else {
        // Nothing material changed — still stamp feed presence (cheap $set)
        // so operators can audit exactly when each VIN was last confirmed.
        bulkOps.push({
          updateOne: {
            filter: { _id: existing._id },
            update: { $set: { lastSeenInFeedAt: now } },
          },
        });
        unchanged++;
      }
    }

    let writeErrorCount = 0;
    try {
      if (bulkOps.length > 0) {
        await Vehicle.bulkWrite(bulkOps, { ordered: false });
      }
    } catch (err: any) {
      // ordered:false — successful ops are already persisted. Duplicate-key
      // races (two syncs would be prevented by the lock, but belt-and-braces)
      // and per-row cast errors surface here without failing the whole run.
      const writeErrors = err?.writeErrors ?? err?.result?.writeErrors ?? [];
      if (Array.isArray(writeErrors) && writeErrors.length > 0) {
        writeErrorCount = writeErrors.length;
        console.error(
          `[SyncService] ${writeErrors.length} bulkWrite row error(s):`,
          writeErrors.map((e: any) => e?.errmsg || e?.message).slice(0, 5),
        );
      } else {
        // Not a per-row problem (e.g. connection loss) — abort BEFORE the
        // archive pass so a broken commit can never trigger archiving.
        throw err;
      }
    }

    try {
      if (auditDocs.length > 0) {
        await AuditLog.insertMany(auditDocs, { ordered: false });
      }
    } catch (err) {
      console.error("[SyncService] Failed to write audit logs:", err);
    }

    return { added, updated, unchanged, writeErrorCount };
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  PHASE 3 — ARCHIVE PASS (full-replace semantics)
  //
  //  DealersCloud is the ONLY inventory source for this org: every successful
  //  feed is the complete current lot. Any active vehicle whose VIN is NOT in
  //  the confirmed feed is moved to Archive/Sold — a soft state that keeps the
  //  document, its notes, images, and audit history fully intact.
  //
  //  Rules:
  //   • Runs ONLY after Phase 2 committed (a failed/partial import can never
  //     archive anything — runSync aborts before reaching this point).
  //   • VINs are normalized identically on both sides, so formatting can
  //     never wrongly keep or wrongly archive a car.
  //   • manualStatusLock + non-Sold ⇒ NEVER auto-archived (a manager's
  //     explicit override always wins over the feed).
  //   • manualStatusLock + Sold ⇒ archived with status preserved (the manager
  //     already said it's sold; archiving just files it correctly).
  //   • Guard: refuses to archive more than MAX_ARCHIVE_PERCENT of the active
  //     non-Sold inventory in one run (partial-feed protection). Vehicles
  //     already marked Sold are always safe to archive (pure bookkeeping) and
  //     don't count against the guard.
  // ──────────────────────────────────────────────────────────────────────────

  private async archiveMissingVehicles(feedVins: Set<string>): Promise<{
    archivedCount: number;
    guardTripped: boolean;
    guardMessage?: string;
  }> {
    const now = new Date();
    const normalizedFeedVins = Array.from(feedVins).map((v) =>
      v.trim().toUpperCase(),
    );

    // Case-insensitive collation: a legacy lowercase-VIN document whose car
    // IS in the feed (uppercase) must never fall through the $nin and be
    // wrongly archived because of casing.
    const candidates = await Vehicle.find({
      organizationId: ACTION_AUTO_ORG_ID, // strict org scope
      isDeleted: false,
      isArchived: { $ne: true },
      vin: { $nin: normalizedFeedVins },
    })
      .collation({ locale: "en", strength: 2 })
      .select("_id vin status manualStatusLock dateSold")
      .lean();

    if (candidates.length === 0) {
      return { archivedCount: 0, guardTripped: false };
    }

    // Manager overrides win: locked vehicles that are NOT Sold stay active.
    const eligible = candidates.filter(
      (v: any) => !(v.manualStatusLock && v.status !== "Sold"),
    );

    const soldCandidates = eligible.filter((v: any) => v.status === "Sold");
    let activeCandidates = eligible.filter((v: any) => v.status !== "Sold");

    // ── Partial-feed guard ───────────────────────────────────────────────
    let guardTripped = false;
    let guardMessage: string | undefined;

    if (activeCandidates.length > 0 && MAX_ARCHIVE_PERCENT < 100) {
      const totalActiveNonSold = await Vehicle.countDocuments({
        organizationId: ACTION_AUTO_ORG_ID,
        isDeleted: false,
        isArchived: { $ne: true },
        status: { $ne: "Sold" },
      });

      const pct =
        totalActiveNonSold > 0
          ? (activeCandidates.length / totalActiveNonSold) * 100
          : 0;

      if (pct > MAX_ARCHIVE_PERCENT) {
        guardTripped = true;
        guardMessage =
          `ARCHIVE GUARD: feed would archive ${activeCandidates.length} of ` +
          `${totalActiveNonSold} active vehicles (${pct.toFixed(1)}% > ` +
          `${MAX_ARCHIVE_PERCENT}% limit). Active vehicles were NOT archived ` +
          `— this usually means a truncated/partial upload. If the shrink is ` +
          `intentional, raise SYNC_MAX_ARCHIVE_PERCENT and re-upload the feed.`;
        console.warn(`[SyncService] ${guardMessage}`);
        activeCandidates = [];
      }
    }

    const toArchive = [...soldCandidates, ...activeCandidates];
    if (toArchive.length === 0) {
      return { archivedCount: 0, guardTripped, guardMessage };
    }

    const bulkOps = toArchive.map((vehicle: any) => {
      const set: Record<string, any> = {
        isArchived: true,
        archivedAt: now,
        archiveReason: ARCHIVE_REASON_FEED,
      };
      // Non-locked vehicles leaving the feed are considered sold off-platform.
      if (!vehicle.manualStatusLock && vehicle.status !== "Sold") {
        set.status = "Sold";
        set.dateSold = now;
      }
      return {
        updateOne: {
          filter: { _id: vehicle._id },
          update: { $set: set },
        },
      };
    });

    await Vehicle.bulkWrite(bulkOps, { ordered: false });

    try {
      await AuditLog.insertMany(
        toArchive.map((vehicle: any) => ({
          entityType: "Vehicle",
          entityId: vehicle._id,
          action: "UPDATE",
          reason: `${ARCHIVE_REASON_FEED} — moved to Archive/Sold`,
          changes: {
            isArchived: true,
            ...(vehicle.status !== "Sold" && !vehicle.manualStatusLock
              ? { status: "Sold" }
              : {}),
          },
          organizationId: ACTION_AUTO_ORG_ID,
        })),
        { ordered: false },
      );
    } catch (err) {
      console.error("[SyncService] Failed to write archive audit logs:", err);
    }

    console.log(
      `[SyncService] Archive pass — archived:${toArchive.length} ` +
        `(previously Sold:${soldCandidates.length}, ` +
        `newly sold-out:${activeCandidates.length})` +
        (guardTripped ? " [GUARD TRIPPED — active archiving skipped]" : ""),
    );

    return { archivedCount: toArchive.length, guardTripped, guardMessage };
  }

  // ──────────────────────────────────────────────────────────────────────────
  //  MAINTENANCE
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Merges duplicate vehicle documents that share the same normalized VIN.
   *
   * How duplicates happen: the `vin` unique index is case-SENSITIVE, and the
   * legacy import didn't normalize casing — so "1hgcm82633a" and
   * "1HGCM82633A" could both exist as separate documents for the same car.
   * (The unique index also never builds at all if duplicates predate it,
   * silently disabling the constraint.)
   *
   * Merge strategy (idempotent, runs every sync — a no-op when clean):
   *  • KEEPER  = the "richest" document: not deleted > not archived > has
   *    notes > has an assigned user, tie-broken by most recently updated.
   *  • Keeper's VIN is normalized to uppercase.
   *  • Losers' notes are merged into the keeper (history preserved).
   *  • Losers are soft-deleted + archived (never hard-deleted) and their VIN
   *    gets a "-DUPMERGED-<id>" suffix so the unique index can finally build
   *    cleanly. The original VIN is recorded in the AuditLog entry.
   */
  private async dedupeVehicles(): Promise<{ groups: number; removed: number }> {
    const dupGroups: Array<{ _id: string; count: number; ids: any[] }> =
      await Vehicle.aggregate([
        { $match: { organizationId: ACTION_AUTO_ORG_ID } },
        {
          $group: {
            _id: { $toUpper: { $trim: { input: "$vin" } } },
            count: { $sum: 1 },
            ids: { $push: "$_id" },
          },
        },
        { $match: { count: { $gt: 1 } } },
      ]);

    if (dupGroups.length === 0) {
      return { groups: 0, removed: 0 };
    }

    const now = new Date();
    const bulkOps: any[] = [];
    const auditDocs: any[] = [];
    let removed = 0;

    for (const group of dupGroups) {
      const docs = await Vehicle.find({ _id: { $in: group.ids } }).lean();
      if (docs.length < 2) continue;

      const score = (d: any) =>
        (d.isDeleted ? 0 : 8) +
        (d.isArchived ? 0 : 4) +
        ((d.notes?.length ?? 0) > 0 ? 2 : 0) +
        (d.assignedTo ? 1 : 0);

      const sorted = [...docs].sort((a: any, b: any) => {
        const diffScore = score(b) - score(a);
        if (diffScore !== 0) return diffScore;
        return (
          new Date(b.updatedAt || 0).getTime() -
          new Date(a.updatedAt || 0).getTime()
        );
      });

      const keeper: any = sorted[0];
      const losers: any[] = sorted.slice(1);
      const normVin = String(group._id);

      // Merge losers' notes into the keeper (skip exact text+date repeats).
      const keeperNotes: any[] = Array.isArray(keeper.notes)
        ? [...keeper.notes]
        : [];
      const seen = new Set(
        keeperNotes.map(
          (n: any) => `${n.text}|${new Date(n.date || 0).getTime()}`,
        ),
      );
      for (const loser of losers) {
        for (const n of loser.notes ?? []) {
          const sig = `${n.text}|${new Date(n.date || 0).getTime()}`;
          if (!seen.has(sig)) {
            seen.add(sig);
            keeperNotes.push(n);
          }
        }
      }

      // Price history is also part of the vehicle's retained history. When
      // legacy duplicate VIN documents are merged, keep audit entries from all
      // copies instead of silently discarding the loser's pricing log.
      const mergedPriceHistory: any[] = [];
      const seenPriceHistory = new Set<string>();
      for (const doc of [keeper, ...losers]) {
        for (const entry of doc.priceHistory ?? []) {
          const changedAtMs = new Date(entry.changedAt || 0).getTime();
          const sig = [
            entry.previousPrice ?? "null",
            entry.newPrice ?? "null",
            changedAtMs,
            entry.source ?? "",
          ].join("|");
          if (!seenPriceHistory.has(sig)) {
            seenPriceHistory.add(sig);
            mergedPriceHistory.push(entry);
          }
        }
      }
      mergedPriceHistory.sort(
        (a: any, b: any) =>
          new Date(a.changedAt || 0).getTime() -
          new Date(b.changedAt || 0).getTime(),
      );

      const latestTrackedPriceAt = mergedPriceHistory.length
        ? mergedPriceHistory[mergedPriceHistory.length - 1]?.changedAt
        : keeper.priceUpdatedAt;

      bulkOps.push({
        updateOne: {
          filter: { _id: keeper._id },
          update: {
            $set: {
              vin: normVin,
              notes: keeperNotes,
              priceHistory: mergedPriceHistory,
              ...(latestTrackedPriceAt
                ? { priceUpdatedAt: latestTrackedPriceAt }
                : {}),
            },
          },
        },
      });

      for (const loser of losers) {
        bulkOps.push({
          updateOne: {
            filter: { _id: loser._id },
            update: {
              $set: {
                // Suffix frees the (case-insensitive) logical VIN so the
                // unique index can build; original VIN kept in the audit log.
                vin: `${normVin}-DUPMERGED-${String(loser._id)}`,
                isDeleted: true,
                isArchived: true,
                archivedAt: now,
                archiveReason: `Duplicate of VIN ${normVin} — merged into primary record`,
              },
            },
          },
        });
        auditDocs.push({
          entityType: "Vehicle",
          entityId: loser._id,
          action: "UPDATE",
          reason: `Duplicate VIN merged — this document was a duplicate of ${normVin} (kept ${String(keeper._id)})`,
          changes: {
            originalVin: loser.vin,
            mergedInto: keeper._id,
            isDeleted: true,
            isArchived: true,
          },
          organizationId: ACTION_AUTO_ORG_ID,
        });
        removed++;
      }
    }

    if (bulkOps.length > 0) {
      await Vehicle.bulkWrite(bulkOps, { ordered: false });
    }
    try {
      if (auditDocs.length > 0) {
        await AuditLog.insertMany(auditDocs, { ordered: false });
      }
    } catch (err) {
      console.error("[SyncService] Failed to write dedupe audit logs:", err);
    }

    console.log(
      `[SyncService] Dedupe pass — merged ${removed} duplicate document(s) across ${dupGroups.length} VIN group(s).`,
    );

    return { groups: dupGroups.length, removed };
  }

  /**
   * Bulk updates daysOnLot for all active vehicles in the target organization.
   */
  private async updateDaysOnLot() {
    try {
      const now = new Date();
      const vehicles = await Vehicle.find({
        organizationId: ACTION_AUTO_ORG_ID,
        status: { $ne: "Sold" },
        isArchived: { $ne: true },
        isDeleted: false,
      })
        .select("_id dateAdded createdAt")
        .lean();

      const bulkOps = vehicles.map((vehicle: any) => {
        const days = Math.floor(
          (now.getTime() -
            new Date(vehicle.dateAdded || vehicle.createdAt).getTime()) /
            (1000 * 60 * 60 * 24),
        );
        return {
          updateOne: {
            filter: { _id: vehicle._id },
            update: { $set: { daysOnLot: Math.max(0, days) } },
          },
        };
      });

      if (bulkOps.length > 0) {
        await Vehicle.bulkWrite(bulkOps);
        console.log(
          `[SyncService] Updated daysOnLot for ${bulkOps.length} vehicles.`,
        );
      }
    } catch (err) {
      console.error("[SyncService] Failed to update daysOnLot:", err);
    }
  }
}

export default new SyncService();