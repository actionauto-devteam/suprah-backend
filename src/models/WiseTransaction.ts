import mongoose, { Schema, Document } from "mongoose";

export interface IWiseTransaction extends Document {
  userId: string;
  wiseAccountId: string;
  transactionId: string;
  date: Date;
  description: string;
  amount: number;
  currency: string;
  type: "credit" | "debit";
  status: "completed" | "pending" | "cancelled";
  recipient?: string;
  reference?: string;
  metadata: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const WiseTransactionSchema = new Schema<IWiseTransaction>(
  {
    userId: {
      type: String,
      required: true,
      index: true,
    },
    wiseAccountId: {
      type: String,
      required: true,
      index: true,
    },
    transactionId: {
      type: String,
      required: true,
      unique: true,
    },
    date: {
      type: Date,
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: ["credit", "debit"],
      required: true,
    },
    status: {
      type: String,
      enum: ["completed", "pending", "cancelled"],
      required: true,
    },
    recipient: String,
    reference: String,
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

export default mongoose.model<IWiseTransaction>(
  "WiseTransaction",
  WiseTransactionSchema
);