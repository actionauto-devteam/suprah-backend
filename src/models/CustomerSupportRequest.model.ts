import mongoose, { Document, Schema } from 'mongoose';

export const SUPPORT_REQUEST_TYPES = ['vehicle_problem', 'paperwork', 'warranty', 'payment', 'other'] as const;
export const SUPPORT_REQUEST_STATUSES = ['open', 'in_progress', 'waiting_on_customer', 'resolved'] as const;

export type SupportRequestType = (typeof SUPPORT_REQUEST_TYPES)[number];
export type SupportRequestStatus = (typeof SUPPORT_REQUEST_STATUSES)[number];

export interface SupportActor {
  userId: string;
  name: string;
}

export interface SupportHistoryEntry {
  action: 'created' | 'status' | 'assigned' | 'note';
  from: string | null;
  to: string | null;
  note: string;
  by: SupportActor;
  at: Date;
}

export interface ICustomerSupportRequest extends Document {
  organizationId: string;
  customerId: mongoose.Types.ObjectId;
  leadId: mongoose.Types.ObjectId | null;
  type: SupportRequestType;
  details: string;
  status: SupportRequestStatus;
  assignedTo: mongoose.Types.ObjectId | null;
  assignedName: string;
  history: SupportHistoryEntry[];
  createdBy: SupportActor;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ActorSchema = new Schema<SupportActor>(
  {
    userId: { type: String, required: true },
    name: { type: String, default: '', maxlength: 160 },
  },
  { _id: false },
);

const HistorySchema = new Schema<SupportHistoryEntry>(
  {
    action: { type: String, enum: ['created', 'status', 'assigned', 'note'], required: true },
    from: { type: String, default: null },
    to: { type: String, default: null },
    note: { type: String, default: '', maxlength: 1000 },
    by: { type: ActorSchema, required: true },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const CustomerSupportRequestSchema = new Schema<ICustomerSupportRequest>(
  {
    organizationId: { type: String, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', default: null },
    type: { type: String, enum: SUPPORT_REQUEST_TYPES, required: true },
    details: { type: String, required: true, trim: true, maxlength: 2000 },
    status: { type: String, enum: SUPPORT_REQUEST_STATUSES, default: 'open' },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    assignedName: { type: String, default: '' },
    history: { type: [HistorySchema], default: [] },
    createdBy: { type: ActorSchema, required: true },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

CustomerSupportRequestSchema.index({ organizationId: 1, customerId: 1, createdAt: -1 });
CustomerSupportRequestSchema.index({ organizationId: 1, status: 1, updatedAt: -1 });

const CustomerSupportRequest = mongoose.model<ICustomerSupportRequest>('CustomerSupportRequest', CustomerSupportRequestSchema);

export default CustomerSupportRequest;
