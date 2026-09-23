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
  type: string;
  customTypeDetails?: string;
  status: 'scheduled' | 'confirmed' | 'cancelled' | 'completed' | 'no-show';

  entryType: EntryType;
  organizationId: string;

  createdBy: mongoose.Types.ObjectId;
  createdByModel: 'User' | 'CrmUser';
  participants: mongoose.Types.ObjectId[];
  participantModel: 'User' | 'CrmUser';

  guestEmails: IGuestResponse[];
  customerBooking?: ICustomerBooking;

  leadId?: mongoose.Types.ObjectId;
  conversationId?: mongoose.Types.ObjectId;
  vehicleId?: mongoose.Types.ObjectId;
  vehicleIds?: mongoose.Types.ObjectId[];
  quoteId?: mongoose.Types.ObjectId;
  shipmentId?: mongoose.Types.ObjectId;

  reminderSent: boolean;
  reminderTime?: Date;
  reminderSentAt?: Date;
  noShowFollowUpSentAt?: Date;
  noShowFollowUpStatus?: 'processing' | 'sent' | 'failed' | 'skipped';
  noShowFollowUpAttemptCount?: number;
  noShowFollowUpLastAttemptAt?: Date;
  noShowFollowUpNextRetryAt?: Date;
  noShowFollowUpFailureReason?: string;
  reviewRequestSentAt?: Date;
  reviewRequestStatus?: 'processing' | 'sent' | 'failed' | 'skipped';
  reviewRequestAttemptCount?: number;
  reviewRequestLastAttemptAt?: Date;
  reviewRequestNextRetryAt?: Date;
  reviewRequestFailureReason?: string;
  reviewRequestEmailSentAt?: Date;
  reviewRequestEmailStatus?: 'processing' | 'sent' | 'failed' | 'skipped';
  reviewRequestEmailAttemptCount?: number;
  reviewRequestEmailLastAttemptAt?: Date;
  reviewRequestEmailNextRetryAt?: Date;
  reviewRequestEmailFailureReason?: string;
  statusHistory?: Array<{
    from: string;
    to: string;
    changedAt: Date;
    changedBy?: string;
    actorName?: string;
  }>;

  googleCalendarEventId?: string;
  meetingLink?: string;
  syncedWithGoogleCalendar: boolean;
  lastSyncedAt?: Date;

  notes?: string;
  outcomeNotes?: string;
  transparency?: 'opaque' | 'transparent';

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
      default: 'in-person'
    },
    customTypeDetails: { type: String, trim: true },
    status: {
      type: String,
      enum: ['scheduled', 'confirmed', 'cancelled', 'completed', 'no-show'],
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
      refPath: 'createdByModel',
      required: true,
      index: true
    },
    createdByModel: {
      type: String,
      required: true,
      enum: ['User', 'CrmUser'],
      default: 'User'
    },
    participants: [{
      type: Schema.Types.ObjectId,
      refPath: 'participantModel'
    }],
    participantModel: {
      type: String,
      required: true,
      enum: ['User', 'CrmUser'],
      default: 'User'
    },
    guestEmails: [GuestResponseSchema],
    customerBooking: CustomerBookingSchema,
    leadId: {
      type: Schema.Types.ObjectId,
      ref: 'Lead',
      index: true
    },
    conversationId: {
      type: Schema.Types.ObjectId,
      ref: 'Conversation'
    },
    vehicleId: {
      type: Schema.Types.ObjectId,
      ref: 'Vehicle'
    },
    vehicleIds: [{
      type: Schema.Types.ObjectId,
      ref: 'Vehicle'
    }],
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
    reminderSentAt: { type: Date },
    noShowFollowUpSentAt: { type: Date },
    noShowFollowUpStatus: {
      type: String,
      enum: ['processing', 'sent', 'failed', 'skipped']
    },
    noShowFollowUpAttemptCount: { type: Number, default: 0 },
    noShowFollowUpLastAttemptAt: { type: Date },
    noShowFollowUpNextRetryAt: { type: Date },
    noShowFollowUpFailureReason: { type: String, trim: true, maxlength: 500 },
    reviewRequestSentAt: { type: Date },
    reviewRequestStatus: {
      type: String,
      enum: ['processing', 'sent', 'failed', 'skipped']
    },
    reviewRequestAttemptCount: { type: Number, default: 0 },
    reviewRequestLastAttemptAt: { type: Date },
    reviewRequestNextRetryAt: { type: Date },
    reviewRequestFailureReason: { type: String, trim: true, maxlength: 500 },
    reviewRequestEmailSentAt: { type: Date },
    reviewRequestEmailStatus: {
      type: String,
      enum: ['processing', 'sent', 'failed', 'skipped']
    },
    reviewRequestEmailAttemptCount: { type: Number, default: 0 },
    reviewRequestEmailLastAttemptAt: { type: Date },
    reviewRequestEmailNextRetryAt: { type: Date },
    reviewRequestEmailFailureReason: { type: String, trim: true, maxlength: 500 },
    statusHistory: [{
      from: { type: String, required: true },
      to: { type: String, required: true },
      changedAt: { type: Date, default: Date.now },
      changedBy: { type: String },
      actorName: { type: String, trim: true }
    }],
    googleCalendarEventId: String,
    meetingLink: String,
    syncedWithGoogleCalendar: { type: Boolean, default: false },
    lastSyncedAt: Date,
    notes: { type: String, trim: true },
    outcomeNotes: { type: String, trim: true },
    transparency: { type: String, enum: ['opaque', 'transparent'], default: 'opaque' }
  },
  {
    timestamps: true
  }
);

AppointmentSchema.index({ createdBy: 1, startTime: -1 });
AppointmentSchema.index({ participants: 1, startTime: -1 });
AppointmentSchema.index({ status: 1, startTime: 1 });
AppointmentSchema.index({ entryType: 1, startTime: 1 });
AppointmentSchema.index({ 'guestEmails.email': 1 });
AppointmentSchema.index({ 'customerBooking.email': 1 });
AppointmentSchema.index({ 'customerBooking.phone': 1 });
AppointmentSchema.index({ 'customerBooking.firstName': 1, 'customerBooking.lastName': 1 });
AppointmentSchema.index({ 'customerBooking.isCustomerBooking': 1, startTime: -1 });

const Appointment = mongoose.model<IAppointment>('Appointment', AppointmentSchema);

export default Appointment;
