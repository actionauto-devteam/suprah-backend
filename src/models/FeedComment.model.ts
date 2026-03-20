import mongoose, { Document, Schema, Model } from 'mongoose';

// ─── Interface ────────────────────────────────────────────────────────────────
// A FeedComment belongs to exactly one Feed post and one CrmUser.
// Author fields are denormalised (copied at comment time) so comments remain
// readable even if the author's profile changes later.

export interface IFeedComment extends Document {
  postId: mongoose.Types.ObjectId;         // The Feed post this comment belongs to
  organizationId: mongoose.Types.ObjectId; // Mirrors the post's org for fast scoped queries
  userId: mongoose.Types.ObjectId;         // The commenter (CrmUser)
  authorName: string;                      // Snapshot of commenter's name
  authorAvatar?: string;                   // Snapshot of commenter's avatar
  authorRole: string;                      // Snapshot of commenter's role
  content: string;                         // Comment body (max 1 000 chars)
  deletedAt?: Date | null;                 // Soft-delete timestamp
  createdAt: Date;
  updatedAt: Date;
}

export interface IFeedCommentModel extends Model<IFeedComment> {}

// ─── Schema ───────────────────────────────────────────────────────────────────

const FeedCommentSchema = new Schema<IFeedComment>(
  {
    postId: {
      type: Schema.Types.ObjectId,
      ref: 'Feed',
      required: true,
      index: true, // Most queries start with "all comments for post X"
    },
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
    authorName: {
      type: String,
      required: true,
      trim: true,
    },
    authorAvatar: {
      type: String,
      default: null,
    },
    authorRole: {
      type: String,
      default: 'employee',
    },
    content: {
      type: String,
      required: true,
      trim: true,
      maxlength: 1000,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

// Compound index: "all live comments for post X ordered oldest-first"
// — the most common query pattern for rendering a comment thread
FeedCommentSchema.index({ postId: 1, createdAt: 1 });

const FeedComment = mongoose.model<IFeedComment, IFeedCommentModel>('FeedComment', FeedCommentSchema);

export default FeedComment;