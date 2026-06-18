import mongoose, { Document, Schema, Model } from "mongoose";

/**
 * FeedConfig
 * ----------
 * Maps an inventory feed (identified by `feedId`) to a single organization,
 * and holds everything needed to fetch + parse that feed.
 *
 * `feedId` is the token DealersCloud uses to identify *which dealer* a feed
 * belongs to. Confirm with DealersCloud whether they issue the ID to you or
 * expect you to supply it — either way it is the join key between an incoming
 * feed and one of your organizations.
 *
 * FTP credentials are optional here: if omitted, the service falls back to the
 * DEALERSCLOUD_FTP_* environment variables (fine for a single-tenant setup).
 * Store them per-feed once you onboard multiple dealerships.
 */
export interface IFeedConfig extends Document {
  feedId: string;
  organizationId: string;
  provider: string; // e.g. "dealerscloud"
  active: boolean;

  // How the file reaches you: "pull" = you fetch from their FTP,
  // "push" = they drop it into an FTP inbox you host (you watch a folder).
  mode: "pull" | "push";

  // FTP connection (optional — falls back to env when blank)
  ftpHost?: string;
  ftpPort?: number;
  ftpUser?: string;
  ftpPassword?: string;
  ftpSecure?: boolean;
  remoteFilePath?: string; // e.g. "DealerCloud.txt" or "/exports/{feedId}.txt"

  // Parsing
  delimiter?: "auto" | "\t" | "," | "|";
  // Override automatic header detection: maps a raw feed column header
  // (as it appears in the file) to a Vehicle field name.
  columnMap?: Record<string, string>;

  // When a vehicle in the DB is NOT present in the latest feed, what to do.
  // "ignore" leaves it untouched; "mark-sold" flips status to Sold;
  // "soft-delete" sets isDeleted = true. Default: ignore (safest).
  missingStrategy: "ignore" | "mark-sold" | "soft-delete";

  // Default status applied to incoming vehicles when the feed has no status
  // column. Marketplace listings must be "Ready for Sale" to appear in the shop.
  defaultStatus:
    | "In Recon"
    | "Ready for Sale"
    | "Sold"
    | "In Transit";

  lastSyncAt?: Date;
  lastSyncStatus?: "success" | "error";
  lastSyncMessage?: string;
  lastSyncCounts?: {
    parsed: number;
    inserted: number;
    updated: number;
    missing: number;
  };

  createdAt: Date;
  updatedAt: Date;
}

const FeedConfigSchema: Schema<IFeedConfig> = new Schema(
  {
    feedId: { type: String, required: true, unique: true, trim: true, index: true },
    organizationId: { type: String, required: true, index: true },
    provider: { type: String, default: "dealerscloud", trim: true },
    active: { type: Boolean, default: true },

    mode: { type: String, enum: ["pull", "push"], default: "pull" },

    ftpHost: { type: String, trim: true },
    ftpPort: { type: Number },
    ftpUser: { type: String, trim: true },
    ftpPassword: { type: String, trim: true },
    ftpSecure: { type: Boolean, default: false },
    remoteFilePath: { type: String, trim: true, default: "DealerCloud.txt" },

    delimiter: {
      type: String,
      enum: ["auto", "\t", ",", "|"],
      default: "auto",
    },
    columnMap: { type: Schema.Types.Mixed, default: {} },

    missingStrategy: {
      type: String,
      enum: ["ignore", "mark-sold", "soft-delete"],
      default: "ignore",
    },
    defaultStatus: {
      type: String,
      enum: ["In Recon", "Ready for Sale", "Sold", "In Transit"],
      default: "Ready for Sale",
    },

    lastSyncAt: { type: Date },
    lastSyncStatus: { type: String, enum: ["success", "error"] },
    lastSyncMessage: { type: String },
    lastSyncCounts: {
      parsed: { type: Number },
      inserted: { type: Number },
      updated: { type: Number },
      missing: { type: Number },
    },
  },
  { timestamps: true },
);

const FeedConfig: Model<IFeedConfig> = mongoose.model<IFeedConfig>(
  "FeedConfig",
  FeedConfigSchema,
);

export default FeedConfig;