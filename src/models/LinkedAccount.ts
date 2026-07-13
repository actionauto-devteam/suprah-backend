import mongoose, { Schema, Document, Types } from "mongoose";


export type LinkedProvider = "wise";

export interface ILinkedBalance {
  currency: string;
  amount: number;
  reservedAmount: number;
  lastUpdated: Date;
}

export interface ILinkedAccount extends Document {
  userId: Types.ObjectId;
  provider: LinkedProvider;

  profileId: string;
  profileType: "personal" | "business";
  fullName: string;
  email: string;

  accessToken: string;
  refreshToken: string;
  tokenExpiry: Date;

  balances: ILinkedBalance[];
  isActive: boolean;
  isPrimary: boolean;
  lastSyncedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const LinkedAccountSchema = new Schema<ILinkedAccount>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: ["wise"],
      required: true,
    },
    profileId: { type: String, required: true },
    profileType: {
      type: String,
      enum: ["personal", "business"],
      default: "personal",
    },
    fullName: { type: String, required: true },
    email: { type: String, required: true },

    accessToken: { type: String, required: true, select: false },
    refreshToken: { type: String, select: false },
    tokenExpiry: { type: Date, required: true },

    balances: [
      {
        currency: String,
        amount: Number,
        reservedAmount: { type: Number, default: 0 },
        lastUpdated: { type: Date, default: Date.now },
      },
    ],
    isActive: { type: Boolean, default: true },
    isPrimary: { type: Boolean, default: false },
    lastSyncedAt: { type: Date },
  },
  { timestamps: true }
);

LinkedAccountSchema.index({ userId: 1, provider: 1 }, { unique: true });

export default mongoose.model<ILinkedAccount>(
  "LinkedAccount",
  LinkedAccountSchema
);