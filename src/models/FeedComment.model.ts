import mongoose, { Document, Schema, Model } from 'mongoose';


export interface IFeedCommentAttachment {
  url: string;
  fileKey: string;
  originalName: string;
  mimeType: string;
  size: number;
  thumbnailUrl?: string | null;
}

export interface IFeedComment extends Document {
  postId: mongoose.Types.ObjectId;
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  authorName: string;
  authorAvatar?: string;
  authorRole: string;
  content: string;
  attachments: IFeedCommentAttachment[];
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IFeedCommentModel extends Model<IFeedComment> {}


const FeedCommentSchema = new Schema<IFeedComment>(
  {
    postId: {
      type: Schema.Types.ObjectId,
      ref: 'Feed',
      required: true,
      index: true,
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
    attachments: {
      type: [
        new Schema<IFeedCommentAttachment>(
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
    deletedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

FeedCommentSchema.index({ postId: 1, createdAt: 1 });

const FeedComment = mongoose.model<IFeedComment, IFeedCommentModel>('FeedComment', FeedCommentSchema);

export default FeedComment;