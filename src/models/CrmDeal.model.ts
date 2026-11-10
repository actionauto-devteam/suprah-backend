import mongoose, { Document, Schema } from 'mongoose';

export const CRM_DEAL_STAGES = ['new', 'working', 'offer_sent', 'negotiating', 'won', 'lost'] as const;
export type CrmDealStage = (typeof CRM_DEAL_STAGES)[number];

export interface DealActor {
  userId: string;
  name: string;
}

export interface DealOffer {
  _id?: mongoose.Types.ObjectId;
  amount: number;
  from: 'customer' | 'dealership';
  note: string;
  by: DealActor;
  at: Date;
}

export interface DealHistoryEntry {
  action: 'created' | 'stage' | 'assigned' | 'amount' | 'offer' | 'lead_sold';
  from: string | null;
  to: string | null;
  by: DealActor;
  at: Date;
}

export interface ICrmDeal extends Document {
  organizationId: string;
  leadId: mongoose.Types.ObjectId;
  customerId: mongoose.Types.ObjectId | null;
  title: string;
  customerName: string;
  vehicle: { vehicleId: mongoose.Types.ObjectId | null; label: string; vin: string; stock: string };
  stage: CrmDealStage;
  amount: number | null;
  offers: DealOffer[];
  assignedTo: mongoose.Types.ObjectId | null;
  assignedName: string;
  lostReason: string;
  wonAt: Date | null;
  lostAt: Date | null;
  history: DealHistoryEntry[];
  createdBy: DealActor & { kind: 'staff' | 'automation' };
  automationId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const ActorSchema = new Schema<DealActor>(
  {
    userId: { type: String, required: true },
    name: { type: String, default: '', maxlength: 160 },
  },
  { _id: false },
);

const OfferSchema = new Schema<DealOffer>({
  amount: { type: Number, required: true, min: 0 },
  from: { type: String, enum: ['customer', 'dealership'], required: true },
  note: { type: String, default: '', maxlength: 500 },
  by: { type: ActorSchema, required: true },
  at: { type: Date, required: true },
});

const HistorySchema = new Schema<DealHistoryEntry>(
  {
    action: { type: String, enum: ['created', 'stage', 'assigned', 'amount', 'offer', 'lead_sold'], required: true },
    from: { type: String, default: null },
    to: { type: String, default: null },
    by: { type: ActorSchema, required: true },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const CrmDealSchema = new Schema<ICrmDeal>(
  {
    organizationId: { type: String, required: true },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
    title: { type: String, required: true, trim: true, maxlength: 150 },
    customerName: { type: String, default: '', maxlength: 160 },
    vehicle: {
      vehicleId: { type: Schema.Types.ObjectId, ref: 'Vehicle', default: null },
      label: { type: String, default: '', maxlength: 160 },
      vin: { type: String, default: '' },
      stock: { type: String, default: '' },
    },
    stage: { type: String, enum: CRM_DEAL_STAGES, default: 'new' },
    amount: { type: Number, default: null, min: 0 },
    offers: { type: [OfferSchema], default: [] },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    assignedName: { type: String, default: '' },
    lostReason: { type: String, default: '', maxlength: 300 },
    wonAt: { type: Date, default: null },
    lostAt: { type: Date, default: null },
    history: { type: [HistorySchema], default: [] },
    createdBy: {
      userId: { type: String, required: true },
      name: { type: String, default: '' },
      kind: { type: String, enum: ['staff', 'automation'], default: 'staff' },
    },
    automationId: { type: String, default: null },
  },
  { timestamps: true },
);

CrmDealSchema.index({ organizationId: 1, stage: 1, updatedAt: -1 });
CrmDealSchema.index({ organizationId: 1, leadId: 1, createdAt: -1 });
CrmDealSchema.index({ organizationId: 1, customerId: 1, createdAt: -1 });

const CrmDeal = mongoose.model<ICrmDeal>('CrmDeal', CrmDealSchema);

export default CrmDeal;
