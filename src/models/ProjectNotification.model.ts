import mongoose, { Document, Schema } from 'mongoose';

export const PROJECT_NOTIFICATION_TYPES = [
  'task_assigned',
  'task_comment',
  'task_status',
  'task_updated',
  'group_added',
] as const;

export type ProjectNotificationType = (typeof PROJECT_NOTIFICATION_TYPES)[number];

export interface IProjectNotification extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  type: ProjectNotificationType;
  groupId: mongoose.Types.ObjectId;
  taskId?: mongoose.Types.ObjectId | null;
  actorId: mongoose.Types.ObjectId;
  actorName: string;
  title: string;
  message: string;
  readAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ProjectNotificationSchema = new Schema<IProjectNotification>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: PROJECT_NOTIFICATION_TYPES,
      required: true,
    },
    groupId: {
      type: Schema.Types.ObjectId,
      ref: 'ProjectGroup',
      required: true,
    },
    taskId: {
      type: Schema.Types.ObjectId,
      ref: 'ProjectTask',
      default: null,
    },
    actorId: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
    },
    actorName: { type: String, required: true },
    title: { type: String, required: true },
    message: { type: String, default: '' },
    readAt: { type: Date, default: null },
  },
  { timestamps: true },
);

ProjectNotificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });
ProjectNotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

const ProjectNotification = mongoose.model<IProjectNotification>(
  'ProjectNotification',
  ProjectNotificationSchema,
);

export default ProjectNotification;