import mongoose, { Document, Schema, Model } from 'mongoose';

export type ShiftType = 'morning' | 'afternoon' | 'evening' | 'night' | 'custom';

export interface IShift extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  userName: string;
  userAvatar?: string | null;
  date: Date;
  startTime: string;
  endTime: string;
  shiftType: ShiftType;
  role?: string;
  location?: string;
  note?: string;
  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IShiftModel extends Model<IShift> {}

const ShiftSchema = new Schema<IShift>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    userId:         { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    userName:       { type: String, required: true, trim: true },
    userAvatar:     { type: String, default: null },
    date:           { type: Date, required: true, index: true },
    startTime:      { type: String, required: true, maxlength: 5 },
    endTime:        { type: String, required: true, maxlength: 5 },
    shiftType: {
      type: String,
      enum: ['morning', 'afternoon', 'evening', 'night', 'custom'],
      default: 'custom',
    },
    role:       { type: String, trim: true, maxlength: 80 },
    location:   { type: String, trim: true, maxlength: 100 },
    note:       { type: String, trim: true, maxlength: 300 },
    createdBy:      { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName:  { type: String, required: true },
  },
  { timestamps: true }
);

ShiftSchema.index({ organizationId: 1, date: 1 });
ShiftSchema.index({ organizationId: 1, userId: 1, date: 1 });

const Shift = mongoose.model<IShift, IShiftModel>('Shift', ShiftSchema);
export default Shift;
