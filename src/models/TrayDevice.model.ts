import mongoose, { Document, Schema } from 'mongoose';

export type TrayDeviceEventType = 'registered' | 'rebound' | 'revoked' | 'mismatch' | 'disconnected';

export interface ITrayDeviceEvent {
  type: TrayDeviceEventType;
  at: Date;
  meta?: Record<string, unknown>;
}

export interface ITrayDevice extends Document {
  deviceId: string;
  secretHash: string;
  userId: mongoose.Types.ObjectId;
  organizationId: mongoose.Types.ObjectId;
  label: string;
  platform: string;
  appVersion: string;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt?: Date | null;
  revokedReason?: string | null;
  credentialVersion: number;
  events: ITrayDeviceEvent[];
  createdAt: Date;
  updatedAt: Date;
}

const TrayDeviceEventSchema = new Schema<ITrayDeviceEvent>(
  {
    type: {
      type: String,
      enum: ['registered', 'rebound', 'revoked', 'mismatch', 'disconnected'],
      required: true,
    },
    at: { type: Date, required: true, default: Date.now },
    meta: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

const TrayDeviceSchema = new Schema<ITrayDevice>(
  {
    deviceId: { type: String, required: true, unique: true, index: true },
    secretHash: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'CrmUser', required: true, index: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    label: { type: String, default: '' },
    platform: { type: String, default: '' },
    appVersion: { type: String, default: '' },
    lastSeenAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },
    credentialVersion: { type: Number, default: 1 },
    events: { type: [TrayDeviceEventSchema], default: [] },
  },
  { timestamps: true, autoIndex: false, autoCreate: false },
);

TrayDeviceSchema.index({ userId: 1, revokedAt: 1 });

export default mongoose.models.TrayDevice || mongoose.model<ITrayDevice>('TrayDevice', TrayDeviceSchema);
