// Mongoose model for Leads (Inquiries)
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
  threadId?: string;
  messageId?: string;
  isRead?: boolean;
  isPending?: boolean;
  labels?: string[];
  
  // Lead Information
  source: string;
  status: 'New' | 'Contacted' | 'Pending' | 'Appointment Set' | 'Closed';
  vehicle: {
    year: string;
    make: string;
    model: string;
  };
  comments: string;
  
  createdAt: Date;
  updatedAt: Date;
}

const LeadSchema: Schema = new Schema({
  // Organization & User - CRITICAL for data isolation
  // COMMENTED: organization field for future organization-wide sharing feature
  // organization: {
  //   type: mongoose.Schema.Types.ObjectId,
  //   ref: 'Organization',
  //   required: true,
  //   index: true
  // },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true  // Index for efficient per-user queries
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
  threadId: { type: String },
  messageId: { type: String, sparse: true },
  isRead: { type: Boolean, default: false },
  isPending: { type: Boolean, default: false },
  labels: [{ type: String }],
  
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
    model: String
  },
  comments: String
}, { timestamps: true });

// Index for efficient per-user queries
LeadSchema.index({ createdBy: 1, createdAt: -1 });
// COMMENTED: Index for future organization-wide sharing
// LeadSchema.index({ organization: 1, createdAt: -1 });

export default mongoose.model<ILead>('Lead', LeadSchema);