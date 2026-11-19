import mongoose, { Schema, Document, Types } from 'mongoose';
import { DEAL_STAGES, DEAL_SOURCES, DOCUMENT_KINDS, DealStage, DealSource, DealDocumentKind } from '../services/dealDesk/constants';

export interface IDealPersonRef {
  id?: Types.ObjectId;
  name?: string;
}

export interface IDealStageEntry {
  stage: DealStage;
  enteredAt: Date;
  exitedAt?: Date;
  durationMs?: number;
  actorId?: Types.ObjectId;
  actorName?: string;
}

export interface IDealDocument {
  _id: Types.ObjectId;
  kind: DealDocumentKind;
  name: string;
  key: string;
  mime: string;
  size: number;
  uploadedBy?: IDealPersonRef;
  uploadedAt: Date;
  extracted?: Record<string, unknown>;
}

export interface IDealFlag {
  level: 'block' | 'warn' | 'info';
  code: string;
  message: string;
}

export interface IDealLenderMatch {
  lenderId?: Types.ObjectId;
  name: string;
  type?: string;
  fit: 'strong' | 'good' | 'stretch' | 'fail';
  score: number;
  rate?: number;
  rateMax?: number;
  term?: number;
  payment?: number;
  dti?: number;
  pti?: number;
  reasons: string[];
}

export interface IDealOfferAttempt {
  fmId: Types.ObjectId;
  fmName?: string;
  offeredAt: Date;
  outcome: 'accepted' | 'declined' | 'expired' | 'withdrawn';
  at: Date;
  round: number;
}

export interface IDealDeskDeal extends Document {
  organizationId: Types.ObjectId;
  dealNumber: number;
  source: DealSource;
  stage: DealStage;
  stageEnteredAt: Date;
  stageHistory: IDealStageEntry[];
  slaNotifiedStage?: DealStage;

  salesperson?: IDealPersonRef;
  reviewer?: IDealPersonRef;
  financeManager?: IDealPersonRef;
  createdBy?: IDealPersonRef;

  customer: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    dob?: Date;
    address?: { street?: string; city?: string; state?: string; zip?: string };
    leadId?: Types.ObjectId;
  };
  coBuyer?: {
    present?: boolean;
    firstName?: string;
    lastName?: string;
    grossMonthlyIncome?: number;
  };
  vehicle: {
    vin?: string;
    stockNumber?: string;
    year?: number;
    make?: string;
    model?: string;
    trim?: string;
    mileage?: number;
    condition?: 'new' | 'used' | 'cpo';
    price?: number;
    bookValue?: number;
    bookSource?: string;
  };
  tradeIn: {
    present?: boolean;
    vin?: string;
    year?: number;
    make?: string;
    model?: string;
    mileage?: number;
    allowance?: number;
    payoff?: number;
    lienholder?: string;
  };
  fourSquare: {
    salePrice?: number;
    docFee?: number;
    otherFees?: number;
    taxRate?: number;
    downPayment?: number;
    backendProducts?: number;
    desiredPayment?: number;
    desiredTerm?: number;
  };
  creditApp: {
    employer?: string;
    jobTitle?: string;
    employmentMonths?: number;
    grossMonthlyIncome?: number;
    otherMonthlyIncome?: number;
    housingStatus?: 'own' | 'rent' | 'family' | 'other';
    housingPayment?: number;
    residenceMonths?: number;
    monthlyDebt?: number;
    creditScore?: number;
    creditScoreSource?: 'self_reported' | 'bureau' | 'lender';
    ssnLast4?: string;
    ssnEncrypted?: string;
    consent?: { granted: boolean; at?: Date; ip?: string; text?: string };
  };
  documents: Types.DocumentArray<IDealDocument & Document>;

  analysis?: {
    computedAt: Date;
    rulesVersion: string;
    taxAmount: number;
    netTrade: number;
    amountFinanced: number;
    bookValueUsed?: number;
    ltv?: number;
    dti?: number;
    pti?: number;
    estRate?: number;
    estTerm?: number;
    estPayment?: number;
    readiness: number;
    flags: IDealFlag[];
    aiSummary?: string;
    aiProvider?: string;
    extraction?: Record<string, unknown>;
  };
  lenderMatches: IDealLenderMatch[];

  offer?: {
    fmId?: Types.ObjectId;
    fmName?: string;
    offeredAt?: Date;
    expiresAt?: Date;
    round: number;
  };
  offerAttempts: IDealOfferAttempt[];
  escalatedAt?: Date;

  timestamps: {
    submittedAt?: Date;
    firstPickedUpAt?: Date;
    analyzedAt?: Date;
    approvedAt?: Date;
    firstOfferedAt?: Date;
    acceptedAt?: Date;
    signedAt?: Date;
    fundedAt?: Date;
    cancelledAt?: Date;
  };
  needsInfoNote?: string;
  cancelReason?: string;
  depositRequested?: boolean;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PersonRef = new Schema<IDealPersonRef>(
  { id: { type: Schema.Types.ObjectId }, name: String },
  { _id: false },
);

const StageEntrySchema = new Schema<IDealStageEntry>(
  {
    stage: { type: String, enum: DEAL_STAGES, required: true },
    enteredAt: { type: Date, required: true },
    exitedAt: Date,
    durationMs: Number,
    actorId: Schema.Types.ObjectId,
    actorName: String,
  },
  { _id: false },
);

const DocumentSchema = new Schema<IDealDocument>({
  kind: { type: String, enum: DOCUMENT_KINDS, required: true },
  name: { type: String, required: true },
  key: { type: String, required: true },
  mime: { type: String, required: true },
  size: { type: Number, required: true },
  uploadedBy: PersonRef,
  uploadedAt: { type: Date, default: Date.now },
  extracted: Schema.Types.Mixed,
});

const FlagSchema = new Schema<IDealFlag>(
  { level: { type: String, enum: ['block', 'warn', 'info'] }, code: String, message: String },
  { _id: false },
);

const LenderMatchSchema = new Schema<IDealLenderMatch>(
  {
    lenderId: Schema.Types.ObjectId,
    name: String,
    type: String,
    fit: { type: String, enum: ['strong', 'good', 'stretch', 'fail'] },
    score: Number,
    rate: Number,
    rateMax: Number,
    term: Number,
    payment: Number,
    dti: Number,
    pti: Number,
    reasons: [String],
  },
  { _id: false },
);

const OfferAttemptSchema = new Schema<IDealOfferAttempt>(
  {
    fmId: { type: Schema.Types.ObjectId, required: true },
    fmName: String,
    offeredAt: Date,
    outcome: { type: String, enum: ['accepted', 'declined', 'expired', 'withdrawn'] },
    at: Date,
    round: Number,
  },
  { _id: false },
);

const DealDeskDealSchema = new Schema<IDealDeskDeal>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    dealNumber: { type: Number, required: true },
    source: { type: String, enum: DEAL_SOURCES, default: 'supra' },
    stage: { type: String, enum: DEAL_STAGES, default: 'draft', index: true },
    stageEnteredAt: { type: Date, default: Date.now },
    stageHistory: { type: [StageEntrySchema], default: [] },
    slaNotifiedStage: { type: String, enum: DEAL_STAGES },

    salesperson: PersonRef,
    reviewer: PersonRef,
    financeManager: PersonRef,
    createdBy: PersonRef,

    customer: {
      firstName: { type: String, trim: true },
      lastName: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
      phone: { type: String, trim: true },
      dob: Date,
      address: { street: String, city: String, state: String, zip: String },
      leadId: Schema.Types.ObjectId,
    },
    coBuyer: {
      present: Boolean,
      firstName: String,
      lastName: String,
      grossMonthlyIncome: Number,
    },
    vehicle: {
      vin: { type: String, trim: true, uppercase: true },
      stockNumber: { type: String, trim: true },
      year: Number,
      make: String,
      model: String,
      trim: String,
      mileage: Number,
      condition: { type: String, enum: ['new', 'used', 'cpo'] },
      price: Number,
      bookValue: Number,
      bookSource: String,
    },
    tradeIn: {
      present: Boolean,
      vin: { type: String, trim: true, uppercase: true },
      year: Number,
      make: String,
      model: String,
      mileage: Number,
      allowance: Number,
      payoff: Number,
      lienholder: String,
    },
    fourSquare: {
      salePrice: Number,
      docFee: Number,
      otherFees: Number,
      taxRate: Number,
      downPayment: Number,
      backendProducts: Number,
      desiredPayment: Number,
      desiredTerm: Number,
    },
    creditApp: {
      employer: String,
      jobTitle: String,
      employmentMonths: Number,
      grossMonthlyIncome: Number,
      otherMonthlyIncome: Number,
      housingStatus: { type: String, enum: ['own', 'rent', 'family', 'other'] },
      housingPayment: Number,
      residenceMonths: Number,
      monthlyDebt: Number,
      creditScore: Number,
      creditScoreSource: { type: String, enum: ['self_reported', 'bureau', 'lender'] },
      ssnLast4: String,
      // AES-256-GCM ciphertext — never returned by default (see serialize.ts)
      ssnEncrypted: { type: String, select: false },
      consent: { granted: Boolean, at: Date, ip: String, text: String },
    },
    documents: { type: [DocumentSchema], default: [] },

    analysis: {
      computedAt: Date,
      rulesVersion: String,
      taxAmount: Number,
      netTrade: Number,
      amountFinanced: Number,
      bookValueUsed: Number,
      ltv: Number,
      dti: Number,
      pti: Number,
      estRate: Number,
      estTerm: Number,
      estPayment: Number,
      readiness: Number,
      flags: { type: [FlagSchema], default: undefined },
      aiSummary: String,
      aiProvider: String,
      extraction: Schema.Types.Mixed,
    },
    lenderMatches: { type: [LenderMatchSchema], default: [] },

    offer: {
      fmId: Schema.Types.ObjectId,
      fmName: String,
      offeredAt: Date,
      expiresAt: { type: Date, index: true },
      round: { type: Number, default: 1 },
    },
    offerAttempts: { type: [OfferAttemptSchema], default: [] },
    escalatedAt: Date,

    timestamps: {
      submittedAt: Date,
      firstPickedUpAt: Date,
      analyzedAt: Date,
      approvedAt: Date,
      firstOfferedAt: Date,
      acceptedAt: Date,
      signedAt: Date,
      fundedAt: Date,
      cancelledAt: Date,
    },
    needsInfoNote: String,
    cancelReason: String,
    depositRequested: Boolean,
    lastActivityAt: { type: Date, default: Date.now },
  },
  { timestamps: true, collection: 'dealdesk_deals' },
);

DealDeskDealSchema.index({ organizationId: 1, dealNumber: 1 }, { unique: true });
DealDeskDealSchema.index({ organizationId: 1, stage: 1, stageEnteredAt: 1 });
DealDeskDealSchema.index({ organizationId: 1, 'salesperson.id': 1, createdAt: -1 });
DealDeskDealSchema.index({ stage: 1, 'offer.expiresAt': 1 });
DealDeskDealSchema.index({ organizationId: 1, createdAt: -1 });

export default (mongoose.models.DealDeskDeal as mongoose.Model<IDealDeskDeal>) ||
  mongoose.model<IDealDeskDeal>('DealDeskDeal', DealDeskDealSchema);
