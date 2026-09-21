import mongoose, { Document, Schema } from 'mongoose';

export interface IWebChatMessage extends Document {
  organizationId: string;
  sessionId: mongoose.Types.ObjectId;
  leadId: mongoose.Types.ObjectId;
  direction: 'inbound' | 'outbound';
  body: string;
  sentBy?: { userId: string; name?: string };
  createdAt: Date;
  updatedAt: Date;
}

const WebChatMessageSchema: Schema<IWebChatMessage> = new Schema(
  {
    organizationId: { type: String, required: true, index: true },
    sessionId: { type: Schema.Types.ObjectId, ref: 'WebChatSession', required: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    direction: { type: String, enum: ['inbound', 'outbound'], required: true },
    body: { type: String, required: true, maxlength: 1000 },
    sentBy: {
      type: new Schema({ userId: String, name: String }, { _id: false }),
    },
  },
  { timestamps: true },
);

WebChatMessageSchema.index({ sessionId: 1, createdAt: 1 });
WebChatMessageSchema.index({ leadId: 1, createdAt: 1 });

const WebChatMessage = mongoose.model<IWebChatMessage>('WebChatMessage', WebChatMessageSchema);

export default WebChatMessage;
