// Mongoose model for Leads (Inquiries)
// Updated: Centralized ingestion via actionautoutah.dev@gmail.com
// Added: channel detection (sms/email/adf/phone/web), parsedContent for clean ADF display
import mongoose, { Schema, Document } from 'mongoose';

export interface ILead extends Document {
  // Organization & User
  // COMMENTED: organization field for future organization-wide sharing feature
  // organization?: mongoose.Types.ObjectId;
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
  };
  appointment?: {
    date: Date;
    time: string;
    notes?: string;
    location?: string;
  };
  comments: string;
  
  /** Whether this lead was ingested via the centralized account */
  centralIngestion?: boolean;
  
  createdAt: Date;
  updatedAt: Date;
}

const LeadSchema: Schema = new Schema({
  // Organization & User - CRITICAL for data isolation
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
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
  },
  appointment: {
    date: Date,
    time: String,
    notes: String,
    location: String
  },
  comments: String,
  
  centralIngestion: { type: Boolean, default: false },
}, { timestamps: true });

// Index for efficient per-user queries
LeadSchema.index({ createdBy: 1, createdAt: -1 });
// Index for channel-based filtering
LeadSchema.index({ createdBy: 1, channel: 1, createdAt: -1 });

export default mongoose.model<ILead>('Lead', LeadSchema);