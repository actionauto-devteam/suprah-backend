import mongoose, { Document, Schema } from 'mongoose';

export type CallStatus = 'calling' | 'active' | 'ending' | 'ended';

export interface ICallParticipant {
  userId: mongoose.Types.ObjectId;
  joinedAt: Date;
  leftAt?: Date | null;
  isModerator: boolean;
}

export interface ICall extends Document {
  meetingId: string;          // public id used by clients (uuid)
  roomName: string;           // deterministic Jitsi room: conversation-{convId}-{ts}
  conversationId: mongoose.Types.ObjectId;
  initiatedBy: mongoose.Types.ObjectId;
  moderatorUserId: mongoose.Types.ObjectId;
  participants: ICallParticipant[];
  callStatus: CallStatus;     // calling -> active -> ending -> ended (IDLE = no record)
  isLive: boolean;            // true while calling/active — drives the unique guard
  startedAt: Date;
  endedAt?: Date | null;
  duration: number;           // seconds, computed server-side at termination
  systemMessageId?: mongoose.Types.ObjectId | null; // "Call ended" chat message
  createdAt: Date;
  updatedAt: Date;
}

const ParticipantSchema = new Schema<ICallParticipant>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'CrmUser', required: true },
    joinedAt: { type: Date, default: Date.now },
    leftAt: { type: Date, default: null },
    isModerator: { type: Boolean, default: false },
  },
  { _id: false }
);

const CallSchema = new Schema<ICall>(
  {
    meetingId: { type: String, required: true, unique: true },
    roomName: { type: String, required: true },
    conversationId: { type: Schema.Types.ObjectId, ref: 'SupraSpaceConversation', required: true, index: true },
    initiatedBy: { type: Schema.Types.ObjectId, ref: 'CrmUser', required: true },
    moderatorUserId: { type: Schema.Types.ObjectId, ref: 'CrmUser', required: true },
    participants: { type: [ParticipantSchema], default: [] },
    callStatus: { type: String, enum: ['calling', 'active', 'ending', 'ended'], default: 'calling' },
    isLive: { type: Boolean, default: true },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date, default: null },
    duration: { type: Number, default: 0 },
    systemMessageId: { type: Schema.Types.ObjectId, ref: 'SupraSpaceMessage', default: null },
  },
  { timestamps: true }
);

// At most one live call per conversation.
// partialFilterExpression supports equality only, so we guard on the boolean
// isLive rather than callStatus $in.
CallSchema.index({ conversationId: 1 }, { unique: true, partialFilterExpression: { isLive: true } });

export default mongoose.model<ICall>('Call', CallSchema);
