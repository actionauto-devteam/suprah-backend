import mongoose, { Document, Schema, Model } from "mongoose";

export interface IFeedConfig extends Document {
  feedId: string;
  organizationId: string;
  provider: string;
  active: boolean;

  mode: "pull" | "push";

  ftpHost?: string;
  ftpPort?: number;
  ftpUser?: string;
  ftpPassword?: string;
  ftpSecure?: boolean;
  remoteFilePath?: string;

  delimiter?: "auto" | "\t" | "," | "|";
  columnMap?: Record<string, string>;

  missingStrategy: "ignore" | "mark-sold" | "soft-delete";

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