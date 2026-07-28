import mongoose, { Document, Schema, Model } from 'mongoose';

export type StoryMediaType = 'image' | 'video';

export interface IStoryReaction {
  userId: mongoose.Types.ObjectId;
  authorName: string;
  authorAvatar?: string;
  emoji: string;
  createdAt: Date;
}

export interface IStoryComment {
  userId: mongoose.Types.ObjectId;
  authorName: string;
  authorAvatar?: string;
  text: string;
  createdAt: Date;
}

export interface IStoryViewer {
  userId: mongoose.Types.ObjectId;
  name: string;
  avatar?: string;
  viewedAt: Date;
}

export interface IStory extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  authorName: string;
  authorAvatar?: string;
  authorRole?: string;
  media: {
    url: string;
    fileKey?: string;
    mimeType: string;
    mediaType: StoryMediaType;
    durationSec?: number;      // video only — enforced ≤ 120 on the client
    width?: number;
    height?: number;
    thumbnailUrl?: string;
    thumbnailKey?: string;
  };
  caption?: string;
  viewers: IStoryViewer[];
  reactions: IStoryReaction[];
  comments: IStoryComment[];   // public — visible to everyone who views the story
  expiresAt: Date;             // TTL — createdAt + 24h
  createdAt: Date;
  updatedAt: Date;
}

const StorySchema = new Schema<IStory>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'CrmUser', required: true, index: true },
    authorName: { type: String, required: true },
    authorAvatar: { type: String },
    authorRole: { type: String },
    media: {
      url: { type: String, required: true },
      fileKey: { type: String },
      mimeType: { type: String, required: true },
      mediaType: { type: String, enum: ['image', 'video'], required: true },
      durationSec: { type: Number },
      width: { type: Number },
      height: { type: Number },
      thumbnailUrl: { type: String },
      thumbnailKey: { type: String },
    },
    caption: { type: String, trim: true, maxlength: 300 },
    viewers: [
      {
        userId: { type: Schema.Types.ObjectId, ref: 'CrmUser', required: true },
        name: { type: String },
        avatar: { type: String },
        viewedAt: { type: Date, default: Date.now },
      },
    ],
    reactions: [
      {
        userId: { type: Schema.Types.ObjectId, ref: 'CrmUser', required: true },
        authorName: { type: String },
        authorAvatar: { type: String },
        emoji: { type: String, required: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    comments: [
      {
        userId: { type: Schema.Types.ObjectId, ref: 'CrmUser', required: true },
        authorName: { type: String },
        authorAvatar: { type: String },
        text: { type: String, required: true, trim: true, maxlength: 500 },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// Feed query: newest stories per org.
StorySchema.index({ organizationId: 1, createdAt: -1 });
// TTL — Mongo purges the document once expiresAt passes.
StorySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Story = mongoose.model<IStory>('Story', StorySchema);
export default Story;