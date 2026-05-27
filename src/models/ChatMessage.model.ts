import mongoose, { Document, Schema } from "mongoose";

export interface IChatMessage extends Document {
  organizationId: string;
  content: string;

  createdBy: mongoose.Types.ObjectId;
  createdByModel: "User" | "CrmUser";
  authorName: string;
  authorRole: string;

  // Threaded replies — points at the parent message being replied to.
  replyTo?: mongoose.Types.ObjectId;

  isEdited: boolean;
  editedAt?: Date;

  // Soft delete so reply chains stay intact in the UI.
  isDeleted: boolean;
  deletedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const ChatMessageSchema = new Schema<IChatMessage>(
  {
    organizationId: {
      type: String,
      required: true,
      index: true,
    },
    content: {
      type: String,
      required: true,
      trim: true,
      maxlength: 4000,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      refPath: "createdByModel",
      required: true,
      index: true,
    },
    createdByModel: {
      type: String,
      required: true,
      enum: ["User", "CrmUser"],
      default: "CrmUser",
    },
    authorName: {
      type: String,
      required: true,
      trim: true,
    },
    authorRole: {
      type: String,
      required: true,
      trim: true,
    },
    replyTo: {
      type: Schema.Types.ObjectId,
      ref: "ChatMessage",
      default: null,
      index: true,
    },
    isEdited: {
      type: Boolean,
      default: false,
    },
    editedAt: { type: Date },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    deletedAt: { type: Date },
  },
  {
    timestamps: true,
  },
);

// Primary feed query: newest messages for an org.
ChatMessageSchema.index({ organizationId: 1, createdAt: -1 });

const ChatMessage = mongoose.model<IChatMessage>(
  "ChatMessage",
  ChatMessageSchema,
);

export default ChatMessage;