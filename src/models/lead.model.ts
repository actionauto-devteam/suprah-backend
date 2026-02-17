// Mongoose model for Leads (Inquiries)
import mongoose, { Schema, Document } from 'mongoose';

export interface ILead extends Document {
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
  messageId: { type: String, unique: true, sparse: true },
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

export default mongoose.model<ILead>('Lead', LeadSchema);