import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * LinkedAccount
 * -------------
 * One document per (user, provider) connection. The `isPrimary` account is the
 * one whose balance drives the SuprahPay wallet (balance REPLACE model — see
 * linkedAccount.service.syncBalances).
 *
 * Currently Wise-only: Wise exposes a real balance API, so its balance can
 * mirror into the wallet. The `provider` field is kept as an enum so another
 * balance-capable provider can be added later without a schema rewrite.
 *
 * Tokens are stored with `select: false` so they never leak through a normal
 * query; fetch them explicitly with `.select("+accessToken +refreshToken")`.
 */

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

  // Provider profile
  profileId: string;
  profileType: "personal" | "business";
  fullName: string;
  email: string;

  // OAuth tokens (never returned by default)
  accessToken: string;
  refreshToken: string;
  tokenExpiry: Date;

  balances: ILinkedBalance[];
  isActive: boolean;
  isPrimary: boolean; // drives the wallet balance
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

// A user can only have one connection per provider.
LinkedAccountSchema.index({ userId: 1, provider: 1 }, { unique: true });

export default mongoose.model<ILinkedAccount>(
  "LinkedAccount",
  LinkedAccountSchema
);