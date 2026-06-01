import mongoose, { Document, Schema } from 'mongoose';

// ─── Attachment ───────────────────────────────────────────────────────────────

export interface ISupraSpaceAttachment {
  url: string;
  fileKey: string;
  originalName: string;
  mimeType: string;
  size: number;           // bytes
  thumbnailUrl?: string;
  duration?: number;      // seconds (voice notes)
}

// ─── Reaction ─────────────────────────────────────────────────────────────────

export interface ISupraSpaceReaction {
  emoji: string;
  users: mongoose.Types.ObjectId[];
}

// ─── GIF ──────────────────────────────────────────────────────────────────────

export interface ISupraSpaceGif {
  url: string;
  width?: number;
  height?: number;
  title?: string;
}

// ─── Poll ─────────────────────────────────────────────────────────────────────

export interface ISupraSpacePollOption {
  id: string;
  text: string;
  votes: mongoose.Types.ObjectId[];
}

export interface ISupraSpacePoll {
  question: string;
  options: ISupraSpacePollOption[];
  allowMultiple: boolean;
  closed: boolean;
}

// ─── Event ────────────────────────────────────────────────────────────────────

export interface ISupraSpaceEvent {
  title: string;
  description?: string;
  location?: string;
  startTime: Date;
  endTime?: Date | null;
  going: mongoose.Types.ObjectId[];
  maybe: mongoose.Types.ObjectId[];
  declined: mongoose.Types.ObjectId[];
}

// ─── Message metadata (customer concern) ─────────────────────────────────────

export interface ISupraSpaceMessageMetadata {
  isCustomerMessage?: boolean;
  customerUserId?: string | null;
  customerName?: string | null;
  customerEmail?: string | null;
  customerAvatar?: string | null;
  crmUserName?: string | null;
  crmUserRole?: string | null;
}

// ─── Message type ─────────────────────────────────────────────────────────────

export type SupraSpaceMessageType =
  | 'text' | 'image' | 'file' | 'system' | 'voice' | 'gif' | 'poll' | 'event';

// ─── Main interface ───────────────────────────────────────────────────────────

export interface ISupraSpaceMessage extends Document {
  conversationId: mongoose.Types.ObjectId;
  sender: mongoose.Types.ObjectId;
  content: string;
  type: SupraSpaceMessageType;
  attachments: ISupraSpaceAttachment[];
  gif?: ISupraSpaceGif | null;
  poll?: ISupraSpacePoll | null;
  event?: ISupraSpaceEvent | null;
  replyTo?: mongoose.Types.ObjectId;
  reactions: ISupraSpaceReaction[];
  readBy: mongoose.Types.ObjectId[];
  metadata: ISupraSpaceMessageMetadata;
  isEdited: boolean;
  isDeleted: boolean;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Sub-schemas ──────────────────────────────────────────────────────────────

const AttachmentSchema = new Schema<ISupraSpaceAttachment>(
  {
    url:          { type: String, required: true },
    fileKey:      { type: String, required: true },
    originalName: { type: String, required: true },
    mimeType:     { type: String, required: true },
    size:         { type: Number, required: true },
    thumbnailUrl: { type: String, default: null },
    duration:     { type: Number, default: null },
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

const GifSchema = new Schema<ISupraSpaceGif>(
  {
    url:    { type: String, required: true },
    width:  { type: Number, default: null },
    height: { type: Number, default: null },
    title:  { type: String, default: null },
  },
  { _id: false }
);

const PollOptionSchema = new Schema<ISupraSpacePollOption>(
  {
    id:    { type: String, required: true },
    text:  { type: String, required: true },
    votes: [{ type: Schema.Types.ObjectId, ref: 'CrmUser' }],
  },
  { _id: false }
);

const PollSchema = new Schema<ISupraSpacePoll>(
  {
    question:      { type: String, required: true },
    options:       { type: [PollOptionSchema], default: [] },
    allowMultiple: { type: Boolean, default: false },
    closed:        { type: Boolean, default: false },
  },
  { _id: false }
);

const EventSchema = new Schema<ISupraSpaceEvent>(
  {
    title:       { type: String, required: true },
    description: { type: String, default: '' },
    location:    { type: String, default: '' },
    startTime:   { type: Date, required: true },
    endTime:     { type: Date, default: null },
    going:       [{ type: Schema.Types.ObjectId, ref: 'CrmUser' }],
    maybe:       [{ type: Schema.Types.ObjectId, ref: 'CrmUser' }],
    declined:    [{ type: Schema.Types.ObjectId, ref: 'CrmUser' }],
  },
  { _id: false }
);

const MessageMetadataSchema = new Schema<ISupraSpaceMessageMetadata>(
  {
    isCustomerMessage: { type: Boolean, default: false },
    customerUserId:    { type: String, default: null },
    customerName:      { type: String, default: null },
    customerEmail:     { type: String, default: null },
    customerAvatar:    { type: String, default: null },
    crmUserName:       { type: String, default: null },
    crmUserRole:       { type: String, default: null },
  },
  { _id: false }
);

// ─── Main schema ──────────────────────────────────────────────────────────────

const SupraSpaceMessageSchema = new Schema<ISupraSpaceMessage>(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'SupraSpaceConversation',
      required: true,
      index: true,
    },
    sender:      { type: Schema.Types.ObjectId, ref: 'CrmUser', required: true },
    content:     { type: String, default: '', maxlength: 10000 },
    type: {
      type: String,
      enum: ['text', 'image', 'file', 'system', 'voice', 'gif', 'poll', 'event'],
      default: 'text',
    },
    attachments: [AttachmentSchema],
    gif:         { type: GifSchema, default: null },
    poll:        { type: PollSchema, default: null },
    event:       { type: EventSchema, default: null },
    replyTo:     { type: Schema.Types.ObjectId, ref: 'SupraSpaceMessage', default: null },
    reactions:   [ReactionSchema],
    readBy:      [{ type: Schema.Types.ObjectId, ref: 'CrmUser' }],
    metadata:    { type: MessageMetadataSchema, default: () => ({}) },
    isEdited:    { type: Boolean, default: false },
    isDeleted:   { type: Boolean, default: false },
    deletedAt:   { type: Date, default: null },
  },
  { timestamps: true }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

SupraSpaceMessageSchema.index({ conversationId: 1, createdAt: -1 });
// Text index for in-conversation message search
SupraSpaceMessageSchema.index({ content: 'text' });
// Customer concern: fast unread count queries
SupraSpaceMessageSchema.index({ conversationId: 1, 'metadata.isCustomerMessage': 1 });

// ─── Model ────────────────────────────────────────────────────────────────────

const SupraSpaceMessage = mongoose.model<ISupraSpaceMessage>(
  'SupraSpaceMessage',
  SupraSpaceMessageSchema
);

export default SupraSpaceMessage;