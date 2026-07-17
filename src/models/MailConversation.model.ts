import mongoose, { Document, Schema, Model } from 'mongoose';

/**
 * MailConversation — a chat-style conversation with one or more EXTERNAL
 * contacts, powered by Gmail underneath.
 *
 *  - A DIRECT conversation has exactly one external participant (the original
 *    1:1 behaviour).
 *  - A GROUP conversation has several external participants; every outbound
 *    message is addressed to all of them (reply-all), so it behaves like a
 *    true group thread — everyone sees everything.
 *
 * One conversation maps to a single Gmail thread (gmailThreadId) on the owner's
 * connected Gmail account. Messages sent from the Conversation tab go out as
 * real emails; inbound replies on the same thread (or, as a fallback, from a
 * known participant on the same subject) are pulled in by the mail sync engine
 * and rendered as chat bubbles in real time.
 *
 * Email has no true "membership" primitive: a participant added later only
 * receives messages sent AFTER they were added (earlier emails already went out
 * without them). `addedAt` records when each participant joined so the UI can
 * explain this.
 */

export interface IMailParticipant {
  email: string;
  name?: string;
  addedAt: Date;
}

export interface IMailConversation extends Document {
  organizationId: mongoose.Types.ObjectId;
  ownerCrmUserId: mongoose.Types.ObjectId;   // CRM user who owns this conversation
  type: 'direct' | 'group';
  participants: IMailParticipant[];           // the outside members (never includes the owner)
  title?: string;                             // optional group name; falls back to participant list
  subject: string;                            // email subject used for the underlying thread
  gmailThreadId?: string;                     // set after the first message is sent/received
  lastMessageAt?: Date;
  lastMessagePreview?: string;
  lastMessageDirection?: 'inbound' | 'outbound';
  lastMessageFromName?: string;               // who sent the last message (matters in groups)
  unreadCount: number;                        // inbound messages the owner hasn't opened
  isArchived: boolean;
  createdAt: Date;
  updatedAt: Date;

  /* ── Back-compat accessors ──────────────────────────────────────────────
     Older code and the DIRECT UI read `externalEmail` / `externalName`.
     These virtuals expose the first participant so nothing breaks. */
  externalEmail: string;
  externalName?: string;
}

const ParticipantSchema = new Schema<IMailParticipant>(
  {
    email: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, trim: true },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const MailConversationSchema = new Schema<IMailConversation>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    ownerCrmUserId: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['direct', 'group'],
      default: 'direct',
      required: true,
    },
    participants: {
      type: [ParticipantSchema],
      required: true,
      validate: {
        validator: (v: IMailParticipant[]) => Array.isArray(v) && v.length > 0,
        message: 'A conversation needs at least one participant.',
      },
    },
    title: {
      type: String,
      trim: true,
    },
    subject: {
      type: String,
      required: true,
      trim: true,
    },
    gmailThreadId: {
      type: String,
      index: true,
    },
    lastMessageAt: {
      type: Date,
      default: null,
    },
    lastMessagePreview: {
      type: String,
      default: '',
    },
    lastMessageDirection: {
      type: String,
      enum: ['inbound', 'outbound'],
    },
    lastMessageFromName: {
      type: String,
      trim: true,
    },
    unreadCount: {
      type: Number,
      default: 0,
    },
    isArchived: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

/* ── Virtuals: keep the old single-contact shape working ─────────────────── */
MailConversationSchema.virtual('externalEmail').get(function (this: IMailConversation) {
  return this.participants?.[0]?.email || '';
});
MailConversationSchema.virtual('externalName').get(function (this: IMailConversation) {
  return this.participants?.[0]?.name;
});

/* ── Indexes ─────────────────────────────────────────────────────────────── */
// Reuse an open DIRECT conversation per single participant + subject.
MailConversationSchema.index({ ownerCrmUserId: 1, 'participants.email': 1, subject: 1 });
// Fast lookup used by the sync engine to route inbound Gmail messages.
MailConversationSchema.index({ ownerCrmUserId: 1, gmailThreadId: 1 });
// Fallback matcher: find the owner's non-archived conversations by subject.
MailConversationSchema.index({ ownerCrmUserId: 1, subject: 1, isArchived: 1 });

const MailConversation = mongoose.model<IMailConversation, Model<IMailConversation>>(
  'MailConversation',
  MailConversationSchema,
);

export default MailConversation;