import mongoose, { Document, Schema } from 'mongoose';

export interface ICrmLeadGroup extends Document {
  organizationId: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  color?: string;
  memberIds: mongoose.Types.ObjectId[];
  isActive: boolean;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const CrmLeadGroupSchema = new Schema<ICrmLeadGroup>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: '',
    },
    color: {
      type: String,
      default: null,
    },
    memberIds: [
      {
        type: Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
    },
  },
  { timestamps: true },
);

CrmLeadGroupSchema.index({ organizationId: 1, isActive: 1 });
CrmLeadGroupSchema.index({ organizationId: 1, memberIds: 1 });

const CrmLeadGroup = mongoose.model<ICrmLeadGroup>('CrmLeadGroup', CrmLeadGroupSchema);

export default CrmLeadGroup;
