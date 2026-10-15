import mongoose, { Document, Schema } from "mongoose";

export interface ITimeproofArchive extends Document {
  _id: mongoose.Types.ObjectId;
  organizationId: mongoose.Types.ObjectId;
  fullName: string;
  username?: string;
  email?: string;
  avatar?: string;
  role: string;
  department?: string;
  hireDate?: Date;
  offboardedAt: Date;
  accountDeletedAt?: Date | null;
  archivedBy?: mongoose.Types.ObjectId;
  autoDeleteEligible: boolean;
}

const TimeproofArchiveSchema = new Schema<ITimeproofArchive>(
  {
    _id: { type: Schema.Types.ObjectId, required: true },
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    fullName: { type: String, required: true },
    username: { type: String },
    email: { type: String },
    avatar: { type: String },
    role: { type: String, required: true },
    department: { type: String },
    hireDate: { type: Date },
    offboardedAt: { type: Date, required: true },
    accountDeletedAt: { type: Date, default: null },
    archivedBy: { type: Schema.Types.ObjectId, ref: "CrmUser" },
    autoDeleteEligible: { type: Boolean, default: false },
  },
  { timestamps: true },
);

TimeproofArchiveSchema.index({ organizationId: 1, offboardedAt: -1 });
TimeproofArchiveSchema.index({ autoDeleteEligible: 1, offboardedAt: 1 });

const TimeproofArchive = mongoose.model<ITimeproofArchive>("TimeproofArchive", TimeproofArchiveSchema);

export default TimeproofArchive;
