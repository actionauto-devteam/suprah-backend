import mongoose, { Document, Schema } from 'mongoose';
// v1.4.0

export interface IAgentHeartbeat extends Document {
  userId: mongoose.Types.ObjectId;
  isIdle: boolean;
  idleSince: Date | null;
  lastIdleEscalationNotifiedAt: Date | null;
  // Cooldown for the Shift Alerts channel idle message.
  lastIdleChannelPostedAt: Date | null;
  isOnBreak: boolean;
  breakStartedAt: Date | null;
  lastBreakNotifiedAt: Date | null;
  currentIntervalStartAt: Date | null;
  platform: string;
  // macOS only — whether the OS's Screen Recording permission (TCC) is
  // currently granted to the tray app. null = unknown/not applicable
  // (Windows, or an old tray build that doesn't report it yet). Since the
  // Mac build is unsigned, this permission does not reliably carry over
  // across auto-updates — see screenRecordingLastNotifiedAt below.
  screenRecordingGranted: boolean | null;
  lastScreenRecordingNotifiedAt: Date | null;
  // Tray app version (from app.getVersion()) as of the last heartbeat — lets admins
  // see who's still on an old/stale build without digging through diagnostic logs.
  // null on old tray builds that predate this field.
  appVersion: string | null;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const AgentHeartbeatSchema = new Schema<IAgentHeartbeat>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
      unique: true,
      index: true,
    },
    isIdle: {
      type: Boolean,
      default: false,
    },
    idleSince: {
      type: Date,
      default: null,
    },
    lastIdleEscalationNotifiedAt: {
      type: Date,
      default: null,
    },
    lastIdleChannelPostedAt: {
      type: Date,
      default: null,
    },
    isOnBreak: {
      type: Boolean,
      default: false,
    },
    breakStartedAt: {
      type: Date,
      default: null,
    },
    lastBreakNotifiedAt: {
      type: Date,
      default: null,
    },
    currentIntervalStartAt: {
      type: Date,
      default: null,
    },
    platform: {
      type: String,
      default: 'win32',
    },
    screenRecordingGranted: {
      type: Boolean,
      default: null,
    },
    lastScreenRecordingNotifiedAt: {
      type: Date,
      default: null,
    },
    appVersion: {
      type: String,
      default: null,
    },
    lastSeenAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

const AgentHeartbeat = mongoose.model<IAgentHeartbeat>('AgentHeartbeat', AgentHeartbeatSchema);

export default AgentHeartbeat;
