import mongoose, { Document, Schema } from 'mongoose';

export interface ITextFileLink extends Document {
  token: string;
  organizationId: string;
  key: string;
  name: string;
  contentType: string;
  size: number;
  leadId?: mongoose.Types.ObjectId | null;
  createdBy?: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const TextFileLinkSchema = new Schema<ITextFileLink>(
  {
    token: { type: String, required: true, unique: true },
    organizationId: { type: String, required: true, index: true },
    key: { type: String, required: true },
    name: { type: String, default: 'file' },
    contentType: { type: String, default: 'application/octet-stream' },
    size: { type: Number, default: 0 },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', default: null },
    createdBy: { type: String },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

TextFileLinkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const TextFileLink = mongoose.model<ITextFileLink>('TextFileLink', TextFileLinkSchema);

export default TextFileLink;
