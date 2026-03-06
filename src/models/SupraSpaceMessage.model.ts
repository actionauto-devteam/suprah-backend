import mongoose, { Document, Schema } from 'mongoose';

export interface ISupraSpaceAttachment {
  url: string;
  originalName: string;
  mimeType: string;
  size: number;         // bytes
  thumbnailUrl?: string;
}

export interface ISupraSpaceReaction {
  emoji: string;
  users: mongoose.Types.ObjectId[];
}

export interface ISupraSpaceMessage extends Document {
  conversationId: mongoose.Types.ObjectId;
  sender: mongoose.Types.ObjectId;
  content: string;
  type: 'text' | 'image' | 'file' | 'system';
  attachments: ISupraSpaceAttachment[];
  replyTo?: mongoose.Types.ObjectId;   // threaded reply
  reactions: ISupraSpaceReaction[];
  readBy: mongoose.Types.ObjectId[];
  isEdited: boolean;
  isDeleted: boolean;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const AttachmentSchema = new Schema<ISupraSpaceAttachment>(
  {
    url: { type: String, required: true },
    originalName: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    thumbnailUrl: { type: String, default: null },
  },
  { _id: false }
);

const ReactionSchema = new Schema<ISupraSpaceReaction>(
  {
    emoji: { type: String, required: true },
    users: [{ type: Schema.Types.ObjectId, ref: 'CrmUser' }],
  },
  { _id: false }
);

const SupraSpaceMessageSchema = new Schema<ISupraSpaceMessage>(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'SupraSpaceConversation',
      required: true,
      index: true,
    },
    sender: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
    },
    content: {
      type: String,
      default: '',
      maxlength: 10000,
    },
    type: {
      type: String,
      enum: ['text', 'image', 'file', 'system'],
      default: 'text',
    },
    attachments: [AttachmentSchema],
    replyTo: {
      type: Schema.Types.ObjectId,
      ref: 'SupraSpaceMessage',
      default: null,
    },
    reactions: [ReactionSchema],
    readBy: [{ type: Schema.Types.ObjectId, ref: 'CrmUser' }],
    isEdited: { type: Boolean, default: false },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

SupraSpaceMessageSchema.index({ conversationId: 1, createdAt: -1 });

const SupraSpaceMessage = mongoose.model<ISupraSpaceMessage>(
  'SupraSpaceMessage',
  SupraSpaceMessageSchema
);

export default SupraSpaceMessage;