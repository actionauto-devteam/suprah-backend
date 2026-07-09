import mongoose, { Document, Schema } from 'mongoose';

/**
 * Section — second level of the hierarchy. Lives inside a Project Group and
 * contains Folder Groups. Sections typically represent departments, phases,
 * or work categories.
 *
 * `order` exists so future Kanban / drag-to-reorder views can persist manual
 * ordering without a schema change.
 */
export interface IProjectSection extends Document {
  organizationId: mongoose.Types.ObjectId;
  groupId: mongoose.Types.ObjectId;        // ProjectGroup
  name: string;
  createdBy: mongoose.Types.ObjectId;      // CrmUser
  order: number;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ProjectSectionSchema = new Schema<IProjectSection>(
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

ProjectSectionSchema.index({ groupId: 1, deletedAt: 1, order: 1 });

const ProjectSection = mongoose.model<IProjectSection>('ProjectSection', ProjectSectionSchema);

export default ProjectSection;