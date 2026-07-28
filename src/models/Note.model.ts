import mongoose, { Document, Schema } from 'mongoose';

export interface INote extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  authorName: string;
  authorAvatar?: string;
  text: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const NoteSchema = new Schema<INote>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'CrmUser', required: true },
    authorName: { type: String, required: true },
    authorAvatar: { type: String },
    text: { type: String, required: true, trim: true, maxlength: 100 },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// One active note per user per org — putNote upserts on this key.
NoteSchema.index({ organizationId: 1, userId: 1 }, { unique: true });
// TTL cleanup after 24h.
NoteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Note = mongoose.model<INote>('Note', NoteSchema);
export default Note;