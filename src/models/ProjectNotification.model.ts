import mongoose, { Document, Schema } from 'mongoose';

export const PROJECT_NOTIFICATION_TYPES = [
  'task_assigned',      // a task was assigned to you
  'task_comment',       // someone commented on a task you created / are assigned to
  'task_status',        // the status of one of your tasks changed
  'task_updated',       // details of one of your tasks were edited
  'group_added',        // you were added to a project group
] as const;

export type ProjectNotificationType = (typeof PROJECT_NOTIFICATION_TYPES)[number];

/**
 * Per-user Project Management notification. Powers the sidebar badge count.
 * Only ever created for users who are directly involved (assignee / creator /
 * new group member) — never fanned out to the whole org.
 */
export interface IProjectNotification extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;          // recipient (CrmUser)
  type: ProjectNotificationType;
  groupId: mongoose.Types.ObjectId;
  taskId?: mongoose.Types.ObjectId | null;
  actorId: mongoose.Types.ObjectId;         // who triggered it
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

// Badge count + inbox list.
ProjectNotificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });
// Auto-expire notifications after 90 days to keep the collection small
// (lesson learned from the systemlogs index blow-up).
ProjectNotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

const ProjectNotification = mongoose.model<IProjectNotification>(
  'ProjectNotification',
  ProjectNotificationSchema,
);

export default ProjectNotification;