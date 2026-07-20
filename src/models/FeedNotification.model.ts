import mongoose, { Document, Schema, Model } from 'mongoose';

export const FEED_NOTIFICATION_TYPES = [
  'mention_post',
  'mention_comment',
  'comment_on_post',
  'all_announcement',
] as const;

export type FeedNotificationType = (typeof FEED_NOTIFICATION_TYPES)[number];

export interface IFeedNotification extends Document {
  organizationId: mongoose.Types.ObjectId;
  recipientId: mongoose.Types.ObjectId;
  actorId: mongoose.Types.ObjectId;
  actorName: string;
  type: FeedNotificationType;
  /** The Feed post (or DayPulse report) this notification points at. */
  postId: mongoose.Types.ObjectId;
  /** Set for comment-driven notifications. */
  commentId?: mongoose.Types.ObjectId | null;
  /** Plain-text preview of the triggering content (mention tokens stripped). */
  snippet: string;
  readAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IFeedNotificationModel extends Model<IFeedNotification> {}

const FeedNotificationSchema = new Schema<IFeedNotification>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    recipientId: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
      index: true,
    },
    actorId: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
    },
    actorName: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: FEED_NOTIFICATION_TYPES,
      required: true,
    },
    postId: {
      type: Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    commentId: {
      type: Schema.Types.ObjectId,
      default: null,
    },
    snippet: {
      type: String,
      default: '',
      maxlength: 200,
    },
    readAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

// Badge count: unread per recipient.
FeedNotificationSchema.index({ recipientId: 1, readAt: 1 });
// Activity panel: newest first per recipient.
FeedNotificationSchema.index({ recipientId: 1, createdAt: -1 });

const FeedNotification = mongoose.model<IFeedNotification, IFeedNotificationModel>(
  'FeedNotification',
  FeedNotificationSchema,
);

export default FeedNotification;