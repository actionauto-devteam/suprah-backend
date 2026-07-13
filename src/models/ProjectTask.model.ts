import mongoose, { Document, Schema } from 'mongoose';

export const PROJECT_TASK_STATUSES = [
  'ideation',
  'todo',
  'in-progress',
  'backlog',
  'to-deploy',
  'completed',
] as const;

export type ProjectTaskStatus = (typeof PROJECT_TASK_STATUSES)[number];

export interface IProjectAttachment {
  url: string;
  fileKey: string;
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
  groupId: mongoose.Types.ObjectId;
  sectionId: mongoose.Types.ObjectId;
  folderId: mongoose.Types.ObjectId;
  title: string;
  description?: string;
  status: ProjectTaskStatus;
  createdBy: mongoose.Types.ObjectId;
  assigneeIds: mongoose.Types.ObjectId[];
  startDate?: Date | null;
  deadline?: Date | null;
  attachments: IProjectAttachment[];
  order: number;
  commentCount: number;
  completedAt?: Date | null;

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
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
    },
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
    order: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
    completedAt: { type: Date, default: null },

    parentTaskId: { type: Schema.Types.ObjectId, ref: 'ProjectTask', default: null },
    dependsOn: [{ type: Schema.Types.ObjectId, ref: 'ProjectTask' }],
    recurrence: { type: Schema.Types.Mixed, default: null },
    estimateMinutes: { type: Number, default: null },
    trackedMinutes: { type: Number, default: null },

    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

ProjectTaskSchema.index({ folderId: 1, deletedAt: 1, order: 1 });
ProjectTaskSchema.index({ assigneeIds: 1, deletedAt: 1, status: 1 });
ProjectTaskSchema.index({ groupId: 1, status: 1, deletedAt: 1 });

const ProjectTask = mongoose.model<IProjectTask>('ProjectTask', ProjectTaskSchema);

export default ProjectTask;