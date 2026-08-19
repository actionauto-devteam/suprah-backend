import mongoose, { Document, Model, Schema } from 'mongoose';

export type IndexedMailboxId =
  | 'INBOX'
  | 'STARRED'
  | 'SENT'
  | 'DRAFTS'
  | 'TRASH';

export interface IGmailMailboxCoverage {
  ready: boolean;
  fullyIndexed: boolean;
  nextGmailPageToken?: string;
  lastIndexedAt?: Date;
}

export interface IGmailMailboxIndexState extends Document {
  ownerCrmUserId: mongoose.Types.ObjectId;
  version: number;
  status: 'pending' | 'running' | 'ready' | 'error';
  mailboxes: Record<IndexedMailboxId, IGmailMailboxCoverage>;
  lastBootstrapAt?: Date;
  lastSyncAt?: Date;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CoverageSchema = new Schema<IGmailMailboxCoverage>(
  {
    ready: { type: Boolean, default: false },
    fullyIndexed: { type: Boolean, default: false },
    nextGmailPageToken: { type: String },
    lastIndexedAt: { type: Date },
  },
  { _id: false },
);

const GmailMailboxIndexStateSchema = new Schema<IGmailMailboxIndexState>(
  {
    ownerCrmUserId: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
      unique: true,
      index: true,
    },
    version: {
      type: Number,
      required: true,
      default: 1,
    },
    status: {
      type: String,
      enum: ['pending', 'running', 'ready', 'error'],
      default: 'pending',
      index: true,
    },
    mailboxes: {
      INBOX: { type: CoverageSchema, default: () => ({}) },
      STARRED: { type: CoverageSchema, default: () => ({}) },
      SENT: { type: CoverageSchema, default: () => ({}) },
      DRAFTS: { type: CoverageSchema, default: () => ({}) },
      TRASH: { type: CoverageSchema, default: () => ({}) },
    },
    lastBootstrapAt: { type: Date },
    lastSyncAt: { type: Date },
    lastError: { type: String },
  },
  { timestamps: true },
);

const GmailMailboxIndexState = mongoose.model<
  IGmailMailboxIndexState,
  Model<IGmailMailboxIndexState>
>('GmailMailboxIndexState', GmailMailboxIndexStateSchema);

export default GmailMailboxIndexState;