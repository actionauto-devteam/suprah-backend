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

// NEW: Customer booking information
export interface ICustomerBooking {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  isCustomerBooking: boolean;
  bookingHistory?: {
    previousBookings: mongoose.Types.ObjectId[];
    totalBookings: number;
    lastBookedAt?: Date;
  };
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
  organizationId: string;

  // Participants
  createdBy: mongoose.Types.ObjectId;
  participants: mongoose.Types.ObjectId[];

  // External guests
  guestEmails: IGuestResponse[];

  // NEW: Customer booking
  customerBooking?: ICustomerBooking;

  // Related entities
  conversationId?: mongoose.Types.ObjectId;
  vehicleId?: mongoose.Types.ObjectId;
  quoteId?: mongoose.Types.ObjectId;
  shipmentId?: mongoose.Types.ObjectId;

  // Reminders
  reminderSent: boolean;
  reminderTime?: Date;

  // Google Calendar integration
  googleCalendarEventId?: string;
  meetingLink?: string;
  syncedWithGoogleCalendar: boolean;
  lastSyncedAt?: Date;

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

// NEW: Customer booking schema
const CustomerBookingSchema = new Schema({
  firstName: { type: String, required: true, trim: true },
  lastName: { type: String, required: true, trim: true },
  email: { type: String, required: true, lowercase: true, trim: true },
  phone: { type: String, required: true, trim: true },
  isCustomerBooking: { type: Boolean, default: true },
  bookingHistory: {
    previousBookings: [{ type: Schema.Types.ObjectId, ref: 'Appointment' }],
    totalBookings: { type: Number, default: 0 },
    lastBookedAt: Date
  }
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
    organizationId: {
      type: String,
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

    // NEW: Customer booking
    customerBooking: CustomerBookingSchema,

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
    syncedWithGoogleCalendar: { type: Boolean, default: false },
    lastSyncedAt: Date,

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
// NEW: Customer booking indexes
AppointmentSchema.index({ 'customerBooking.email': 1 });
AppointmentSchema.index({ 'customerBooking.phone': 1 });
AppointmentSchema.index({ 'customerBooking.firstName': 1, 'customerBooking.lastName': 1 });
AppointmentSchema.index({ 'customerBooking.isCustomerBooking': 1, startTime: -1 });

const Appointment = mongoose.model<IAppointment>('Appointment', AppointmentSchema);

export default Appointment;