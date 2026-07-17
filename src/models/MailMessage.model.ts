import mongoose, { Document, Schema, Model } from 'mongoose';

export interface IMailAttachmentRef {
  originalName: string;
  mimeType: string;
  size: number;
  /**
   * Storage key/URL. Outbound attachments are persisted to R2 through the
   * shared storageService (public bucket → full URL). Inbound attachments
   * keep a Gmail reference and are streamed on demand through the
   * /attachments proxy endpoint, then optionally cached to R2.
   */
  storageUrl?: string;          // R2 public URL (outbound / cached inbound)
  gmailMessageId?: string;      // inbound: Gmail message the attachment lives on
  gmailAttachmentId?: string;   // inbound: Gmail attachment id
}

export interface IMailMessage extends Document {
  conversationId: mongoose.Types.ObjectId;
  organizationId: mongoose.Types.ObjectId;
  ownerCrmUserId: mongoose.Types.ObjectId;
  direction: 'inbound' | 'outbound';
  fromEmail: string;
  fromName?: string;
  toEmail: string;
  bodyText: string;             // plain-text body rendered in the chat bubble
  bodyHtml?: string;            // original HTML (kept for fidelity / "view original")
  attachments: IMailAttachmentRef[];
  gmailMessageId?: string;      // dedupe key — one Gmail message = one chat bubble
  gmailThreadId?: string;
  rfc822MessageId?: string;     // Message-ID header, used for In-Reply-To threading
  status: 'sending' | 'sent' | 'delivered' | 'failed';
  errorMessage?: string;
  readByOwner: boolean;
  sentAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const MailMessageSchema = new Schema<IMailMessage>(
  {
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'MailConversation',
      required: true,
      index: true,
    },
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
    ownerCrmUserId: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
      index: true,
    },
    direction: {
      type: String,
      enum: ['inbound', 'outbound'],
      required: true,
    },
    fromEmail: { type: String, required: true, trim: true, lowercase: true },
    fromName: { type: String, trim: true },
    toEmail: { type: String, required: true, trim: true, lowercase: true },
    bodyText: { type: String, default: '' },
    bodyHtml: { type: String },
    attachments: [
      {
        originalName: { type: String, required: true },
        mimeType: { type: String, required: true },
        size: { type: Number, required: true },
        storageUrl: { type: String },
        gmailMessageId: { type: String },
        gmailAttachmentId: { type: String },
      },
    ],
    gmailMessageId: { type: String, index: true },
    gmailThreadId: { type: String },
    rfc822MessageId: { type: String },
    status: {
      type: String,
      enum: ['sending', 'sent', 'delivered', 'failed'],
      default: 'sent',
    },
    errorMessage: { type: String },
    readByOwner: {
      type: Boolean,
      default: false,
    },
    sentAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

MailMessageSchema.index({ conversationId: 1, sentAt: 1 });
// Hard dedupe guard: the sync engine may see the same Gmail message from
// multiple code paths (send echo + history sync) — never store it twice.
MailMessageSchema.index(
  { ownerCrmUserId: 1, gmailMessageId: 1 },
  { unique: true, partialFilterExpression: { gmailMessageId: { $type: 'string' } } },
);

const MailMessage = mongoose.model<IMailMessage, Model<IMailMessage>>(
  'MailMessage',
  MailMessageSchema,
);

export default MailMessage;