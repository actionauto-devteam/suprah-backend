import mongoose, { Document, Schema } from 'mongoose';

/**
 * Project Group — top level of the Project Management hierarchy.
 *
 *   Project Management → Project Group → Section → Folder Group → Task
 *
 * Every document in the hierarchy carries BOTH `organizationId` and `groupId`
 * so that (a) org isolation can be enforced with a single indexed filter and
 * (b) group-membership checks never require walking up the tree.
 *
 * Visibility rule: a group is only ever returned to users whose CrmUser._id
 * appears in `memberIds` (the creator is always included at creation time).
 */
export interface IProjectGroup extends Document {
  organizationId: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  createdBy: mongoose.Types.ObjectId;      // CrmUser
  memberIds: mongoose.Types.ObjectId[];    // CrmUser — includes creator
  color?: string;                          // accent for group avatar chip
  // Future-proofing: ordered custom statuses, group-level settings, etc.
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

// Primary access path: "all live groups in my org that I am a member of"
ProjectGroupSchema.index({ organizationId: 1, memberIds: 1, deletedAt: 1 });

const ProjectGroup = mongoose.model<IProjectGroup>('ProjectGroup', ProjectGroupSchema);

export default ProjectGroup;