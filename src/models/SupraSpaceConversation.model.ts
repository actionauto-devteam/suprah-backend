import mongoose, { Document, Schema } from 'mongoose';

export interface ISupraSpaceTheme {
  accent?: string | null;     // primary accent / own-bubble color
  bubble?: string | null;     // own bubble color override
  wallpaper?: string | null;  // CSS background (gradient or url)
  emoji?: string | null;      // quick-reaction default emoji
}

export interface ISupraSpaceConversation extends Document {
  type: 'direct' | 'group';
  name?: string;                        // group name (optional for DMs)
  avatar?: string;                      // group avatar URL
  avatarKey?: string;                   // R2 key for the avatar
  members: mongoose.Types.ObjectId[];
  admins: mongoose.Types.ObjectId[];    // group admins
  pinnedBy: mongoose.Types.ObjectId[];  // users who pinned this conversation
  archivedBy: mongoose.Types.ObjectId[];// users who archived this conversation
  deletedFor: mongoose.Types.ObjectId[];// users who deleted (hid) this conversation
  theme: ISupraSpaceTheme;
  lastMessage?: mongoose.Types.ObjectId;
  lastMessageAt?: Date;
  createdBy: mongoose.Types.ObjectId;
  isActive: boolean;
  deletedAt?: Date | null;              // hard-delete timestamp (channel removed)
  createdAt: Date;
  updatedAt: Date;
}

const ThemeSchema = new Schema<ISupraSpaceTheme>(
  {
    accent: { type: String, default: null },
    bubble: { type: String, default: null },
    wallpaper: { type: String, default: null },
    emoji: { type: String, default: null },
  },
  { _id: false }
);

const SupraSpaceConversationSchema = new Schema<ISupraSpaceConversation>(
  {
    type: {
      type: String,
      enum: ['direct', 'group'],
      required: true,
      default: 'direct',
    },
    name: { type: String, trim: true, default: null },
    avatar: { type: String, default: null },
    avatarKey: { type: String, default: null },
    members: [{ type: Schema.Types.ObjectId, ref: 'CrmUser', required: true }],
    admins: [{ type: Schema.Types.ObjectId, ref: 'CrmUser' }],
    pinnedBy: [{ type: Schema.Types.ObjectId, ref: 'CrmUser' }],
    archivedBy: [{ type: Schema.Types.ObjectId, ref: 'CrmUser' }],
    deletedFor: [{ type: Schema.Types.ObjectId, ref: 'CrmUser' }],
    theme: { type: ThemeSchema, default: () => ({}) },
    lastMessage: { type: Schema.Types.ObjectId, ref: 'SupraSpaceMessage', default: null },
    lastMessageAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'CrmUser', required: true },
    isActive: { type: Boolean, default: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

SupraSpaceConversationSchema.index({ members: 1 });
SupraSpaceConversationSchema.index({ lastMessageAt: -1 });

const SupraSpaceConversation = mongoose.model<ISupraSpaceConversation>(
  'SupraSpaceConversation',
  SupraSpaceConversationSchema
);

export default SupraSpaceConversation;