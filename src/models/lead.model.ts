// Mongoose model for Leads (Inquiries)
import mongoose, { Schema, Document } from 'mongoose';

export interface ILead extends Document {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  source: string;
  status: string;
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
  firstName: { type: String, default: 'Unknown' },
  lastName: { type: String, default: '' },
  email: { type: String },
  phone: { type: String },
  source: { type: String, default: 'ADF Email' },
  status: { type: String, default: 'New' }, // New, Contacted, Appointment Set, Closed
  vehicle: {
    year: String,
    make: String,
    model: String
  },
  comments: String
}, { timestamps: true });

export default mongoose.model<ILead>('Lead', LeadSchema);