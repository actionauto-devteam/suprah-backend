import mongoose, { Document, Schema, Model } from 'mongoose';

// ─── Reaction Types ────────────────────────────────────────────────────────────
// Matches the emoji set shown in the UI picker.
export const REACTION_TYPES = ['like', 'love', 'haha', 'wow', 'sad', 'angry'] as const;
export type ReactionType = typeof REACTION_TYPES[number];

// ─── Interface ────────────────────────────────────────────────────────────────
// One document = one user's reaction on one target (post or comment).
// A user can only have ONE reaction per target — switching replaces the old one.

export interface IFeedReaction extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId:         mongoose.Types.ObjectId;
  authorName:     string;                  // Denormalised for display in "who reacted" lists
  targetType:     'post' | 'comment' | 'board_note';
  targetId:       mongoose.Types.ObjectId; // The Feed._id or FeedComment._id
  reaction:       ReactionType;
  createdAt:      Date;
  updatedAt:      Date;
}

export interface IFeedReactionModel extends Model<IFeedReaction> {}

// ─── Schema ───────────────────────────────────────────────────────────────────

const FeedReactionSchema = new Schema<IFeedReaction>(
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
    authorName: {
      type: String,
      required: true,
      trim: true,
    },
    targetType: {
      type: String,
      enum: ['post', 'comment', 'board_note'],
      required: true,
    },
    targetId: {
      type: Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    reaction: {
      type: String,
      enum: REACTION_TYPES,
      required: true,
    },
  },
  { timestamps: true }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

// Enforces one reaction per user per target — upsert logic relies on this.
FeedReactionSchema.index({ targetId: 1, userId: 1 }, { unique: true });

// Fast aggregation: "all reactions for post X grouped by type"
FeedReactionSchema.index({ targetId: 1, reaction: 1 });

// ─── Model ────────────────────────────────────────────────────────────────────

const FeedReaction = mongoose.model<IFeedReaction, IFeedReactionModel>(
  'FeedReaction',
  FeedReactionSchema
);

export default FeedReaction;