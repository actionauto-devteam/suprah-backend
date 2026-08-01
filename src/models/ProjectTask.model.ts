import mongoose, { Document, Schema } from 'mongoose';

/**
 * Workflow statuses. Keep this array as the single source of truth — the
 * controller validates against it and the frontend mirrors it in
 * components/project/task-status-badge.tsx.
 */
export const PROJECT_TASK_STATUSES = [
  'ideation',     // yellow
  'todo',         // gray
  'in-progress',  // blue
  'backlog',      // orange
  'to-deploy',    // purple
  'completed',    // green
] as const;

export type ProjectTaskStatus = (typeof PROJECT_TASK_STATUSES)[number];

/**
 * Priority levels. `null` means "no priority set" (the "Clear" option in the
 * picker) — kept distinct from 'normal' so a task can be explicitly
 * unprioritized rather than defaulting into the middle tier.
 */
export const PROJECT_TASK_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;

export type ProjectTaskPriority = (typeof PROJECT_TASK_PRIORITIES)[number];

/** Attachment shape shared with task comments (mirrors DayPulse attachments). */
export interface IProjectAttachment {
  url: string;            // signed URL at read time; stores the R2 key at rest
  fileKey: string;        // R2 object key (private bucket)
  originalName: string;
  mimeType: string;
  size: number;
  thumbnailUrl?: string;
  uploadedBy?: mongoose.Types.ObjectId;
  createdAt?: Date;
}

export const ProjectAttachmentSchema = new Schema<IProjectAttachment>(
  {
    url: { type: String, required: true },
    fileKey: { type: String, required: true },
    originalName: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    thumbnailUrl: { type: String },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'CrmUser' },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

export interface IProjectTask extends Document {
  organizationId: mongoose.Types.ObjectId;
  groupId: mongoose.Types.ObjectId;        // ProjectGroup (denormalised)
  sectionId: mongoose.Types.ObjectId;      // ProjectSection (denormalised)
  folderId: mongoose.Types.ObjectId;       // ProjectFolder
  title: string;
  description?: string;
  status: ProjectTaskStatus;
  priority: ProjectTaskPriority | null;
  createdBy: mongoose.Types.ObjectId;      // CrmUser — may change status
  assigneeIds: mongoose.Types.ObjectId[];  // CrmUser — any assignee may change status
  startDate?: Date | null;
  deadline?: Date | null;
  attachments: IProjectAttachment[];
  /**
   * Users who have opened this task since its last meaningful activity
   * (creation, edit, status change, new comment). Reset to [actor] on every
   * such activity — a task is "unseen" for a viewer involved in it until
   * they open it again. Powers the unread highlights in the UI.
   */
  seenBy: mongoose.Types.ObjectId[];
  /** Linked Suprah Calendar event (auto-synced from the deadline). */
  calendarEventId: mongoose.Types.ObjectId | null;
  /** Deadline reminder windows already sent: 'd3' | 'd1' | 'd0'. */
  remindersSent: string[];
  order: number;
  commentCount: number;                    // denormalised for list views
  completedAt?: Date | null;

  // ── Future expansion (reserved, unused today) ─────────────────────────────
  // parentTaskId  → subtasks
  // dependsOn     → task dependencies (Gantt)
  // recurrence    → recurring-task rules
  // estimateMinutes / trackedMinutes → time tracking & workload
  parentTaskId?: mongoose.Types.ObjectId | null;
  dependsOn: mongoose.Types.ObjectId[];
  recurrence?: Record<string, unknown> | null;
  estimateMinutes?: number | null;
  trackedMinutes?: number | null;

  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ProjectTaskSchema = new Schema<IProjectTask>(
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
    folderId: {
      type: Schema.Types.ObjectId,
      ref: 'ProjectFolder',
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 20000,
      default: '',
    },
    status: {
      type: String,
      enum: PROJECT_TASK_STATUSES,
      default: 'todo',
      index: true,
    },
    priority: {
      type: String,
      enum: [...PROJECT_TASK_PRIORITIES, null],
      default: 'normal',
      index: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
    },
    // Multiple assignees supported — a multikey index below keeps
    // "my tasks" queries fast.
    assigneeIds: [
      {
        type: Schema.Types.ObjectId,
        ref: 'CrmUser',
      },
    ],
    startDate: { type: Date, default: null },
    deadline: { type: Date, default: null },
    attachments: {
      type: [ProjectAttachmentSchema],
      default: [],
    },
    seenBy: [
      {
        type: Schema.Types.ObjectId,
        ref: 'CrmUser',
      },
    ],
    calendarEventId: {
      type: Schema.Types.ObjectId,
      ref: 'CalendarEvent',
      default: null,
    },
    remindersSent: {
      type: [String],
      default: [],
    },
    order: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
    completedAt: { type: Date, default: null },

    // Reserved for future features — see interface comment above.
    parentTaskId: { type: Schema.Types.ObjectId, ref: 'ProjectTask', default: null },
    dependsOn: [{ type: Schema.Types.ObjectId, ref: 'ProjectTask' }],
    recurrence: { type: Schema.Types.Mixed, default: null },
    estimateMinutes: { type: Number, default: null },
    trackedMinutes: { type: Number, default: null },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// List views: tasks in a folder, ordered.
ProjectTaskSchema.index({ folderId: 1, deletedAt: 1, order: 1 });
// "My tasks" views + notification fan-out (multikey over assigneeIds).
ProjectTaskSchema.index({ assigneeIds: 1, deletedAt: 1, status: 1 });
// Deadline reminder sweep: live, not-completed tasks with an upcoming deadline.
ProjectTaskSchema.index({ deadline: 1, status: 1, deletedAt: 1 });
// Future Kanban view: tasks in a group by status.
ProjectTaskSchema.index({ groupId: 1, status: 1, deletedAt: 1 });

const ProjectTask = mongoose.model<IProjectTask>('ProjectTask', ProjectTaskSchema);

export default ProjectTask;