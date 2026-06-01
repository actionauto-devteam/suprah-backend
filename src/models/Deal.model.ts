import mongoose, { Document, Schema, Model } from 'mongoose';

export type DealStage =
  | 'lead' | 'contacted' | 'proposal' | 'negotiation' | 'closed_won' | 'closed_lost';

export interface IDeal extends Document {
  organizationId: mongoose.Types.ObjectId;
  title: string;
  company?: string;
  contactName?: string;
  value?: number | null;
  currency: string;
  stage: DealStage;
  probability?: number | null;
  assignedTo?: mongoose.Types.ObjectId;
  assignedName?: string;
  assignedAvatar?: string;
  expectedCloseDate?: Date | null;
  note?: string;
  tags: string[];
  sortOrder: number;
  createdBy: mongoose.Types.ObjectId;
  createdByName: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IDealModel extends Model<IDeal> {}

const DealSchema = new Schema<IDeal>(
  {
    organizationId:  { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    title:           { type: String, required: true, trim: true, maxlength: 150 },
    company:         { type: String, trim: true, maxlength: 100 },
    contactName:     { type: String, trim: true, maxlength: 100 },
    value:           { type: Number, default: null },
    currency:        { type: String, default: 'USD', maxlength: 3 },
    stage: {
      type: String,
      enum: ['lead', 'contacted', 'proposal', 'negotiation', 'closed_won', 'closed_lost'],
      default: 'lead',
      index: true,
    },
    probability:     { type: Number, min: 0, max: 100, default: null },
    assignedTo:      { type: Schema.Types.ObjectId, ref: 'User', default: null },
    assignedName:    { type: String, default: null },
    assignedAvatar:  { type: String, default: null },
    expectedCloseDate: { type: Date, default: null },
    note:            { type: String, trim: true, maxlength: 1000 },
    tags:            { type: [String], default: [] },
    sortOrder:       { type: Number, default: 0 },
    createdBy:       { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdByName:   { type: String, required: true },
  },
  { timestamps: true }
);

DealSchema.index({ organizationId: 1, stage: 1, sortOrder: 1 });
DealSchema.index({ organizationId: 1, assignedTo: 1 });

const Deal = mongoose.model<IDeal, IDealModel>('Deal', DealSchema);
export default Deal;
