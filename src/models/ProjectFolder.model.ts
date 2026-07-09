import mongoose, { Document, Schema } from 'mongoose';

/**
 * Folder Group — third level of the hierarchy. Lives inside a Section and is
 * the direct container for Tasks.
 */
export interface IProjectFolder extends Document {
  organizationId: mongoose.Types.ObjectId;
  groupId: mongoose.Types.ObjectId;        // ProjectGroup (denormalised for fast auth checks)
  sectionId: mongoose.Types.ObjectId;      // ProjectSection
  name: string;
  createdBy: mongoose.Types.ObjectId;      // CrmUser
  order: number;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ProjectFolderSchema = new Schema<IProjectFolder>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    groupId: {
      type: Schema.Types.ObjectId,
      ref: 'ProjectGroup',
      required: true,
      index: true,
    },
    sectionId: {
      type: Schema.Types.ObjectId,
      ref: 'ProjectSection',
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
    },
    order: {
      type: Number,
      default: 0,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

ProjectFolderSchema.index({ sectionId: 1, deletedAt: 1, order: 1 });

const ProjectFolder = mongoose.model<IProjectFolder>('ProjectFolder', ProjectFolderSchema);

export default ProjectFolder;