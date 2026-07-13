import mongoose, { Document, Schema, Model } from 'mongoose';

export const REACTION_TYPES = ['like', 'love', 'haha', 'wow', 'sad', 'angry'] as const;
export type ReactionType = typeof REACTION_TYPES[number];


export interface IFeedReaction extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId:         mongoose.Types.ObjectId;
  authorName:     string;
  targetType:     'post' | 'comment' | 'board_note';
  targetId:       mongoose.Types.ObjectId;
  reaction:       ReactionType;
  createdAt:      Date;
  updatedAt:      Date;
}

export interface IFeedReactionModel extends Model<IFeedReaction> {}


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


FeedReactionSchema.index({ targetId: 1, userId: 1 }, { unique: true });

FeedReactionSchema.index({ targetId: 1, reaction: 1 });


const FeedReaction = mongoose.model<IFeedReaction, IFeedReactionModel>(
  'FeedReaction',
  FeedReactionSchema
);

export default FeedReaction;