import mongoose, { Document, Schema, Model } from 'mongoose';

export type AbsenceType = 'absence' | 'day_off' | 'vacation' | 'sick' | 'other';
export type AbsenceStatus = 'pending' | 'approved' | 'rejected';

export interface IAbsenceAttachment {
  url: string;
  fileKey: string;
  originalName: string;
  mimeType: string;
  size: number;
}

export interface IAbsence extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  userName: string;
  userAvatar?: string | null;
  date: Date;
  type: AbsenceType;
  title?: string;
  note?: string;
  otherText?: string;
  status: AbsenceStatus;
  approvedBy?: mongoose.Types.ObjectId | null;
  approvedAt?: Date | null;
  rejectedReason?: string | null;
  proofAttachments: IAbsenceAttachment[];
  createdAt: Date;
  updatedAt: Date;
}

export interface IAbsenceModel extends Model<IAbsence> {}

const AbsenceAttachmentSchema = new Schema<IAbsenceAttachment>(
  {
    url:          { type: String, required: true },
    fileKey:      { type: String, required: true },
    originalName: { type: String, required: true },
    mimeType:     { type: String, required: true },
    size:         { type: Number, required: true },
  },
  { _id: false }
);

const AbsenceSchema = new Schema<IAbsence>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    userId:         { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    userName:       { type: String, required: true, trim: true },
    userAvatar:     { type: String, default: null },
    date:           { type: Date, required: true, index: true },
    type: {
      type: String,
      enum: ['absence', 'day_off', 'vacation', 'sick', 'other'],
      required: true,
    },
    title:     { type: String, trim: true, maxlength: 100 },
    note:      { type: String, trim: true, maxlength: 500 },
    otherText: { type: String, trim: true, maxlength: 200 },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'approved',
      index: true,
    },
    approvedBy:     { type: Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt:     { type: Date, default: null },
    rejectedReason: { type: String, trim: true, maxlength: 300, default: null },
    proofAttachments: { type: [AbsenceAttachmentSchema], default: [] },
  },
  { timestamps: true }
);

AbsenceSchema.index({ organizationId: 1, date: 1 });
AbsenceSchema.index({ organizationId: 1, userId: 1, date: 1 });
AbsenceSchema.index({ organizationId: 1, status: 1 });

const Absence = mongoose.model<IAbsence, IAbsenceModel>('Absence', AbsenceSchema);

export default Absence;
