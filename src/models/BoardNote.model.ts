import mongoose, { Document, Schema, Model } from 'mongoose';

export type NoteColor =
  | 'yellow' | 'blue' | 'green' | 'pink' | 'purple' | 'orange'
  | 'red' | 'teal' | 'indigo' | 'lime' | 'rose' | 'sky';

export type AnnouncementType = 'general' | 'important' | 'urgent' | 'reminder' | 'event';

export interface IBoardNote extends Document {
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  userName: string;
  userAvatar?: string | null;
  title?: string;
  content: string;
  color: NoteColor;
  pinned: boolean;
  announcementType: AnnouncementType;
  emoji?: string;
  durationDays?: number | null;
  expiresAt?: Date | null;
  sortOrder?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface IBoardNoteModel extends Model<IBoardNote> {}

const BoardNoteSchema = new Schema<IBoardNote>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    userId:         { type: Schema.Types.ObjectId, ref: 'User', required: true },
    userName:       { type: String, required: true, trim: true },
    userAvatar:     { type: String, default: null },
    title:          { type: String, trim: true, maxlength: 100 },
    content:        { type: String, required: true, trim: true, maxlength: 1000 },
    color: {
      type: String,
      enum: ['yellow', 'blue', 'green', 'pink', 'purple', 'orange', 'red', 'teal', 'indigo', 'lime', 'rose', 'sky'],
      default: 'yellow',
    },
    pinned:           { type: Boolean, default: false },
    announcementType: { type: String, enum: ['general', 'important', 'urgent', 'reminder', 'event'], default: 'general' },
    emoji:            { type: String, maxlength: 10 },
    durationDays:     { type: Number, default: null },
    expiresAt:        { type: Date, default: null },
    sortOrder:        { type: Number, default: 0 },
  },
  { timestamps: true }
);

BoardNoteSchema.index({ organizationId: 1, pinned: -1, sortOrder: 1, createdAt: -1 });
BoardNoteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $ne: null } } });

const BoardNote = mongoose.model<IBoardNote, IBoardNoteModel>('BoardNote', BoardNoteSchema);

export default BoardNote;
