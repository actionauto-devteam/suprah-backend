import mongoose, { Document, Schema, Model } from 'mongoose';

export interface ISupraSpaceConversation extends Document {
  type: 'direct' | 'group';
  name?: string;           // group name (optional for DMs)
  avatar?: string;         // group avatar
  members: mongoose.Types.ObjectId[];
  admins: mongoose.Types.ObjectId[];  // group admins
  lastMessage?: mongoose.Types.ObjectId;
  lastMessageAt?: Date;
  createdBy: mongoose.Types.ObjectId;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const SupraSpaceConversationSchema = new Schema<ISupraSpaceConversation>(
  {
    type: {
      type: String,
      enum: ['direct', 'group'],
      required: true,
      default: 'direct',
    },
    name: {
      type: String,
      trim: true,
      default: null,
    },
    avatar: {
      type: String,
      default: null,
    },
    members: [
      {
        type: Schema.Types.ObjectId,
        ref: 'CrmUser',
        required: true,
      },
    ],
    admins: [
      {
        type: Schema.Types.ObjectId,
        ref: 'CrmUser',
      },
    ],
    lastMessage: {
      type: Schema.Types.ObjectId,
      ref: 'SupraSpaceMessage',
      default: null,
    },
    lastMessageAt: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

// Index for fast member lookups
SupraSpaceConversationSchema.index({ members: 1 });
SupraSpaceConversationSchema.index({ lastMessageAt: -1 });

const SupraSpaceConversation = mongoose.model<ISupraSpaceConversation>(
  'SupraSpaceConversation',
  SupraSpaceConversationSchema
);

export default SupraSpaceConversation;