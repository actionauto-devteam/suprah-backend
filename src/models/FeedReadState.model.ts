import mongoose, { Document, Schema, Model } from 'mongoose';

/**
 * FeedReadState — one document per (organisation, user).
 *
 * Tracks feed "seen" status with a watermark instead of per-post receipts:
 *   - `lastSeenAt`  — everything created at or before this instant counts as
 *                     seen. Advanced to "now" whenever the user opens Feeds.
 *   - `readPostIds` — posts *above* the watermark the user individually
 *                     marked as read (kept small; wiped on every watermark
 *                     advance since the watermark then covers them).
 *
 * Unseen-post badge count =
 *   live org posts, not authored by the user,
 *   createdAt > lastSeenAt, _id ∉ readPostIds.
 */

export interface IFeedReadState extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  lastSeenAt: Date;
  readPostIds: mongoose.Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

export interface IFeedReadStateModel extends Model<IFeedReadState> {}

const FeedReadStateSchema = new Schema<IFeedReadState>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
    },
    lastSeenAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    readPostIds: {
      type: [Schema.Types.ObjectId],
      default: [],
    },
  },
  { timestamps: true },
);

// One state doc per user per org.
FeedReadStateSchema.index({ organizationId: 1, userId: 1 }, { unique: true });

const FeedReadState = mongoose.model<IFeedReadState, IFeedReadStateModel>(
  'FeedReadState',
  FeedReadStateSchema,
);

export default FeedReadState;