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

/**
 * The internal organization ID for Action Auto Utah.
 * All vehicles synced via FTP are owned by this org.
 */
const ACTION_AUTO_ORG_ID =
  process.env.ACTION_AUTO_ORG_ID || "69d6a26499bee4596c1ea94c";

/**
 * DealersCloud sends single-word CamelCase headers (e.g. "InternetPrice",
 * "StockNumber", "VehicleimagesURL", "DealershipCity"). Our downstream mapping
 * in syncVehicle() expects a specific set of lowercased keys. This table maps
 * DealersCloud's actual header (lowercased) -> the key our code reads.
 *
 * Confirmed against a real dealerscloud.csv export (30 columns, 718 rows).
 * Any DC column not listed here is passed through unchanged (already lowercased).
 */
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

export class SyncService {
  private isLocked = false;

  async syncInventory(): Promise<any> {
    if (this.isLocked) {
      console.log("[SyncService] Sync already in progress. Skipping...");
      return { message: "Sync already in progress" };
    }

    const startTime = new Date();
    const syncLog = await SyncLog.create({
      startTime,
      status: "RUNNING",
      organizationId: ACTION_AUTO_ORG_ID,
    });

    this.isLocked = true;
    try {
      const stream = await ftpService.getInventoryStream();
      const result = await this.processStream(stream, syncLog);

      await this.updateDaysOnLot();

      syncLog.status = "COMPLETED";
      syncLog.endTime = new Date();
      await syncLog.save();

      await cacheService.invalidateByPrefix("veh:");
      console.log(`[SyncService] Sync complete - invalidated vehicle cache.`);

      return result;
    } catch (error: any) {
      syncLog.status = "FAILED";
      syncLog.errorMessage = error.message;
      syncLog.stackTrace = error.stack;
      syncLog.endTime = new Date();
      await syncLog.save();
      throw error;
    } finally {
      this.isLocked = false;
    }
  }

  /**
   * Syncs a single vehicle record
   */
  private async syncVehicle(raw: RawVehicleData) {
    const existingVehicle = await Vehicle.findOne({ vin: raw.vin });

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

    // DealersCloud's VehicleimagesURL is a comma-separated list of URLs; split
    // on comma/pipe/semicolon/whitespace to be safe across formats.
    const parseImages = (val: string) => {
      if (!val) return [];
      return val
        .split(/[|;,\s]+/)
        .map((url) => url.trim())
        .filter((url) => url.length > 0);
    };

    // Data Sanitization & Validation
    if (
      !raw.vin ||
      raw.vin.trim().toLowerCase() === "vin" ||
      raw.vin.length < 5
    ) {
      return { type: "none" }; // Skip headers and empty rows
    }

    const cleanStock = (val: string) => {
      if (!val) return undefined;
      const trimmed = val.trim();
      return trimmed.length > 50 ? trimmed.substring(0, 50) : trimmed;
    };

    const vehicleData = {
      vin: raw.vin.trim().toUpperCase(),
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

      // Dealer info (drives the `location` field shown in the shop)
      dealerId: raw["dealer id"]?.trim(),
      dealerName: raw["dealer name"]?.trim(),
      dealerAddress: raw["dealer street address"]?.trim(),
      dealerCity: raw["dealer city"]?.trim(),
      dealerState: raw["dealer state"]?.trim(),
      dealerZip: raw["dealer zip"]?.trim(),
      dealerEmail: raw["dealer crm email"]?.trim(),

      isDeleted: false, // Re-activate if it was previously removed

      // Multi-tenant binding
      organizationId: ACTION_AUTO_ORG_ID,
    };

    if (!existingVehicle) {
      // New vehicle from the DealersCloud feed is retail-ready -> "Ready for Sale"
      // on insert only (so manual status changes on existing cars aren't clobbered).
      const newVehicle = await Vehicle.create({
        ...vehicleData,
        status: "Ready for Sale",
      });

      await AuditLog.create({
        entityType: "Vehicle",
        entityId: newVehicle._id,
        action: "CREATE",
        reason: "New vehicle found in DealersCloud feed",
        changes: { ...vehicleData, status: "Ready for Sale" },
        organizationId: ACTION_AUTO_ORG_ID,
      });

      return { type: "added" };
    }

    // A vehicle that reappears in the feed should return to the shop even if a
    // previous run marked it Sold (because it was briefly absent). Re-activate it.
    const reactivate =
      existingVehicle.status === "Sold" && !existingVehicle.manualStatusLock;

    const oldData: any = {};
    const relevantKeys = Object.keys(vehicleData).filter(
      (k) => k !== "isDeleted" && k !== "organizationId",
    );

    // Respect Manual Lock for Status
    if (existingVehicle.manualStatusLock) {
      delete (vehicleData as any).status;
    }

    relevantKeys.forEach((k) => {
      oldData[k] = (existingVehicle as any)[k];
    });

    const changes = diff(oldData, vehicleData);

    if (changes || reactivate) {
      const update: any = { ...vehicleData };
      if (reactivate) {
        update.status = "Ready for Sale";
        update.dateSold = null;
      }

      await Vehicle.updateOne({ _id: existingVehicle._id }, update);

      await AuditLog.create({
        entityType: "Vehicle",
        entityId: existingVehicle._id,
        action: "UPDATE",
        reason: reactivate
          ? "Vehicle returned to DealersCloud feed - re-activated"
          : "Data updated from DealersCloud feed",
        changes: changes || { status: "Ready for Sale" },
        organizationId: ACTION_AUTO_ORG_ID,
      });

      return { type: "updated" };
    }

    return { type: "none" };
  }

  /**
   * Process an inventory file directly from R2 (called by FTP server STOR event)
   */
  async processR2File(key: string): Promise<any> {
    const startTime = new Date();
    const syncLog = await SyncLog.create({
      startTime,
      status: "RUNNING",
      organizationId: ACTION_AUTO_ORG_ID,
      errorMessage: `Source: R2://${key}`,
    });

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

    try {
      const command = new GetObjectCommand({
        Bucket: config.r2.buckets.ftp,
        Key: key,
      });
      const response = await s3Client.send(command);
      const stream = response.Body as Readable;

      const result = await this.processStream(stream, syncLog);

      syncLog.status = "COMPLETED";
      syncLog.endTime = new Date();
      await syncLog.save();

      await cacheService.invalidateByPrefix("veh:");
      return result;
    } catch (error: any) {
      syncLog.status = "FAILED";
      syncLog.errorMessage = error.message;
      syncLog.endTime = new Date();
      await syncLog.save();
      throw error;
    }
  }

  /**
   * Shared streaming processor to handle CSV/TSV without loading full file into memory
   */
  private async processStream(stream: Readable, syncLog: any): Promise<any> {
    return new Promise((resolve, reject) => {
      let processed = 0;
      let added = 0;
      let updated = 0;
      const csvVins = new Set<string>();

      const parser = stream.pipe(
        parse({
          // Lowercase every header, then translate DealersCloud's CamelCase
          // column names into the keys syncVehicle() expects. Unmapped headers
          // pass through lowercased (harmless).
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

      parser.on("data", async (rawVehicle) => {
        parser.pause();
        try {
          const result = await this.syncVehicle(rawVehicle);
          if (result.type === "added") added++;
          if (result.type === "updated") updated++;
          if (rawVehicle.vin) csvVins.add(rawVehicle.vin.trim().toUpperCase());
          processed++;
        } catch (err) {
          console.error(
            "[SyncService] Stream processing error for vehicle:",
            err,
          );
        }
        parser.resume();
      });

      parser.on("end", async () => {
        try {
          // SAFETY: only run deletions if the feed actually produced vehicles.
          // A malformed/empty parse (0 VINs) must never wipe the inventory.
          let deletedCount = 0;
          if (csvVins.size > 0) {
            const deletionResult = await this.handleDeletions(csvVins);
            deletedCount = deletionResult.deletedCount;
          } else {
            console.warn(
              "[SyncService] Feed produced 0 VINs - skipping deletions to protect existing inventory. Check the file's delimiter/headers.",
            );
          }

          syncLog.vehiclesProcessed = processed;
          syncLog.vehiclesAdded = added;
          syncLog.vehiclesUpdated = updated;
          syncLog.vehiclesDeleted = deletedCount;

          console.log(
            `[SyncService] Parsed feed - processed:${processed} added:${added} updated:${updated} soldOut:${deletedCount}`,
          );

          resolve({
            added,
            updated,
            deleted: deletedCount,
            processed,
          });
        } catch (err) {
          reject(err);
        }
      });

      parser.on("error", (err) => {
        reject(err);
      });
    });
  }

  /**
   * @deprecated Use processR2File or processStream
   */
  async processLocalFile(filePath: string): Promise<any> {
    const fs = require("fs");
    const stream = fs.createReadStream(filePath);
    return this.processStream(stream, { save: () => {} });
  }

  /**
   * FULL-REPLACE deletion pass.
   *
   * DealersCloud is the ONLY inventory source for this org, so any active
   * vehicle whose VIN is NOT in today's feed is no longer for sale -> mark Sold
   * (kept in the DB for history, hidden from the shop).
   *
   * VINs are normalized (uppercase + trim) on BOTH sides so a formatting
   * difference can never cause a car to be wrongly kept or wrongly sold.
   *
   * manualStatusLock vehicles are left untouched (respects manual overrides).
   */
  private async handleDeletions(csvVins: Set<string>) {
    // Normalize the feed VINs (defensive — syncVehicle already uppercases,
    // but this guarantees it regardless of caller).
    const normalizedFeedVins = Array.from(csvVins).map((v) =>
      v.trim().toUpperCase(),
    );

    const vehiclesToMarkSold = await Vehicle.find({
      vin: { $nin: normalizedFeedVins },
      organizationId: ACTION_AUTO_ORG_ID, // Strict org scope
      status: { $ne: "Sold" },
      manualStatusLock: { $ne: true },
      isDeleted: false,
    });

    for (const vehicle of vehiclesToMarkSold) {
      vehicle.status = "Sold";
      vehicle.dateSold = new Date();
      await vehicle.save();

      await AuditLog.create({
        entityType: "Vehicle",
        entityId: vehicle._id,
        action: "UPDATE",
        reason:
          "Vehicle no longer present in DealersCloud source feed - marked Sold",
        changes: { status: "Sold" },
        organizationId: ACTION_AUTO_ORG_ID,
      });
    }

    return { deletedCount: vehiclesToMarkSold.length };
  }

  /**
   * Bulk updates daysOnLot for all vehicles in the target organization.
   */
  private async updateDaysOnLot() {
    try {
      const now = new Date();
      const vehicles = await Vehicle.find({
        organizationId: ACTION_AUTO_ORG_ID,
        status: { $ne: "Sold" },
        isDeleted: false,
      });

      const bulkOps = vehicles.map((vehicle) => {
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