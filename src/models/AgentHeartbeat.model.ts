import mongoose, { Document, Schema } from 'mongoose';

export interface IAgentHeartbeat extends Document {
  userId: mongoose.Types.ObjectId;
  isIdle: boolean;
  isOnBreak: boolean;
  breakStartedAt: Date | null;
  lastBreakNotifiedAt: Date | null;
  currentIntervalStartAt: Date | null;
  platform: string;   // e.g. 'win32', 'darwin', 'linux'
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
      unique: true,   // one heartbeat doc per user, upserted every 60s
      index: true,
    },
    isIdle: {
      type: Boolean,
      default: false,
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
