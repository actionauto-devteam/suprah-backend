import mongoose, { Document, Schema } from 'mongoose';

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface ICustomerTransaction {
  _id?: mongoose.Types.ObjectId;
  type: 'lead' | 'appointment' | 'purchase' | 'quote' | 'inquiry' | 'other';
  status: 'pending' | 'active' | 'completed' | 'cancelled' | 'failed';
  title: string;
  description?: string;
  amount?: number;
  currency?: string;
  referenceId?: string;       // leadId, appointmentId, quoteId, etc.
  referenceModel?: string;    // 'Lead', 'Appointment', 'Quote', etc.
  metadata?: Record<string, any>;
  occurredAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ICustomerConversation {
  _id?: mongoose.Types.ObjectId;
  channel: 'email' | 'sms' | 'phone' | 'in-person' | 'chat' | 'other';
  direction: 'inbound' | 'outbound';
  senderType: 'customer' | 'agent' | 'system';
  senderName?: string;
  content: string;
  subject?: string;
  referenceId?: string;       // leadId or threadId
  referenceModel?: string;
  metadata?: Record<string, any>;
  sentAt: Date;
  createdAt?: Date;
}

export interface ICustomer extends Document {
  organizationId: string;
  createdBy: mongoose.Types.ObjectId;
  updatedBy?: mongoose.Types.ObjectId;

  // Identity
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  alternatePhone?: string;
  avatarInitials?: string;    // Derived, not stored (computed on read)

  // Demographics / extended profile
  dateOfBirth?: Date;
  address?: {
    street?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };
  notes?: string;
  tags?: string[];
  preferredContactMethod?: 'email' | 'phone' | 'sms';

  // Source tracking
  source: 'lead' | 'manual' | 'import' | 'booking';
  sourceLeadId?: mongoose.Types.ObjectId;  // Original lead that created this customer
  isActive: boolean;

  // Vehicle interest (from leads / dealership context)
  vehicleInterest?: {
    year?: string;
    make?: string;
    model?: string;
    trim?: string;
    vin?: string;
    budget?: string;
    condition?: 'new' | 'used' | 'certified';
  };

  // Embedded collections (kept small; heavy history = separate docs)
  transactions: ICustomerTransaction[];
  conversations: ICustomerConversation[];

  // Aggregates (kept in sync by service layer)
  stats: {
    totalTransactions: number;
    totalConversations: number;
    totalAppointments: number;
    lastContactedAt?: Date;
    firstContactedAt?: Date;
    lifetimeValue?: number;
  };

  createdAt: Date;
  updatedAt: Date;
}

// ─── Sub-schemas ─────────────────────────────────────────────────────────────

const TransactionSchema = new Schema<ICustomerTransaction>(
  {
    type: {
      type: String,
      enum: ['lead', 'appointment', 'purchase', 'quote', 'inquiry', 'other'],
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'active', 'completed', 'cancelled', 'failed'],
      default: 'pending',
    },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    amount: { type: Number },
    currency: { type: String, default: 'USD' },
    referenceId: { type: String },
    referenceModel: { type: String },
    metadata: { type: Schema.Types.Mixed },
    occurredAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const ConversationSchema = new Schema<ICustomerConversation>(
  {
    channel: {
      type: String,
      enum: ['email', 'sms', 'phone', 'in-person', 'chat', 'other'],
      required: true,
    },
    direction: { type: String, enum: ['inbound', 'outbound'], required: true },
    senderType: {
      type: String,
      enum: ['customer', 'agent', 'system'],
      required: true,
    },
    senderName: { type: String, trim: true },
    content: { type: String, required: true },
    subject: { type: String, trim: true },
    referenceId: { type: String },
    referenceModel: { type: String },
    metadata: { type: Schema.Types.Mixed },
    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// ─── Main Schema ──────────────────────────────────────────────────────────────

const CustomerSchema = new Schema<ICustomer>(
  {
    organizationId: { type: String, required: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },

    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    phone: { type: String, required: true, trim: true, index: true },
    alternatePhone: { type: String, trim: true },

    dateOfBirth: { type: Date },
    address: {
      street: String,
      city: String,
      state: String,
      postalCode: String,
      country: String,
    },
    notes: { type: String, trim: true },
    tags: [{ type: String, trim: true }],
    preferredContactMethod: {
      type: String,
      enum: ['email', 'phone', 'sms'],
      default: 'email',
    },

    source: {
      type: String,
      enum: ['lead', 'manual', 'import', 'booking'],
      default: 'manual',
    },
    sourceLeadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
    isActive: { type: Boolean, default: true, index: true },

    vehicleInterest: {
      year: String,
      make: String,
      model: String,
      trim: String,
      vin: String,
      budget: String,
      condition: { type: String, enum: ['new', 'used', 'certified'] },
    },

    transactions: [TransactionSchema],
    conversations: [ConversationSchema],

    stats: {
      totalTransactions: { type: Number, default: 0 },
      totalConversations: { type: Number, default: 0 },
      totalAppointments: { type: Number, default: 0 },
      lastContactedAt: { type: Date },
      firstContactedAt: { type: Date },
      lifetimeValue: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

// ─── Indexes ──────────────────────────────────────────────────────────────────

// Unique per org — no two customers with same email in the same org
CustomerSchema.index({ organizationId: 1, email: 1 }, { unique: true });
CustomerSchema.index({ organizationId: 1, phone: 1 });
CustomerSchema.index({ organizationId: 1, createdAt: -1 });
CustomerSchema.index({ organizationId: 1, isActive: 1, createdAt: -1 });
CustomerSchema.index({ sourceLeadId: 1 }, { sparse: true });
CustomerSchema.index(
  { organizationId: 1, firstName: 'text', lastName: 'text', email: 'text' },
  { name: 'customer_text_search' }
);

// ─── Virtual: full name ───────────────────────────────────────────────────────

CustomerSchema.virtual('fullName').get(function (this: ICustomer) {
  return `${this.firstName} ${this.lastName}`.trim();
});

CustomerSchema.set('toJSON', { virtuals: true });
CustomerSchema.set('toObject', { virtuals: true });

export default mongoose.model<ICustomer>('Customer', CustomerSchema);