import mongoose, { Document, Schema } from 'mongoose';
import { IProjectAttachment, ProjectAttachmentSchema } from './ProjectTask.model';

/**
 * Task comment — the per-task communication thread. Author identity is
 * snapshotted (name/avatar/role) the same way DayPulse does it, so list
 * rendering never needs a populate.
 */
export interface IProjectTaskComment extends Document {
  organizationId: mongoose.Types.ObjectId;
  groupId: mongoose.Types.ObjectId;        // denormalised for auth checks
  taskId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;         // CrmUser
  authorName: string;
  authorAvatar?: string | null;
  authorRole?: string;
  message: string;
  /** CrmUser ids @-mentioned in this comment (always group members). */
  mentions: mongoose.Types.ObjectId[];
  attachments: IProjectAttachment[];
  isEdited: boolean;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ProjectTaskCommentSchema = new Schema<IProjectTaskComment>(
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
    taskId: {
      type: Schema.Types.ObjectId,
      ref: 'ProjectTask',
      required: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
    },
    authorName: { type: String, required: true },
    authorAvatar: { type: String, default: null },
    authorRole: { type: String },
    message: {
      type: String,
      trim: true,
      maxlength: 10000,
      default: '',
    },
    mentions: [
      {
        type: Schema.Types.ObjectId,
        ref: 'CrmUser',
      },
    ],
    attachments: {
      type: [ProjectAttachmentSchema],
      default: [],
    },
    isEdited: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

ProjectTaskCommentSchema.index({ taskId: 1, deletedAt: 1, createdAt: 1 });
// "Mentions" inbox — everything a user was @-mentioned in, newest first.
ProjectTaskCommentSchema.index({ mentions: 1, deletedAt: 1, createdAt: -1 });

const ProjectTaskComment = mongoose.model<IProjectTaskComment>(
  'ProjectTaskComment',
  ProjectTaskCommentSchema,
);

export default ProjectTaskComment;