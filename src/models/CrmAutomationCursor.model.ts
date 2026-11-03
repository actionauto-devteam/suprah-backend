import mongoose, { Document, Schema } from 'mongoose';

export interface ICrmAutomationCursor extends Document {
  key: string;
  at: Date;
}

const CrmAutomationCursorSchema = new Schema<ICrmAutomationCursor>(
  {
    key: { type: String, required: true, unique: true },
    at: { type: Date, required: true },
  },
  { timestamps: true },
);

const CrmAutomationCursor = mongoose.model<ICrmAutomationCursor>('CrmAutomationCursor', CrmAutomationCursorSchema);

export default CrmAutomationCursor;
