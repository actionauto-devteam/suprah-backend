import mongoose, { Document, Schema } from 'mongoose';

export type EntryType = 'event' | 'task' | 'reminder' | 'appointment';

export interface IGuestResponse {
  email: string;
  status: 'pending' | 'accepted' | 'declined';
  respondedAt?: Date;
  googleCalendarEventId?: string;
  guestName?: string;
  guestPhone?: string;
}

export interface IAppointment extends Document {
  title: string;
  description?: string;
  startTime: Date;
  endTime: Date;
  location?: string;
  type: 'in-person' | 'phone' | 'video' | 'other';
  status: 'scheduled' | 'confirmed' | 'cancelled' | 'completed';
  
  entryType: EntryType;
  
  createdBy: mongoose.Types.ObjectId;
  participants: mongoose.Types.ObjectId[];
  
  guestEmails: IGuestResponse[];
  
  conversationId?: mongoose.Types.ObjectId;
  vehicleId?: mongoose.Types.ObjectId;
  quoteId?: mongoose.Types.ObjectId;
  shipmentId?: mongoose.Types.ObjectId;
  
  reminderSent: boolean;
  reminderTime?: Date;
  
  googleCalendarEventId?: string;
  meetingLink?: string;
  
  notes?: string;
  
  createdAt: Date;
  updatedAt: Date;
}

const GuestResponseSchema = new Schema({
  email: { type: String, required: true },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'declined'],
    default: 'pending'
  },
  respondedAt: Date,
  googleCalendarEventId: String,
  guestName: String,
  guestPhone: String
}, { _id: false });

const AppointmentSchema: Schema<IAppointment> = new Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    startTime: { type: Date, required: true, index: true },
    endTime: { type: Date, required: true },
    location: { type: String, trim: true },
    type: {
      type: String,
      enum: ['in-person', 'phone', 'video', 'other'],
      default: 'in-person'
    },
    status: {
      type: String,
      enum: ['scheduled', 'confirmed', 'cancelled', 'completed'],
      default: 'scheduled',
      index: true
    },
    
    entryType: {
      type: String,
      enum: ['event', 'task', 'reminder', 'appointment'],
      default: 'appointment',
      required: true,
      index: true
    },
    
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    participants: [{
      type: Schema.Types.ObjectId,
      ref: 'User'
    }],
    
    guestEmails: [GuestResponseSchema],
    
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation'
    },
    vehicleId: {
      type: Schema.Types.ObjectId,
      ref: 'Vehicle'
    },
    quoteId: {
      type: Schema.Types.ObjectId,
      ref: 'Quote'
    },
    shipmentId: {
      type: Schema.Types.ObjectId,
      ref: 'Shipment'
    },
    
    reminderSent: { type: Boolean, default: false },
    reminderTime: { type: Date },
    
    googleCalendarEventId: String,
    meetingLink: String,
    
    notes: { type: String, trim: true }
  },
  {
    timestamps: true
  }
);

// Compound indexes
AppointmentSchema.index({ createdBy: 1, startTime: -1 });
AppointmentSchema.index({ participants: 1, startTime: -1 });
AppointmentSchema.index({ status: 1, startTime: 1 });
AppointmentSchema.index({ entryType: 1, startTime: 1 });
AppointmentSchema.index({ 'guestEmails.email': 1 });

const Appointment = mongoose.model<IAppointment>('Appointment', AppointmentSchema);

export default Appointment;