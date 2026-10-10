import mongoose, { Document, Schema } from 'mongoose';
import { AiHumanAttention, aiHumanAttentionFields } from './aiHumanAttention';

interface IAiPausedBy {
  userId: string;
  name?: string;
}

const AiPausedBySchema = new Schema<IAiPausedBy>(
  {
    userId: { type: String, required: true },
    name: { type: String },
  },
  { _id: false },
);

export interface IWebChatSession extends Document {
  organizationId: string;
  leadId: mongoose.Types.ObjectId;
  tokenHash: string;
  visitorName: string;
  visitorEmail?: string;
  visitorPhone?: string;
  vehicleId?: mongoose.Types.ObjectId;
  pageUrl?: string;
  lastMessageAt: Date;
  smsFallbackSentAt?: Date;
  staffTypingAt?: Date;
  aiPausedAt?: Date;
  aiPausedBy?: IAiPausedBy;
  aiGeneratingAt?: Date;
  aiAutoPausedUntil?: Date;
  aiResponseVersion?: number;
  aiLastDispatchVersion?: number;
  aiAttentionPendingIds?: string[];
  aiHumanAttention?: AiHumanAttention;
  createdAt: Date;
  updatedAt: Date;
}

const WebChatSessionSchema: Schema<IWebChatSession> = new Schema(
  {
    organizationId: { type: String, required: true, index: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true, index: true },
    tokenHash: { type: String, required: true, select: false },
    visitorName: { type: String, required: true, trim: true },
    visitorEmail: { type: String, trim: true, lowercase: true },
    visitorPhone: { type: String, trim: true },
    vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle' },
    pageUrl: { type: String, trim: true },
    lastMessageAt: { type: Date, default: Date.now },
    smsFallbackSentAt: { type: Date },
    staffTypingAt: { type: Date },
    aiPausedAt: { type: Date },
    aiPausedBy: { type: AiPausedBySchema },
    aiGeneratingAt: { type: Date },
    aiAutoPausedUntil: { type: Date },
    ...aiHumanAttentionFields,
  },
  { timestamps: true },
);

const WebChatSession = mongoose.model<IWebChatSession>('WebChatSession', WebChatSessionSchema);

export default WebChatSession;
