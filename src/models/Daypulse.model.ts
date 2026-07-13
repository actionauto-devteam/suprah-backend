import mongoose, { Document, Schema, Model } from 'mongoose';


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


export interface IDayPulse extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  authorName: string;
  authorAvatar?: string | null;
  authorRole: string;
  department: DayPulseDepartment;
  reportDate: Date;
  accomplishment: string;
  blockers: string;
  inProgress: string;
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

const DAYPULSE_SECTION_MAX_LENGTH = 10000;


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

    department: {
      type: String,
      enum: DAYPULSE_DEPARTMENTS,
      required: true,
      index: true,
    },

    reportDate: {
      type: Date,
      required: true,
      index: true,
    },

    accomplishment: {
      type: String,
      required: true,
      trim: true,
      maxlength: DAYPULSE_SECTION_MAX_LENGTH,
    },
    blockers: {
      type: String,
      required: true,
      trim: true,
      maxlength: DAYPULSE_SECTION_MAX_LENGTH,
    },
    inProgress: {
      type: String,
      required: true,
      trim: true,
      maxlength: DAYPULSE_SECTION_MAX_LENGTH,
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


DayPulseSchema.index({ organizationId: 1, department: 1, reportDate: -1 });

DayPulseSchema.index({ organizationId: 1, reportDate: -1 });

DayPulseSchema.index({ deletedAt: 1 });


const DayPulse = mongoose.model<IDayPulse, IDayPulseModel>('DayPulse', DayPulseSchema);

export default DayPulse;
