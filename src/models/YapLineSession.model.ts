import mongoose, { Document, Schema } from 'mongoose';

/**
 * Suprah YapLine — persisted session record.
 *
 * The *live* state (who is connected right now, who is speaking, who is
 * screen-sharing) lives in memory inside socket/yapline.socket.ts, because it
 * is tied to socket lifetimes and must never survive a server restart.
 *
 * This document exists for everything that should outlive the session:
 *   - "Recent voice activity" on the Dashboard widget
 *   - Session history / auditability (who started it, when, peak size)
 *
 * activity is a capped rolling log (MAX_ACTIVITY entries) so a very chatty
 * session can't grow the document unboundedly.
 * test
 */

export type YapLineActivityType =
  | 'started'
  | 'joined'
  | 'left'
  | 'spoke'
  | 'screen_started'
  | 'screen_stopped'
  | 'ended';

export interface IYapLineActivity {
  userId: mongoose.Types.ObjectId;
  name: string;
  type: YapLineActivityType;
  at: Date;
}

export interface IYapLineSession extends Document {
  conversationId: mongoose.Types.ObjectId;
  organizationId?: mongoose.Types.ObjectId | null;
  conversationName?: string | null;
  startedBy: mongoose.Types.ObjectId;
  startedAt: Date;
  endedAt?: Date | null;
  isActive: boolean;
  peakParticipants: number;
  activity: IYapLineActivity[];
  createdAt: Date;
  updatedAt: Date;
}

export const YAPLINE_MAX_ACTIVITY = 50;

const ActivitySchema = new Schema<IYapLineActivity>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'CrmUser', required: true },
    name:   { type: String, required: true },
    type: {
      type: String,
      enum: ['started', 'joined', 'left', 'spoke', 'screen_started', 'screen_stopped', 'ended'],
      required: true,
    },
    at: { type: Date, required: true, default: Date.now },
  },
  { _id: false }
);

const YapLineSessionSchema = new Schema<IYapLineSession>(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'SupraSpaceConversation',
      required: true,
      index: true,
    },
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      default: null,
      index: true,
    },
    conversationName: { type: String, default: null },
    startedBy: { type: Schema.Types.ObjectId, ref: 'CrmUser', required: true },
    startedAt: { type: Date, required: true, default: Date.now },
    endedAt:   { type: Date, default: null },
    isActive:  { type: Boolean, default: true, index: true },
    peakParticipants: { type: Number, default: 1 },
    activity:  { type: [ActivitySchema], default: [] },
  },
  { timestamps: true }
);

YapLineSessionSchema.index({ isActive: 1, startedAt: -1 });
YapLineSessionSchema.index({ conversationId: 1, startedAt: -1 });

const YapLineSession = mongoose.model<IYapLineSession>('YapLineSession', YapLineSessionSchema);

export default YapLineSession;