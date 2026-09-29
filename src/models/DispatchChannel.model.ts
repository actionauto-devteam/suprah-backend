import mongoose, { Document, Model, Schema } from "mongoose";

/**
 * A Dispatch Chat channel: a group conversation between staff (from any
 * organization) and drivers. Rules (chosen by the business):
 * - only staff create channels; the creator is an administrator;
 * - the creator and administrators add or remove people and change roles,
 *   but nobody can remove or demote the creator;
 * - members can only suggest people; an administrator approves them;
 * - anyone except the creator can leave; the creator can close the channel,
 *   which keeps its history readable to its members (a closed channel is
 *   never reopened);
 * - people who leave or are removed lose access entirely;
 * - members send text, photos and files; everyone edits their own messages
 *   and deletes their own; administrators can delete anyone's messages.
 */

export const DISPATCH_CHANNEL_ROLES = ["admin", "member"] as const;
export type DispatchChannelRole = (typeof DISPATCH_CHANNEL_ROLES)[number];

export const DISPATCH_CHANNEL_SUGGESTION_STATUSES = ["pending", "approved", "declined"] as const;

export interface IDispatchChannelMember {
  userId: mongoose.Types.ObjectId;
  role: DispatchChannelRole;
  addedBy?: mongoose.Types.ObjectId;
  joinedAt: Date;
  lastReadAt?: Date | null;
}

export interface IDispatchChannelSuggestion {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  suggestedBy: mongoose.Types.ObjectId;
  status: (typeof DISPATCH_CHANNEL_SUGGESTION_STATUSES)[number];
  createdAt: Date;
  decidedBy?: mongoose.Types.ObjectId;
  decidedAt?: Date;
}

export interface IDispatchChannel extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  description?: string;
  /** The creator's organization when the channel was created. */
  organizationId: string;
  createdBy: mongoose.Types.ObjectId;
  status: "open" | "closed";
  closedAt?: Date | null;
  closedBy?: mongoose.Types.ObjectId | null;
  members: IDispatchChannelMember[];
  suggestions: IDispatchChannelSuggestion[];
  lastMessageAt?: Date | null;
  lastMessagePreview?: string;
  createdAt: Date;
  updatedAt: Date;
}

const memberSchema = new Schema<IDispatchChannelMember>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, enum: DISPATCH_CHANNEL_ROLES, required: true, default: "member" },
    addedBy: { type: Schema.Types.ObjectId, ref: "User" },
    joinedAt: { type: Date, required: true, default: Date.now },
    lastReadAt: { type: Date, default: null },
  },
  { _id: false },
);

const suggestionSchema = new Schema<IDispatchChannelSuggestion>({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  suggestedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  status: { type: String, enum: DISPATCH_CHANNEL_SUGGESTION_STATUSES, required: true, default: "pending" },
  createdAt: { type: Date, required: true, default: Date.now },
  decidedBy: { type: Schema.Types.ObjectId, ref: "User" },
  decidedAt: { type: Date },
});

const dispatchChannelSchema = new Schema<IDispatchChannel>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 500, default: "" },
    organizationId: { type: String, required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: ["open", "closed"], required: true, default: "open" },
    closedAt: { type: Date, default: null },
    closedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    members: { type: [memberSchema], default: [] },
    suggestions: { type: [suggestionSchema], default: [] },
    lastMessageAt: { type: Date, default: null },
    lastMessagePreview: { type: String, default: "", maxlength: 200 },
  },
  { timestamps: true },
);

// "My channels", newest activity first.
dispatchChannelSchema.index({ "members.userId": 1, lastMessageAt: -1 });

const DispatchChannel: Model<IDispatchChannel> =
  (mongoose.models.DispatchChannel as Model<IDispatchChannel>) ||
  mongoose.model<IDispatchChannel>("DispatchChannel", dispatchChannelSchema);

export default DispatchChannel;
