// Mongoose model for Leads (Inquiries)
// Updated: Centralized ingestion via actionautoutah.dev@gmail.com
// Added: channel detection (sms/email/adf/phone/web), parsedContent for clean ADF display
import mongoose, { Schema, Document } from 'mongoose';

export interface ILead extends Document {
  // Organization & User
  organizationId: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;  // User ID who synced/created the lead

  // Contact Information
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  senderEmail?: string;
  senderName?: string;

  // Email Fields
  subject?: string;
  body?: string;
  /** Clean, human-readable content (ADF parsed or cleaned email body) */
  parsedContent?: string;
  threadId?: string;
  messageId?: string;
  isRead?: boolean;
  isPending?: boolean;
  labels?: string[];

  // Communication Channel
  /** Detected communication channel: email, sms, adf, phone, web */
  channel: 'email' | 'sms' | 'adf' | 'phone' | 'web';

  // Lead Information
  source: string;
  status: 'New' | 'Contacted' | 'Pending' | 'Appointment Set' | 'Closed';
  vehicle: {
    year: string;
    make: string;
    model: string;
    vin?: string;
    stock?: string;
    trim?: string;
    condition?: string;
    odometer?: string;
    price?: string;
  };
  appointment?: {
    date: Date;
    time: string;
    notes?: string;
    location?: string;
  };
  comments: string;

  followUp?: {
    lastCustomerActivityAt?: Date;
    lastRepResponseAt?: Date;
    lastReminderSentAt?: Date;
    reminderCount?: number;
    reminderHistory?: Array<{
      sentAt: Date;
      userId?: mongoose.Types.ObjectId;
      thresholdMinutes: number;
      notificationId?: mongoose.Types.ObjectId;
      note?: string;
    }>;
  };

  /** Whether this lead was ingested via the centralized account */
  centralIngestion?: boolean;

  /** Audit trail of every status change, including who made it and why */
  statusHistory?: Array<{
    from: string;
    to: string;
    changedAt: Date;
    changedBy?: mongoose.Types.ObjectId;
    reason?: string;
  }>;

  createdAt: Date;
  updatedAt: Date;
}

const LeadSchema: Schema = new Schema({
  // Organization & User - CRITICAL for data isolation
  organizationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Organization',
    required: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  // Contact Information
  firstName: { type: String, default: 'Unknown' },
  lastName: { type: String, default: '' },
  email: { type: String },
  phone: { type: String },
  senderEmail: { type: String },
  senderName: { type: String },

  // Email Fields
  subject: { type: String },
  body: { type: String },
  parsedContent: { type: String },
  threadId: { type: String },
  messageId: { type: String, sparse: true },
  isRead: { type: Boolean, default: false },
  isPending: { type: Boolean, default: false },
  labels: [{ type: String }],

  // Communication Channel
  channel: {
    type: String,
    enum: ['email', 'sms', 'adf', 'phone', 'web'],
    default: 'email',
    index: true
  },

  // Lead Information
  source: { type: String, default: 'Email' },
  status: {
    type: String,
    enum: ['New', 'Contacted', 'Pending', 'Appointment Set', 'Closed'],
    default: 'New'
  },
  vehicle: {
    year: String,
    make: String,
    model: String,
    vin: String,
    stock: String,
    trim: String,
    condition: String,
    odometer: String,
    price: String,
  },
  appointment: {
    date: Date,
    time: String,
    notes: String,
    location: String
  },
  comments: String,

  followUp: {
    lastCustomerActivityAt: { type: Date, default: Date.now, index: true },
    lastRepResponseAt: { type: Date, default: null },
    lastReminderSentAt: { type: Date, default: null, index: true },
    reminderCount: { type: Number, default: 0 },
    reminderHistory: [{
      sentAt: { type: Date, default: Date.now },
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      thresholdMinutes: Number,
      notificationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Notification' },
      note: String,
    }],
  },

  centralIngestion: { type: Boolean, default: false },

  statusHistory: [{
    from: String,
    to: String,
    changedAt: { type: Date, default: Date.now },
    changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reason: String,
  }],
}, { timestamps: true });

// Index for efficient per-organization queries (used for pagination)
LeadSchema.index({ organizationId: 1, createdAt: -1 });

// Index for efficient per-user queries
LeadSchema.index({ createdBy: 1, createdAt: -1 });
// Index for channel-based filtering
LeadSchema.index({ createdBy: 1, channel: 1, createdAt: -1 });
// Index for unanswered inquiry reminder scans
LeadSchema.index({ organizationId: 1, status: 1, 'followUp.lastCustomerActivityAt': 1 });

export default mongoose.model<ILead>('Lead', LeadSchema);
