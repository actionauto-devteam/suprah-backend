import mongoose, { Document, Schema } from 'mongoose';

export interface IServiceSlot extends Document {
  organizationId: string;
  date: Date;           // midnight UTC — represents a calendar day
  time: string;         // "08:00", "10:00", etc.
  label: string;        // "8:00 AM"
  maxBookings: number;
  currentBookings: number;
  isBlocked: boolean;
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ServiceSlotSchema = new Schema<IServiceSlot>(
  {
    organizationId: { type: String, required: true, index: true },
    date: { type: Date, required: true, index: true },
    time: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    maxBookings: { type: Number, default: 1, min: 1 },
    currentBookings: { type: Number, default: 0, min: 0 },
    isBlocked: { type: Boolean, default: false },
    createdBy: { type: String, trim: true },
  },
  { timestamps: true }
);

ServiceSlotSchema.index({ organizationId: 1, date: 1, time: 1 }, { unique: true });
ServiceSlotSchema.index({ organizationId: 1, date: 1 });

const ServiceSlot = mongoose.model<IServiceSlot>('ServiceSlot', ServiceSlotSchema);
export default ServiceSlot;
