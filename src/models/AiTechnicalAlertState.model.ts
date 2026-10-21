import mongoose, { Schema } from 'mongoose';

export interface IAiTechnicalAlertState {
  _id: string;
  organizationId: string;
  lastAlertAt: Date;
  lastCount: number;
}

const AiTechnicalAlertStateSchema = new Schema<IAiTechnicalAlertState>(
  {
    _id: { type: String, required: true },
    organizationId: { type: String, required: true },
    lastAlertAt: { type: Date, required: true },
    lastCount: { type: Number, required: true },
  },
  { timestamps: true, versionKey: false },
);

const AiTechnicalAlertState = mongoose.model<IAiTechnicalAlertState>('AiTechnicalAlertState', AiTechnicalAlertStateSchema);

export default AiTechnicalAlertState;
