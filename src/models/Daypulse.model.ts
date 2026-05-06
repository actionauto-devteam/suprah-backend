import mongoose, { Document, Schema, Model } from 'mongoose';

// ─── Department Hashtags ───────────────────────────────────────────────────────

export const DAYPULSE_DEPARTMENTS = [
  'SalesAndFinance',
  'Accounting',
  'Recon',
  'Marketing',
  'OnlineTeam',
  'WebDevTeam',
  'WholesaleTeam',
  'BuyingTeam',
  'OperationsTeam',
  'LotTechTeam',
  'FundingTeam',
  'ProspectsTeam',
  'PriceCheckTeam',
] as const;

export type DayPulseDepartment = typeof DAYPULSE_DEPARTMENTS[number];

export type DayPulseAttachmentSection = 'accomplishment' | 'blockers' | 'inProgress';

// ─── Interface ────────────────────────────────────────────────────────────────
// A DayPulse post is a structured daily report with three required sections.
// Each post is scoped to one department (hashtag) and one report date.

export interface IDayPulse extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  authorName: string;
  authorAvatar?: string | null;
  authorRole: string;
  department: DayPulseDepartment;   // Which hashtag/team this report belongs to
  reportDate: Date;                 // The calendar date this report covers (not createdAt)
  accomplishment: string;               // Section 1: What was accomplished
  blockers: string;               // Section 2: What is blocking progress
  inProgress: string;               // Section 3: What is currently in progress
  attachments: IDayPulseAttachment[];
  isEdited: boolean;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IDayPulseAttachment {
  url: string;
  fileKey: string;
  originalName: string;
  mimeType: string;
  size: number;
  thumbnailUrl?: string | null;
  section?: DayPulseAttachmentSection;
}

export interface IDayPulseModel extends Model<IDayPulse> { }

// ─── Schema ───────────────────────────────────────────────────────────────────

const DayPulseSchema = new Schema<IDayPulse>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
      index: true,
    },
    authorName: {
      type: String,
      required: true,
      trim: true,
    },
    authorAvatar: {
      type: String,
      default: null,
    },
    authorRole: {
      type: String,
      default: 'employee',
    },

    // The department this report is filed under — maps to a hashtag tab in the UI.
    department: {
      type: String,
      enum: DAYPULSE_DEPARTMENTS,
      required: true,
      index: true,
    },

    // The date the report covers, stored as midnight UTC of that day.
    // Separated from createdAt so a user can file a report for yesterday, etc.
    reportDate: {
      type: Date,
      required: true,
      index: true,
    },

    // ── Structured report sections (all required) ──
    accomplishment: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000,
    },
    blockers: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000,
    },
    inProgress: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000,
    },

    attachments: {
      type: [
        new Schema<IDayPulseAttachment>(
          {
            url: { type: String, required: true },
            fileKey: { type: String, required: true },
            originalName: { type: String, required: true },
            mimeType: { type: String, required: true },
            size: { type: Number, required: true },
            thumbnailUrl: { type: String, default: null },
            section: {
              type: String,
              enum: ['accomplishment', 'blockers', 'inProgress'],
              default: undefined,
            },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    isEdited: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

// Most common query: "all live reports for org X in department Y on date Z"
DayPulseSchema.index({ organizationId: 1, department: 1, reportDate: -1 });

// Org-wide date filter (for cross-department report views)
DayPulseSchema.index({ organizationId: 1, reportDate: -1 });

// Soft-delete filter
DayPulseSchema.index({ deletedAt: 1 });

// ─── Model ────────────────────────────────────────────────────────────────────

const DayPulse = mongoose.model<IDayPulse, IDayPulseModel>('DayPulse', DayPulseSchema);

export default DayPulse;