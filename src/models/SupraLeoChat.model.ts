import mongoose, { Document, Schema, Types } from 'mongoose';

export interface ISupraLeoChatMessage {
  role: 'user' | 'assistant';
  content: string;
  module?: string;
  context?: any;
  createdAt: Date;
}

export interface ISupraLeoChat extends Document {
  userId: mongoose.Types.ObjectId;
  organizationId: mongoose.Types.ObjectId;
  messages: Types.DocumentArray<ISupraLeoChatMessage>;
  messageCount: number;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ChatMessageSchema = new Schema<ISupraLeoChatMessage>(
  {
    role: {
      type: String,
      enum: ['user', 'assistant'],
      required: true,
    },
    content: {
      type: String,
      required: true,
      maxlength: 32000,
    },
    module: {
      type: String,
      enum: ['appointments', 'timeproof', 'supraspace', 'biometrics', 'feeds', 'general', 'meeting'],
      default: 'general',
    },
    context: {
      type: Schema.Types.Mixed,
      default: null,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const SupraLeoChatSchema = new Schema<ISupraLeoChat>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
      index: true,
    },
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    messages: {
      type: [ChatMessageSchema],
      default: [],
    },
    messageCount: {
      type: Number,
      default: 0,
    },
    lastActivityAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

SupraLeoChatSchema.index({ userId: 1, organizationId: 1 }, { unique: true });
SupraLeoChatSchema.index({ lastActivityAt: -1 });

SupraLeoChatSchema.pre('save', function (next) {
  this.messageCount = this.messages.length;
  this.lastActivityAt = new Date();
  next();
});

const SupraLeoChat = mongoose.model<ISupraLeoChat>('SupraLeoChat', SupraLeoChatSchema);

export default SupraLeoChat;