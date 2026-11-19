import mongoose, { Document, Schema } from 'mongoose';

export type LeadMentionVia = 'person' | 'team';

export interface ILeadMention extends Document {
  organizationId: mongoose.Types.ObjectId;
  leadId: mongoose.Types.ObjectId;
  noteId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  via: LeadMentionVia;
  groupId: mongoose.Types.ObjectId | null;
  groupName: string;
  authorName: string;
  authorType: string;
  text: string;
  mentionedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const LeadMentionSchema = new Schema<ILeadMention>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    noteId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    via: { type: String, enum: ['person', 'team'], required: true },
    groupId: { type: Schema.Types.ObjectId, ref: 'CrmLeadGroup', default: null },
    groupName: { type: String, default: '', maxlength: 120 },
    authorName: { type: String, default: '', maxlength: 160 },
    authorType: { type: String, default: 'user', maxlength: 20 },
    text: { type: String, default: '', maxlength: 500 },
    mentionedAt: { type: Date, required: true },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

LeadMentionSchema.index({ noteId: 1, userId: 1 }, { unique: true, name: 'lead_mention_note_user_unique' });
LeadMentionSchema.index({ organizationId: 1, userId: 1, completedAt: 1, mentionedAt: -1 }, { name: 'lead_mention_inbox' });

export default mongoose.model<ILeadMention>('LeadMention', LeadMentionSchema);
