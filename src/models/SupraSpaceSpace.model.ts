import mongoose, { Document, Schema } from 'mongoose';

export interface ISupraSpaceSpace extends Document {
  name: string;
  emoji?: string | null;
  members: mongoose.Types.ObjectId[];
  admins: mongoose.Types.ObjectId[];
  createdBy: mongoose.Types.ObjectId;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const SupraSpaceSpaceSchema = new Schema<ISupraSpaceSpace>(
  {
    name:      { type: String, required: true, trim: true },
    emoji:     { type: String, default: null },
    members:   [{ type: Schema.Types.ObjectId, ref: 'CrmUser', required: true }],
    admins:    [{ type: Schema.Types.ObjectId, ref: 'CrmUser' }],
    createdBy: { type: Schema.Types.ObjectId, ref: 'CrmUser', required: true },
    isActive:  { type: Boolean, default: true },
  },
  { timestamps: true }
);

SupraSpaceSpaceSchema.index({ members: 1 });

const SupraSpaceSpace = mongoose.model<ISupraSpaceSpace>('SupraSpaceSpace', SupraSpaceSpaceSchema);

export default SupraSpaceSpace;
