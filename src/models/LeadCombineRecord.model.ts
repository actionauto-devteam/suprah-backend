import mongoose, { Document, Schema, Types } from 'mongoose';

export interface LeadCombineMove {
  id: Types.ObjectId;
  fromLeadId: Types.ObjectId;
}

export interface ILeadCombineRecord extends Document {
  organizationId: Types.ObjectId;
  runId?: Types.ObjectId | null;
  mainLeadId: Types.ObjectId;
  combinedLeads: Array<{ leadId: Types.ObjectId; previousStatus: string }>;
  moved: {
    appointments: LeadCombineMove[];
    aiTasks: LeadCombineMove[];
    conversations: LeadCombineMove[];
  };
  mainBefore: { assignedTo?: Types.ObjectId | null; inquiryCount?: number | null };
  mainAfter: { assignedTo?: Types.ObjectId | null; inquiryCount?: number | null };
  filledContact: { phone?: string | null; email?: string | null };
  state: 'applying' | 'applied' | 'undone';
  undoneAt?: Date | null;
  undoneBy?: { userId?: string | null; name?: string | null } | null;
  createdAt: Date;
  updatedAt: Date;
}

const MoveSchema = new Schema(
  {
    id: { type: Schema.Types.ObjectId, required: true },
    fromLeadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
  },
  { _id: false },
);

const LeadCombineRecordSchema = new Schema<ILeadCombineRecord>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    runId: { type: Schema.Types.ObjectId, ref: 'LeadCombineRun', default: null },
    mainLeadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    combinedLeads: [
      new Schema(
        {
          leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
          previousStatus: { type: String, required: true },
        },
        { _id: false },
      ),
    ],
    moved: {
      appointments: { type: [MoveSchema], default: [] },
      aiTasks: { type: [MoveSchema], default: [] },
      conversations: { type: [MoveSchema], default: [] },
    },
    mainBefore: {
      assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      inquiryCount: { type: Number, default: null },
    },
    mainAfter: {
      assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      inquiryCount: { type: Number, default: null },
    },
    filledContact: {
      phone: { type: String, default: null },
      email: { type: String, default: null },
    },
    state: { type: String, enum: ['applying', 'applied', 'undone'], required: true },
    undoneAt: { type: Date, default: null },
    undoneBy: {
      type: new Schema({ userId: { type: String, default: null }, name: { type: String, default: null } }, { _id: false }),
      default: null,
    },
  },
  { timestamps: true },
);

LeadCombineRecordSchema.index({ organizationId: 1, mainLeadId: 1, createdAt: -1 });
LeadCombineRecordSchema.index({ organizationId: 1, 'combinedLeads.leadId': 1 });

const LeadCombineRecord = mongoose.model<ILeadCombineRecord>('LeadCombineRecord', LeadCombineRecordSchema);

export default LeadCombineRecord;
