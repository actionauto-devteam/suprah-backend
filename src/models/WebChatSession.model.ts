import mongoose, { Document, Schema } from 'mongoose';

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
  },
  { timestamps: true },
);

const WebChatSession = mongoose.model<IWebChatSession>('WebChatSession', WebChatSessionSchema);

export default WebChatSession;
