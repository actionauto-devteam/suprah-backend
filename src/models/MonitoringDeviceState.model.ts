import mongoose, { Document, Schema } from 'mongoose';

export type MonitoringDeviceKind = 'desktop' | 'mobile';

export interface IMonitoringDeviceHistoryEntry {
  from: MonitoringDeviceKind | null;
  to: MonitoringDeviceKind;
  at: Date;
  by: 'shift-start' | 'user' | 'admin' | 'geofence';
  actorId?: mongoose.Types.ObjectId | null;
  placeName?: string | null;
}

export interface IMonitoringDeviceState extends Document {
  _id: mongoose.Types.ObjectId;
  organizationId: mongoose.Types.ObjectId;
  shiftStartedAt: Date;
  activeDevice: MonitoringDeviceKind;
  switchedAt: Date;
  history: IMonitoringDeviceHistoryEntry[];
  awaySince?: Date | null;
  awayLastPingAt?: Date | null;
  awaySiteName?: string | null;
  awayPaused?: boolean;
}

const HistoryEntrySchema = new Schema<IMonitoringDeviceHistoryEntry>(
  {
    from: { type: String, enum: ['desktop', 'mobile', null], default: null },
    to: { type: String, enum: ['desktop', 'mobile'], required: true },
    at: { type: Date, required: true },
    by: { type: String, enum: ['shift-start', 'user', 'admin', 'geofence'], required: true },
    actorId: { type: Schema.Types.ObjectId, default: null },
    placeName: { type: String, default: null },
  },
  { _id: false },
);

const MonitoringDeviceStateSchema = new Schema<IMonitoringDeviceState>(
  {
    _id: { type: Schema.Types.ObjectId, ref: 'CrmUser', required: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    shiftStartedAt: { type: Date, required: true },
    activeDevice: { type: String, enum: ['desktop', 'mobile'], required: true },
    switchedAt: { type: Date, required: true },
    history: { type: [HistoryEntrySchema], default: [] },
    awaySince: { type: Date, default: null },
    awayLastPingAt: { type: Date, default: null },
    awaySiteName: { type: String, default: null },
    awayPaused: { type: Boolean, default: false },
  },
  { timestamps: false, autoIndex: false, autoCreate: false },
);

export default mongoose.models.MonitoringDeviceState
  || mongoose.model<IMonitoringDeviceState>('MonitoringDeviceState', MonitoringDeviceStateSchema);
