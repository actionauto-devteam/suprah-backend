import mongoose, { Document, Schema, Model } from 'mongoose';

// ─── Interface ────────────────────────────────────────────────────────────────
// Defines the shape of a Feed document in TypeScript.
// Author fields are denormalised (copied from CrmUser at post time) so that
// posts remain readable even if the user's profile is later updated/deleted.

export interface IFeed extends Document {
  organizationId: mongoose.Types.ObjectId; // Scopes the post to one organisation (multi-tenancy)
  userId: mongoose.Types.ObjectId;         // References the author (CrmUser)
  authorName: string;                      // Snapshot of the author's name at post time
  authorAvatar?: string;                   // Snapshot of the author's avatar URL
  authorRole: string;                      // Snapshot of the author's role (employee | manager | admin)
  content: string;                         // The actual post body (max 5 000 chars)
  isEdited: boolean;                       // Flags whether the post has been edited after creation
  deletedAt?: Date | null;                 // Soft-delete timestamp — null means the post is live
  createdAt: Date;
  updatedAt: Date;
}

export interface IFeedModel extends Model<IFeed> {}

// ─── Schema ───────────────────────────────────────────────────────────────────

const FeedSchema = new Schema<IFeed>(
  {
    // Every post must belong to an organisation.
    // All feed queries filter by this field to prevent cross-org data leakage.
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },

    // The CrmUser who created this post.
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'CrmUser',
      required: true,
      index: true,
    },

    // Denormalised author info — stored at creation time so the feed stays
    // consistent even if the user changes their name/avatar later.
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

    // The post body. Trimmed on save, capped at 5 000 characters.
    content: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000,
    },

    // Set to true the first time a post is edited so the UI can show "(edited)".
    isEdited: {
      type: Boolean,
      default: false,
    },

    // Soft delete: instead of removing the document from the DB we stamp
    // this field with the deletion timestamp. All queries filter deletedAt: null.
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    // Automatically manages createdAt and updatedAt fields.
    timestamps: true,
  }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────
// Compound index: the most common query pattern is "all live posts for org X,
// sorted newest-first". This index serves that query without a collection scan.
FeedSchema.index({ organizationId: 1, createdAt: -1 });

// Speeds up the soft-delete filter (deletedAt: null) on large collections.
FeedSchema.index({ deletedAt: 1 });

// ─── Model ────────────────────────────────────────────────────────────────────

const Feed = mongoose.model<IFeed, IFeedModel>('Feed', FeedSchema);

export default Feed;