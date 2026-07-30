import mongoose, { Document, Schema, Model } from 'mongoose';


export interface IFeedAttachment {
  url: string;
  fileKey: string;
  originalName: string;
  mimeType: string;
  size: number;
  thumbnailUrl?: string | null;
}

export interface IFeed extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  authorName: string;
  authorAvatar?: string;
  authorRole: string;
  content: string;
  attachments: IFeedAttachment[];
  isEdited: boolean;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IFeedModel extends Model<IFeed> {}


const FeedSchema = new Schema<IFeed>(
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
      index: true,
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
      // Not required at the schema level — attachment-only posts (no text)
      // are valid and enforced instead by the controller, which rejects
      // only when BOTH content and attachments are empty. Mongoose's
      // required validator treats "" as missing, which would otherwise
      // reject every attachment-only post.
      default: '',
      trim: true,
      // Visible-text limit stays 5000 (enforced in the controller against the
      // mention-stripped content). The raw string carries headroom because
      // mention tokens `@[Name](24-hex-id)` are longer than the "@Name" the
      // author actually sees.
      maxlength: 7000,
    },

    attachments: {
      type: [
        new Schema<IFeedAttachment>(
          {
            url: { type: String, required: true },
            fileKey: { type: String, required: true },
            originalName: { type: String, required: true },
            mimeType: { type: String, required: true },
            size: { type: Number, required: true },
            thumbnailUrl: { type: String, default: null },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    isEdited: {
      type: Boolean,
      default: false,
    },

    deletedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

FeedSchema.index({ organizationId: 1, createdAt: -1 });

FeedSchema.index({ deletedAt: 1 });


const Feed = mongoose.model<IFeed, IFeedModel>('Feed', FeedSchema);

export default Feed;