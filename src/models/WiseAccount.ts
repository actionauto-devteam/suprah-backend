import mongoose, { Schema, Document } from "mongoose";

export interface IWiseAccount extends Document {
  userId: string;
  profileId: string;
  profileType: "personal" | "business";
  fullName: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiry: Date;
  balances: Array<{
    currency: string;
    amount: number;
    reservedAmount: number;
    lastUpdated: Date;
  }>;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const WiseAccountSchema = new Schema<IWiseAccount>(
  {
    userId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    profileId: {
      type: String,
      required: true,
    },
    profileType: {
      type: String,
      enum: ["personal", "business"],
      required: true,
    },
    fullName: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
    },
    accessToken: {
      type: String,
      required: true,
      select: false, // Don't return by default for security
    },
    refreshToken: {
      type: String,
      required: true,
      select: false,
    },
    tokenExpiry: {
      type: Date,
      required: true,
    },
    balances: [
      {
        currency: String,
        amount: Number,
        reservedAmount: Number,
        lastUpdated: Date,
      },
    ],
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

export default mongoose.model<IWiseAccount>("WiseAccount", WiseAccountSchema);