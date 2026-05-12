import mongoose, { Document, Schema, Model } from 'mongoose';

export type NoteColor = 'yellow' | 'blue' | 'green' | 'pink' | 'purple' | 'orange';

export interface IBoardNote extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  userName: string;
  userAvatar?: string | null;
  title?: string;
  content: string;
  color: NoteColor;
  pinned: boolean;
  durationDays?: number | null;
  expiresAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IBoardNoteModel extends Model<IBoardNote> {}

const BoardNoteSchema = new Schema<IBoardNote>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    userName: { type: String, required: true, trim: true },
    userAvatar: { type: String, default: null },
    title: { type: String, trim: true, maxlength: 100 },
    content: { type: String, required: true, trim: true, maxlength: 1000 },
    color: { type: String, enum: ['yellow', 'blue', 'green', 'pink', 'purple', 'orange'], default: 'yellow' },
    pinned: { type: Boolean, default: false },
    durationDays: { type: Number, default: null },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true }
);

BoardNoteSchema.index({ organizationId: 1, pinned: -1, createdAt: -1 });
BoardNoteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $ne: null } } });

const BoardNote = mongoose.model<IBoardNote, IBoardNoteModel>('BoardNote', BoardNoteSchema);

export default BoardNote;
