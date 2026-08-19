import mongoose, { Document, Model, Schema } from 'mongoose';

/**
 * GmailMailboxItem — lightweight Gmail mailbox row index for Suprah One Desk.
 *
 * This is deliberately NOT the Email Chat MailMessage model. It stores only
 * the metadata required to render Inbox/Starred/Sent/Drafts/Trash quickly.
 * Full bodies, full threads and attachment bytes remain authoritative in Gmail
 * and continue to be fetched on demand through gmail.service.
 */
export interface IGmailMailboxItem extends Document {
  ownerCrmUserId: mongoose.Types.ObjectId;
  kind: 'message' | 'draft';
  gmailMessageId: string;
  gmailThreadId: string;
  draftId?: string;
  labelIds: string[];
  snippet: string;
  internalDate: number;
  subject: string;
  fromName: string;
  fromEmail: string;
  to: string;
  cc?: string;
  date: string;
  rfc822MessageId?: string;
  references?: string;
  isUnread: boolean;
  isStarred: boolean;
  syncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const GmailMailboxItemSchema = new Schema<IGmailMailboxItem>(
  {
    ownerCrmUserId: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
      index: true,
    },
    kind: {
      type: String,
      enum: ['message', 'draft'],
      required: true,
      default: 'message',
    },
    gmailMessageId: {
      type: String,
      required: true,
      trim: true,
    },
    gmailThreadId: {
      type: String,
      default: '',
      trim: true,
    },
    draftId: {
      type: String,
      trim: true,
    },
    labelIds: {
      type: [String],
      default: [],
    },
    snippet: {
      type: String,
      default: '',
    },
    internalDate: {
      type: Number,
      required: true,
      index: true,
    },
    subject: {
      type: String,
      default: '(no subject)',
    },
    fromName: {
      type: String,
      default: '',
    },
    fromEmail: {
      type: String,
      default: '',
      lowercase: true,
      trim: true,
    },
    to: {
      type: String,
      default: '',
    },
    cc: {
      type: String,
    },
    date: {
      type: String,
      default: '',
    },
    rfc822MessageId: {
      type: String,
    },
    references: {
      type: String,
    },
    isUnread: {
      type: Boolean,
      default: false,
    },
    isStarred: {
      type: Boolean,
      default: false,
    },
    syncedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: true },
);

// One Gmail message may appear in several mailboxes because labels overlap,
// but it is represented by exactly one local metadata document.
GmailMailboxItemSchema.index(
  { ownerCrmUserId: 1, gmailMessageId: 1 },
  { unique: true },
);

// Draft actions address Gmail's draft id rather than the underlying message id.
GmailMailboxItemSchema.index(
  { ownerCrmUserId: 1, draftId: 1 },
  {
    unique: true,
    partialFilterExpression: { draftId: { $type: 'string' } },
  },
);

// Fast normal mailbox reads.
GmailMailboxItemSchema.index({
  ownerCrmUserId: 1,
  labelIds: 1,
  internalDate: -1,
  _id: -1,
});

// Fast Drafts reads.
GmailMailboxItemSchema.index({
  ownerCrmUserId: 1,
  kind: 1,
  internalDate: -1,
  _id: -1,
});

const GmailMailboxItem = mongoose.model<
  IGmailMailboxItem,
  Model<IGmailMailboxItem>
>('GmailMailboxItem', GmailMailboxItemSchema);

export default GmailMailboxItem;