import mongoose, { Document, Schema } from 'mongoose';

export type CallStatus = 'scheduled' | 'calling' | 'active' | 'ending' | 'ended';

export interface ICallParticipant {
  userId: mongoose.Types.ObjectId;
  joinedAt: Date;
  leftAt?: Date | null;
  isModerator: boolean;
}

export interface ICallAdmissionRequest {
  userId?: mongoose.Types.ObjectId | null;
  name: string;
  email: string;
  status: 'pending' | 'approved' | 'denied';
  requestedAt: Date;
  decidedAt?: Date | null;
  decidedBy?: mongoose.Types.ObjectId | null;
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
  title?: string;
  scheduledAt?: Date | null;
  optionalMessage?: string;
  meetingLink?: string;
  allowedDomain: string;
  approvedUsers: mongoose.Types.ObjectId[];
  admissionRequests: ICallAdmissionRequest[];
  recordingAllowedUsers: mongoose.Types.ObjectId[]; // users granted recording permission by host
  isRecording: boolean;
  recordingStartedAt: Date | null;
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

const AdmissionRequestSchema = new Schema<ICallAdmissionRequest>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'CrmUser', default: null },
    name: { type: String, default: '' },
    email: { type: String, required: true },
    status: { type: String, enum: ['pending', 'approved', 'denied'], default: 'pending' },
    requestedAt: { type: Date, default: Date.now },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'CrmUser', default: null },
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
    callStatus: { type: String, enum: ['scheduled', 'calling', 'active', 'ending', 'ended'], default: 'calling' },
    isLive: { type: Boolean, default: true },
    title: { type: String, default: '' },
    scheduledAt: { type: Date, default: null },
    optionalMessage: { type: String, default: '' },
    meetingLink: { type: String, default: '' },
    allowedDomain: { type: String, default: 'actionautoutah.com' },
    approvedUsers: [{ type: Schema.Types.ObjectId, ref: 'CrmUser' }],
    admissionRequests: { type: [AdmissionRequestSchema], default: [] },
    recordingAllowedUsers: [{ type: Schema.Types.ObjectId, ref: 'CrmUser' }],
    isRecording: { type: Boolean, default: false },
    recordingStartedAt: { type: Date, default: null },
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
