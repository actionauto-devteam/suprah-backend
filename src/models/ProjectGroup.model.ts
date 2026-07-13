import mongoose, { Document, Schema } from 'mongoose';

export interface IProjectGroup extends Document {
  organizationId: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  createdBy: mongoose.Types.ObjectId;
  memberIds: mongoose.Types.ObjectId[];
  color?: string;
  settings?: Record<string, unknown>;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ProjectGroupSchema = new Schema<IProjectGroup>(
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
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
    },
    memberIds: [
      {
        type: Schema.Types.ObjectId,
        ref: 'CrmUser',
        required: true,
      },
    ],
    color: {
      type: String,
      default: null,
    },
    settings: {
      type: Schema.Types.Mixed,
      default: {},
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

ProjectGroupSchema.index({ organizationId: 1, memberIds: 1, deletedAt: 1 });

const ProjectGroup = mongoose.model<IProjectGroup>('ProjectGroup', ProjectGroupSchema);

export default ProjectGroup;