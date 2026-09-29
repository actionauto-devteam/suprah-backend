import mongoose, { Document, Schema } from 'mongoose';

export type VehicleReengagementStatus = 'blocked' | 'sent' | 'failed' | 'skipped';
export type VehicleReengagementClassifierVerdict = 'SAFE' | 'UNSAFE' | 'ERROR';

export interface IVehicleReengagementLog extends Document {
  organizationId: string;
  vehicleId: mongoose.Types.ObjectId;
  leadId: mongoose.Types.ObjectId;
  vehicleLabel: string;
  leadVehicleLabel?: string;
  leadName: string;
  leadPhone: string;
  generatedMessage?: string;
  finalMessage?: string;
  status: VehicleReengagementStatus;
  blockedReason?: string;
  classifierVerdict?: VehicleReengagementClassifierVerdict;
  failureReason?: string;
  sentAt?: Date;
  overriddenBy?: mongoose.Types.ObjectId;
  overriddenAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const VehicleReengagementLogSchema: Schema<IVehicleReengagementLog> = new Schema(
  {
    organizationId: { type: String, required: true },
    vehicleId: { type: Schema.Types.ObjectId, required: true, ref: 'Vehicle' },
    leadId: { type: Schema.Types.ObjectId, required: true, ref: 'Lead' },
    vehicleLabel: { type: String, required: true, trim: true },
    leadVehicleLabel: { type: String, trim: true },
    leadName: { type: String, trim: true },
    leadPhone: { type: String, required: true, trim: true },
    generatedMessage: { type: String, trim: true },
    finalMessage: { type: String, trim: true },
    status: {
      type: String,
      enum: ['blocked', 'sent', 'failed', 'skipped'],
      required: true,
      index: true,
    },
    blockedReason: { type: String, trim: true, maxlength: 500 },
    classifierVerdict: { type: String, enum: ['SAFE', 'UNSAFE', 'ERROR'] },
    failureReason: { type: String, trim: true, maxlength: 500 },
    sentAt: { type: Date },
    overriddenBy: { type: Schema.Types.ObjectId, ref: 'CrmUser' },
    overriddenAt: { type: Date },
  },
  { timestamps: true },
);

VehicleReengagementLogSchema.index({ vehicleId: 1, leadId: 1 }, { unique: true });
VehicleReengagementLogSchema.index({ organizationId: 1, status: 1, createdAt: -1 });

const VehicleReengagementLog = mongoose.model<IVehicleReengagementLog>(
  'VehicleReengagementLog',
  VehicleReengagementLogSchema,
);

export default VehicleReengagementLog;
